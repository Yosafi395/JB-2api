const { loadConfig } = require('./config');
const { fetchViaWorker } = require('./proxy-pool');

const JB_API_BASE = 'https://api.jetbrains.ai';
const JB_OAUTH_BASE = 'https://oauth.account.jetbrains.com';

// 内部：根据可选的 workerUrl 决定走直连还是 Worker 转发
async function _httpJson(url, init, workerUrl) {
  if (!workerUrl) {
    const r = await fetch(url, init);
    return { status: r.status, ok: r.ok, text: () => r.text(), json: () => r.json() };
  }
  return fetchViaWorker(workerUrl, url, init);
}

async function refreshIdToken(refreshToken, workerUrl) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: 'ide',
  }).toString();
  const res = await _httpJson(`${JB_OAUTH_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  }, workerUrl);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`refreshIdToken failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function registerGrazie(idToken) {
  const res = await fetch(`${JB_API_BASE}/auth/jetbrains-jwt/register`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${idToken}`,
      'User-Agent': 'ktor-client',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`registerGrazie failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function provideAccess(idToken, licenseId, workerUrl) {
  const res = await _httpJson(`${JB_API_BASE}/auth/jetbrains-jwt/provide-access/license/v2`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${idToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ktor-client',
    },
    body: JSON.stringify({ licenseId }),
  }, workerUrl);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`provideAccess failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function getUserInfo(idToken) {
  const res = await fetch(`${JB_API_BASE}/auth/jetbrains-jwt/user-info`, {
    headers: {
      'Authorization': `Bearer ${idToken}`,
      'User-Agent': 'ktor-client',
    },
  });
  return { ok: res.ok, status: res.status, data: res.ok ? await res.json() : null };
}

async function getProfiles(jwt) {
  const res = await fetch(`${JB_API_BASE}/user/v5/llm/profiles/v8`, {
    headers: {
      'grazie-authenticate-jwt': jwt,
      'User-Agent': 'ktor-client',
    },
  });
  if (!res.ok) throw new Error(`getProfiles failed (${res.status})`);
  return res.json();
}

async function getQuota(jwt, workerUrl) {
  const res = await _httpJson(`${JB_API_BASE}/user/v5/quota/get`, {
    method: 'POST',
    headers: {
      'grazie-authenticate-jwt': jwt,
      'Content-Type': 'application/json',
      'User-Agent': 'ktor-client',
    },
    body: '{}',
  }, workerUrl);
  if (!res.ok) throw new Error(`getQuota failed (${res.status})`);
  return res.json();
}

function chatStream(jwt, body) {
  const config = loadConfig();
  // Abort after 5 minutes of no response (covers connect + first-byte + thinking time)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000);
  return fetch(`${JB_API_BASE}/user/v5/llm/chat/stream/v8`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'Accept-Charset': 'UTF-8',
      'Cache-Control': 'no-cache',
      'grazie-authenticate-jwt': jwt,
      'grazie-agent': JSON.stringify(config.grazie_agent),
      'User-Agent': 'ktor-client',
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));
}

function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT');
  const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
  return JSON.parse(payload);
}

module.exports = {
  refreshIdToken, registerGrazie, provideAccess, getUserInfo,
  getProfiles, getQuota, chatStream, decodeJwtPayload,
  JB_API_BASE, JB_OAUTH_BASE,
};
