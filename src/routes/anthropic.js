const express = require('express');
const { convertRequest } = require('../converter/anthropic-to-jb');
const { convertStreamToAnthropic } = require('../converter/jb-to-anthropic');
const accountManager = require('../account-manager');
const jb = require('../jb-client');
const modelsCache = require('../models-cache');

const router = express.Router();

router.post('/v1/messages', async (req, res) => {
  const resolved = modelsCache.resolveModel(req.body.model);
  const MAX_RETRIES = 3;
  const excludeIds = [];

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const account = accountManager.getNext(excludeIds);
      if (!account) {
        return res.status(503).json({
          type: 'error',
          error: { type: 'overloaded_error', message: 'No active accounts' },
        });
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

        return res.status(jbRes.status).json({
          type: 'error',
          error: { type: 'api_error', message: errText },
        });
      }

      const isStream = req.body.stream !== false;
      // 计算 prompt 总字符数用于 usage token 估算
      const systemText = typeof req.body.system === 'string' ? req.body.system : '';
      const promptCharCount = systemText.length + (req.body.messages || []).reduce((sum, m) => {
        const c = m.content;
        if (typeof c === 'string') return sum + c.length;
        if (Array.isArray(c)) return sum + c.reduce((s, p) => s + (p.text || '').length, 0);
        return sum;
      }, 0);
      // 用原始 model 名作为响应里的 model（客户端看到自己请求的）
      await convertStreamToAnthropic(jbRes.body, res, req.body.model, isStream, {
        promptCharCount,
      });
      return;
    } catch (err) {
      console.error('POST /v1/messages error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({
          type: 'error',
          error: { type: 'api_error', message: err.message },
        });
      }
      return;
    }
  }

  if (!res.headersSent) {
    res.status(429).json({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'All accounts quota exhausted' },
    });
  }
});

module.exports = router;
