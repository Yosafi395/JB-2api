const { v4: uuidv4 } = require('uuid');

/**
 * Parse JB SSE stream and convert to Anthropic SSE format or buffered JSON.
 * options:
 *   promptCharCount: prompt 总字符数（用于估算 input_tokens）
 */
async function convertStreamToAnthropic(jbStream, res, model, stream = true, options = {}) {
  const msgId = `msg_${uuidv4().replace(/-/g, '').slice(0, 20)}`;
  const promptCharCount = options.promptCharCount || 0;
  const inputTokens = Math.ceil(promptCharCount / 4);
  let outputChars = 0;
  let receivedFinish = false;

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    res.write(`event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: msgId, type: 'message', role: 'assistant', content: [],
        model, stop_reason: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    })}\n\n`);
  }

  let contentBlockIndex = 0;
  let textBlockStarted = false;
  const activeToolCalls = new Map();
  const buffer = { content: [], stop_reason: null };

  const decoder = new TextDecoder();
  let leftover = '';

  try {
    for await (const chunk of jbStream) {
      const text = leftover + decoder.decode(chunk, { stream: true });
      const lines = text.split('\n');
      leftover = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === 'end' || dataStr === '') continue;

        let event;
        try { event = JSON.parse(dataStr); } catch { continue; }

        if (event.type === 'Content') {
          outputChars += (event.content || '').length;
          if (stream) {
            if (!textBlockStarted) {
              res.write(`event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start', index: contentBlockIndex,
                content_block: { type: 'text', text: '' },
              })}\n\n`);
              textBlockStarted = true;
            }
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta', index: contentBlockIndex,
              delta: { type: 'text_delta', text: event.content || '' },
            })}\n\n`);
          } else {
            if (buffer.content.length === 0 || buffer.content[buffer.content.length - 1].type !== 'text') {
              buffer.content.push({ type: 'text', text: '' });
            }
            buffer.content[buffer.content.length - 1].text += event.content || '';
          }
        } else if (event.type === 'ToolCall') {
          const pIdx = event.parallelToolIndex || 0;

          if (event.id && event.name) {
            if (stream && textBlockStarted) {
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                type: 'content_block_stop', index: contentBlockIndex,
              })}\n\n`);
              contentBlockIndex++;
              textBlockStarted = false;
            }

            activeToolCalls.set(pIdx, {
              id: event.id, name: event.name, input: '',
              blockIndex: stream ? contentBlockIndex : 0,
            });

            if (stream) {
              res.write(`event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start', index: contentBlockIndex,
                content_block: { type: 'tool_use', id: event.id, name: event.name, input: {} },
              })}\n\n`);
              contentBlockIndex++;
            }
          } else if (event.content) {
            const tc = activeToolCalls.get(pIdx);
            if (tc) {
              tc.input += event.content;
              outputChars += (event.content || '').length;
              if (stream) {
                res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                  type: 'content_block_delta', index: tc.blockIndex,
                  delta: { type: 'input_json_delta', partial_json: event.content },
                })}\n\n`);
              }
            }
          }
        } else if (event.type === 'FinishMetadata') {
          receivedFinish = true;
          // Map JB finish reasons to Anthropic:
          //   tool_call → tool_use
          //   length    → max_tokens (output was truncated)
          //   stop      → end_turn
          const stopReason = event.reason === 'tool_call' ? 'tool_use'
            : event.reason === 'length' ? 'max_tokens'
            : 'end_turn';
          if (stopReason === 'max_tokens') {
            console.warn(`[WARN] Response truncated (stop_reason=max_tokens). Model=${model}. Consider increasing max_tokens.`);
          }
          const outputTokens = Math.ceil(outputChars / 4);

          if (stream) {
            if (textBlockStarted) {
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                type: 'content_block_stop', index: contentBlockIndex,
              })}\n\n`);
            }
            for (const [, tc] of activeToolCalls) {
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                type: 'content_block_stop', index: tc.blockIndex,
              })}\n\n`);
            }
            res.write(`event: message_delta\ndata: ${JSON.stringify({
              type: 'message_delta',
              delta: { stop_reason: stopReason },
              usage: { output_tokens: outputTokens },
            })}\n\n`);
          } else {
            buffer.stop_reason = stopReason;
            for (const [, tc] of activeToolCalls) {
              let input = {};
              try { input = JSON.parse(tc.input); } catch {}
              buffer.content.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
            }
          }
        }
      }
    }
  } catch (streamErr) {
    // Stream was terminated mid-flight (e.g. network reset, upstream close, AbortError).
    // Log and fall through to the !receivedFinish handler below.
    console.error(`[ERROR] Anthropic stream read error: ${streamErr.message}. Model=${model}.`);
  }

  // Detect stream interruption: no FinishMetadata received
  if (!receivedFinish) {
    console.error(`[ERROR] Anthropic stream ended without FinishMetadata. Model=${model}. Response may be incomplete.`);
    if (stream) {
      if (textBlockStarted) {
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({
          type: 'content_block_stop', index: contentBlockIndex,
        })}\n\n`);
      }
      res.write(`event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'max_tokens' },
        usage: { output_tokens: Math.ceil(outputChars / 4) },
      })}\n\n`);
    } else {
      buffer.stop_reason = 'max_tokens';
    }
  }

  if (stream) {
    res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    res.end();
  } else {
    const outputTokens = Math.ceil(outputChars / 4);
    res.json({
      id: msgId, type: 'message', role: 'assistant',
      content: buffer.content, model,
      stop_reason: buffer.stop_reason || 'end_turn',
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    });
  }
}

module.exports = { convertStreamToAnthropic };
