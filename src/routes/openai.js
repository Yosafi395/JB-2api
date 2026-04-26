const express = require('express');
const { convertRequest } = require('../converter/openai-to-jb');
const { convertStreamToOpenAI } = require('../converter/jb-to-openai');
const accountManager = require('../account-manager');
const jb = require('../jb-client');
const modelsCache = require('../models-cache');

const router = express.Router();

// /v1/models — 从本地缓存读取，永不阻塞 Cursor 启动
router.get('/v1/models', (req, res) => {
  try {
    const data = modelsCache.listForOpenAI();
    res.json({ object: 'list', data });
  } catch (err) {
    console.error('GET /v1/models error:', err.message);
    res.status(500).json({ error: { message: err.message, type: 'server_error' } });
  }
});

router.post('/v1/chat/completions', async (req, res) => {
  // 解析模型后缀，决定走原生 reasoning-effort / 原生 thinking-budget / prompt 注入 / 不动
  const resolved = modelsCache.resolveModel(req.body.model);

  // ── 调试日志：按模型简介 ──
  const _dbgMsgs = (req.body.messages || []).map((m, i) => {
    const c = m.content;
    let preview;
    if (c === null || c === undefined) preview = '(null)';
    else if (typeof c === 'string') preview = c.length > 80 ? c.slice(0, 80) + '...' : c;
    else if (Array.isArray(c)) preview = `[${c.length} blocks]`;
    else preview = JSON.stringify(c).slice(0, 80);
    return `  [${i}] ${m.role}: ${preview}`;
  });
  console.log(`\n[DEBUG /v1/chat/completions] model=${req.body.model} -> profile=${resolved.profile} mode=${resolved.mode}${resolved.level ? '/' + resolved.level : ''} stream=${req.body.stream} messages=${(req.body.messages||[]).length}\n${_dbgMsgs.join('\n')}`);

  const MAX_RETRIES = 3;
  const excludeIds = [];

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const account = accountManager.getNext(excludeIds);
      if (!account) {
        return res.status(503).json({ error: { message: 'No active accounts', type: 'server_error' } });
      }

      const jwt = await accountManager.ensureValidJwt(account);
      const jbBody = convertRequest(req.body, resolved);
      const jbRes = await jb.chatStream(jwt, jbBody);

      if (!jbRes.ok) {
        const errText = await jbRes.text();

        if (jbRes.status === 477) {
          const switched = await accountManager.markQuotaExhausted(account);
          if (!switched) excludeIds.push(account.id);
          console.log(`[477] ${account.email}: ${switched ? 'switched license' : 'exhausted'}, retry ${attempt + 1}/${MAX_RETRIES}`);
          continue;
        }

        const status = jbRes.status;
        return res.status(status).json({ error: { message: errText, type: 'api_error' } });
      }

      const isStream = req.body.stream !== false;
      // 计算 prompt 总字符数用于 usage token 估算
      const promptCharCount = (req.body.messages || []).reduce((sum, m) => {
        const c = m.content;
        if (typeof c === 'string') return sum + c.length;
        if (Array.isArray(c)) return sum + c.reduce((s, p) => s + (p.text || '').length, 0);
        return sum;
      }, 0);
      // 把 prompt 注入模式下的 thinking 拆分标记传给流转换器
      // 原始 model 名作为响应里的 model 字段（保持 Cursor 看到选了什么就回什么）
      await convertStreamToOpenAI(jbRes.body, res, req.body.model, isStream, {
        promptInject: resolved.mode === 'prompt_inject',
        promptCharCount,
      });
      return;
    } catch (err) {
      console.error('POST /v1/chat/completions error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: { message: err.message, type: 'server_error' } });
      }
      return;
    }
  }

  if (!res.headersSent) {
    res.status(429).json({ error: { message: 'All accounts quota exhausted', type: 'rate_limit_error' } });
  }
});

module.exports = router;
