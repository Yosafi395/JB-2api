const { v4: uuidv4 } = require('uuid');

/**
 * Estimate token count from text using a simple char/4 heuristic.
 * Not exact, but much better than always returning 0.
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Parse JB SSE stream and convert to OpenAI SSE format or buffered JSON.
 * options:
 *   promptInject: true 时启用 <thinking>...</thinking> 标签解析，把标签内文本输出到 delta.reasoning_content
 *   promptCharCount: prompt 总字符数（用于估算 prompt_tokens）
 */
async function convertStreamToOpenAI(jbStream, res, model, stream = true, options = {}) {
  const id = `chatcmpl-${uuidv4().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const promptInject = !!options.promptInject;
  const promptCharCount = options.promptCharCount || 0;

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
  }

  const buffer = { content: '', reasoning: '', tool_calls: [], finish_reason: null };
  const activeToolCalls = new Map();
  // Track total completion chars for usage estimation
  let completionChars = 0;
  let receivedFinish = false;

  // <thinking> 流式状态机：
  //   inThinking = false → 默认全部 content
  //   inThinking = true  → 文本进 reasoning_content
  //   pending: 累积可能跨 chunk 的部分标签字符（如 "<th"）
  const thinkingState = { inThinking: false, pending: '' };

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
          const raw = event.content || '';
          completionChars += raw.length;
          if (promptInject) {
            // 流式拆分
            const parts = splitThinking(raw, thinkingState);
            for (const part of parts) {
              if (part.kind === 'thinking' && part.text) {
                if (stream) {
                  res.write(`data: ${JSON.stringify(makeChunk(id, created, model, { reasoning_content: part.text }))}\n\n`);
                } else {
                  buffer.reasoning += part.text;
                }
              } else if (part.kind === 'content' && part.text) {
                if (stream) {
                  res.write(`data: ${JSON.stringify(makeChunk(id, created, model, { content: part.text }))}\n\n`);
                } else {
                  buffer.content += part.text;
                }
              }
            }
          } else {
            if (stream) {
              res.write(`data: ${JSON.stringify(makeChunk(id, created, model, { content: raw }))}\n\n`);
            } else {
              buffer.content += raw;
            }
          }
        } else if (event.type === 'ToolCall') {
          const idx = event.parallelToolIndex || 0;
          if (event.id && event.name) {
            activeToolCalls.set(idx, { id: event.id, name: event.name, arguments: '' });
            if (stream) {
              res.write(`data: ${JSON.stringify(makeChunk(id, created, model, {
                tool_calls: [{ index: idx, id: event.id, type: 'function', function: { name: event.name, arguments: '' } }],
              }))}\n\n`);
            }
          } else if (event.content) {
            const tc = activeToolCalls.get(idx);
            if (tc) tc.arguments += event.content;
            completionChars += (event.content || '').length;
            if (stream) {
              res.write(`data: ${JSON.stringify(makeChunk(id, created, model, {
                tool_calls: [{ index: idx, function: { arguments: event.content } }],
              }))}\n\n`);
            }
          }
        } else if (event.type === 'FinishMetadata') {
          receivedFinish = true;
          // Map JB finish reasons to OpenAI:
          //   tool_call → tool_calls (model wants to call a tool)
          //   length    → length    (output truncated due to max_tokens)
          //   stop      → stop      (normal completion)
          const finishReason = event.reason === 'tool_call' ? 'tool_calls'
            : event.reason === 'length' ? 'length'
            : 'stop';
          if (finishReason === 'length') {
            console.warn(`[WARN] Response truncated (finish_reason=length). Model=${model}. Consider increasing max_tokens.`);
          }
          // 末尾把 pending 的残留文本作为 content 输出（避免吞最后一个标签前的几个字符）
          if (promptInject && thinkingState.pending) {
            const tail = thinkingState.pending;
            thinkingState.pending = '';
            if (tail) {
              completionChars += tail.length;
              if (stream) {
                const key = thinkingState.inThinking ? 'reasoning_content' : 'content';
                res.write(`data: ${JSON.stringify(makeChunk(id, created, model, { [key]: tail }))}\n\n`);
              } else {
                if (thinkingState.inThinking) buffer.reasoning += tail;
                else buffer.content += tail;
              }
            }
          }
          if (stream) {
            // Emit finish chunk
            res.write(`data: ${JSON.stringify(makeChunk(id, created, model, {}, finishReason))}\n\n`);
            // Emit a final usage chunk (OpenAI stream_options.include_usage compatible)
            const promptTokens = Math.ceil(promptCharCount / 4);
            const completionTokens = Math.ceil(completionChars / 4);
            const usageChunk = {
              id, object: 'chat.completion.chunk', created, model,
              choices: [],
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
              },
            };
            res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
          } else {
            buffer.finish_reason = finishReason;
            for (const [, tc] of activeToolCalls) {
              buffer.tool_calls.push({
                id: tc.id, type: 'function',
                function: { name: tc.name, arguments: tc.arguments },
              });
            }
          }
        }
      }
    }
  } catch (streamErr) {
    // Stream was terminated mid-flight (e.g. network reset, upstream close, AbortError).
    // Log and fall through to the !receivedFinish handler below.
    console.error(`[ERROR] OpenAI stream read error: ${streamErr.message}. Model=${model}.`);
  }

  // Detect stream interruption: if we never received FinishMetadata, the stream
  // was cut off (network error, upstream timeout, etc.). Signal an error to the client.
  if (!receivedFinish) {
    console.error(`[ERROR] Stream ended without FinishMetadata. Model=${model}. Response may be incomplete.`);
    if (stream) {
      // Send an error chunk so the client knows something went wrong
      const errChunk = {
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
      };
      res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
    } else {
      buffer.finish_reason = 'length';
    }
  }

  if (stream) {
    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    const promptTokens = Math.ceil(promptCharCount / 4);
    const completionTokens = Math.ceil(completionChars / 4);
    const message = { role: 'assistant', content: buffer.content || null };
    if (buffer.reasoning) message.reasoning_content = buffer.reasoning;
    const response = {
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message, finish_reason: buffer.finish_reason || 'stop' }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
    if (buffer.tool_calls.length > 0) {
      response.choices[0].message.tool_calls = buffer.tool_calls;
      if (!buffer.content) response.choices[0].message.content = null;
    }
    res.json(response);
  }
}

// 流式拆分 raw 文本为 [{kind:'thinking'|'content', text}] 数组
// 状态机维护 inThinking + pending（跨 chunk 标签）
function splitThinking(raw, state) {
  const parts = [];
  // 先把 pending 加到本 chunk 前（pending 是上一 chunk 末尾可能未闭合的标签前缀）
  let buf = state.pending + raw;
  state.pending = '';

  while (buf.length > 0) {
    if (state.inThinking) {
      const closeIdx = buf.indexOf('</thinking>');
      if (closeIdx === -1) {
        // 没找到关闭标签：末尾最多 11 个字符（"</thinking>"长度 11）可能是部分标签，留到 pending
        const safeLen = Math.max(0, buf.length - 11);
        if (safeLen > 0) parts.push({ kind: 'thinking', text: buf.slice(0, safeLen) });
        state.pending = buf.slice(safeLen);
        return parts;
      }
      // 找到关闭：thinking 部分输出
      if (closeIdx > 0) parts.push({ kind: 'thinking', text: buf.slice(0, closeIdx) });
      buf = buf.slice(closeIdx + '</thinking>'.length);
      state.inThinking = false;
    } else {
      const openIdx = buf.indexOf('<thinking>');
      if (openIdx === -1) {
        // 末尾最多 10 个字符（"<thinking>"长度 10）可能是部分 "<thinking>" 前缀，留到 pending
        const safeLen = Math.max(0, buf.length - 10);
        if (safeLen > 0) parts.push({ kind: 'content', text: buf.slice(0, safeLen) });
        state.pending = buf.slice(safeLen);
        return parts;
      }
      if (openIdx > 0) parts.push({ kind: 'content', text: buf.slice(0, openIdx) });
      buf = buf.slice(openIdx + '<thinking>'.length);
      state.inThinking = true;
    }
  }
  return parts;
}

function makeChunk(id, created, model, delta, finishReason = null) {
  return {
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

module.exports = { convertStreamToOpenAI, splitThinking };
