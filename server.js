'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { MessageStore } = require('./lib/store');
const { SessionManager } = require('./lib/sessions');
const { AccountStore } = require('./lib/accounts');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const LIMITS = {
  maxOnline: 20,
  maxAccounts: 50,
  maxMessages: 10000,
  retainDays: 30,
  initialLimit: 3,
  maxFetch: 100,
  maxContent: 2000,
  rateCount: 10,
  rateWindowMs: 10000,
};

const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
fs.mkdirSync(DATA_DIR, { recursive: true });

const store = new MessageStore(path.join(DATA_DIR, 'messages.json'), LIMITS);
store.load();
const accounts = new AccountStore(path.join(DATA_DIR, 'accounts.json'));
const sessions = new SessionManager({ maxOnline: LIMITS.maxOnline, ttlMs: 15000 });

const NAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_-]{2,16}$/;
const DEVICE_RE = /^[\u4e00-\u9fa5A-Za-z0-9_\- ]{1,20}$/;

const rateMap = new Map();
const recentClient = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function fail(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('BAD_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || '';
}

function cleanDeviceName(raw) {
  const value = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 20);
  return DEVICE_RE.test(value) ? value : 'Web';
}

function requireSession(req, res) {
  const raw = req.headers['x-session-id'];
  const session = raw ? sessions.touch(String(raw)) : null;
  if (!session) {
    fail(res, 401, 'SESSION_EXPIRED', '登录已过期，请重新登录');
    return null;
  }
  return session;
}

function rateLimited(deviceKey) {
  const now = Date.now();
  const hits = (rateMap.get(deviceKey) || []).filter((t) => now - t < LIMITS.rateWindowMs);
  hits.push(now);
  rateMap.set(deviceKey, hits);
  return hits.length > LIMITS.rateCount;
}

function rememberClientMsg(clientMsgId, message) {
  if (!clientMsgId) return;
  recentClient.set(clientMsgId, message);
  if (recentClient.size > 500) {
    recentClient.delete(recentClient.keys().next().value);
  }
}

function publicMe(session) {
  return {
    username: session.username,
    deviceName: session.deviceName,
    displayName: session.displayName,
    deviceKey: session.deviceKey,
  };
}

async function handleRegister(req, res) {
  const body = await readBody(req);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!NAME_RE.test(username)) {
    return fail(res, 400, 'INVALID_INPUT', '用户名需为 2-16 位，支持中文、字母、数字、下划线和短横线');
  }
  if (password.length < 6 || password.length > 32) {
    return fail(res, 400, 'INVALID_INPUT', '密码长度需为 6-32 位');
  }
  if (accounts.findByUsername(username)) {
    return fail(res, 409, 'USERNAME_TAKEN', '该用户名已被使用');
  }
  if (accounts.count() >= LIMITS.maxAccounts) {
    return fail(res, 400, 'ACCOUNT_LIMIT', `账号数量已达上限（${LIMITS.maxAccounts}）`);
  }
  accounts.create({ username, password });
  return sendJson(res, 200, { ok: true });
}

async function handleLogin(req, res) {
  const body = await readBody(req);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const deviceName = cleanDeviceName(body.deviceName);
  if (!username || !password) {
    return fail(res, 400, 'INVALID_INPUT', '请输入用户名和密码');
  }
  const account = accounts.verify(username, password);
  if (!account) {
    return fail(res, 401, 'INVALID_CREDENTIALS', '用户名或密码不正确');
  }
  const deviceKey = `${account.username}#${deviceName}`;
  const sameDevice = sessions.findByIdentity(deviceKey);
  if (!sameDevice && sessions.count() >= LIMITS.maxOnline) {
    return fail(res, 409, 'ROOM_FULL', `当前在线已满（${LIMITS.maxOnline}/${LIMITS.maxOnline}），请稍后再试`);
  }
  const session = sessions.create({ username: account.username, deviceName, ip: clientIp(req) });
  return sendJson(res, 200, {
    sessionId: session.sessionId,
    me: publicMe(session),
    online: sessions.count(),
    limits: LIMITS,
  });
}

async function handleLogout(req, res, url) {
  const fromHeader = req.headers['x-session-id'];
  const fromQuery = url ? url.searchParams.get('sid') : null;
  const sessionId = fromHeader || fromQuery;
  if (sessionId) sessions.destroy(String(sessionId));
  return sendJson(res, 200, { ok: true, online: sessions.count() });
}

async function handleAccountUpdate(req, res, session) {
  const body = await readBody(req);
  const currentPassword = String(body.currentPassword || '');
  const nextUsername = String(body.username || '').trim();
  const nextPassword = String(body.newPassword || '');

  const account = accounts.verify(session.username, currentPassword);
  if (!account) {
    return fail(res, 403, 'INVALID_CREDENTIALS', '当前密码不正确');
  }
  const renaming = nextUsername && nextUsername !== account.username;
  if (renaming && !NAME_RE.test(nextUsername)) {
    return fail(res, 400, 'INVALID_INPUT', '用户名需为 2-16 位，支持中文、字母、数字、下划线和短横线');
  }
  if (renaming && accounts.findByUsername(nextUsername)) {
    return fail(res, 409, 'USERNAME_TAKEN', '该用户名已被使用');
  }
  if (nextPassword && (nextPassword.length < 6 || nextPassword.length > 32)) {
    return fail(res, 400, 'INVALID_INPUT', '新密码长度需为 6-32 位');
  }
  if (!renaming && !nextPassword) {
    return fail(res, 400, 'INVALID_INPUT', '没有需要修改的内容');
  }

  accounts.update(account.username, {
    username: renaming ? nextUsername : null,
    password: nextPassword || null,
  });

  sessions.destroyByUsername(account.username);
  if (renaming) sessions.destroyByUsername(nextUsername);

  return sendJson(res, 200, { ok: true, relogin: true });
}

async function handleMessages(req, res, url, session) {
  if (req.method === 'GET') {
    const afterRaw = url.searchParams.get('afterId');
    const limitRaw = Number(url.searchParams.get('limit'));
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), LIMITS.maxFetch)
        : LIMITS.initialLimit;

    const payload =
      afterRaw === null || afterRaw === '' || !Number.isFinite(Number(afterRaw))
        ? store.latest(limit)
        : store.listAfter(Number(afterRaw), limit);

    return sendJson(res, 200, {
      messages: payload.messages,
      cursor: payload.cursor,
      reset: payload.reset,
      total: payload.total,
      online: sessions.count(),
      serverTime: Date.now(),
    });
  }

  const body = await readBody(req);
  const raw = typeof body.content === 'string' ? body.content : '';
  const content = raw.replace(/\r\n/g, '\n').trim();
  if (!content) {
    return fail(res, 400, 'INVALID_INPUT', '消息不能为空');
  }
  if (Array.from(content).length > LIMITS.maxContent) {
    return fail(res, 400, 'INVALID_INPUT', `单条消息最多 ${LIMITS.maxContent} 字`);
  }

  const clientMsgId = String(body.clientMsgId || '').slice(0, 64);
  if (clientMsgId && recentClient.has(clientMsgId)) {
    return sendJson(res, 200, {
      message: recentClient.get(clientMsgId),
      duplicate: true,
      online: sessions.count(),
    });
  }
  if (rateLimited(session.deviceKey)) {
    return fail(res, 429, 'RATE_LIMITED', '发送太频繁了，请稍后再试');
  }

  const message = store.add({
    deviceKey: session.deviceKey,
    username: session.username,
    deviceName: session.deviceName,
    displayName: session.displayName,
    content,
    clientMsgId,
  });
  rememberClientMsg(clientMsgId, message);

  return sendJson(res, 200, { message, online: sessions.count() });
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  switch (route) {
    case 'POST /api/register':
      if (accounts.count() >= LIMITS.maxAccounts) {
        return fail(res, 400, 'ACCOUNT_LIMIT', `账号数量已达上限（${LIMITS.maxAccounts}）`);
      }
      return handleRegister(req, res);
    case 'POST /api/login':
      return handleLogin(req, res);
    case 'POST /api/logout':
      return handleLogout(req, res, url);
    case 'GET /api/config':
      return sendJson(res, 200, LIMITS);
    case 'GET /api/health':
      return sendJson(res, 200, { ok: true, online: sessions.count(), total: store.messages.length });
    default:
      break;
  }

  if (route === 'POST /api/heartbeat') {
    const session = requireSession(req, res);
    if (!session) return undefined;
    return sendJson(res, 200, { ok: true, online: sessions.count(), serverTime: Date.now() });
  }

  if (route === 'GET /api/me') {
    const session = requireSession(req, res);
    if (!session) return undefined;
    return sendJson(res, 200, {
      me: publicMe(session),
      online: sessions.count(),
      limits: LIMITS,
    });
  }

  if (route === 'GET /api/state') {
    const session = requireSession(req, res);
    if (!session) return undefined;
    return sendJson(res, 200, {
      online: sessions.count(),
      members: sessions.members(),
      cursor: store.messages.length ? store.messages[store.messages.length - 1].id : 0,
      serverTime: Date.now(),
    });
  }

  if (route === 'GET /api/messages' || route === 'POST /api/messages') {
    const session = requireSession(req, res);
    if (!session) return undefined;
    return handleMessages(req, res, url, session);
  }

  if (route === 'POST /api/account') {
    const session = requireSession(req, res);
    if (!session) return undefined;
    return handleAccountUpdate(req, res, session);
  }

  return fail(res, 404, 'NOT_FOUND', '接口不存在');
}

function serveStatic(req, res, pathname) {
  if (pathname === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }
  const relative = pathname === '/' ? '/index.html' : pathname;
  const target = path.join(PUBLIC_DIR, path.normalize(relative).replace(/^[/\\]+/, ''));

  if (!target.startsWith(PUBLIC_DIR)) {
    return fail(res, 403, 'FORBIDDEN', '禁止访问');
  }

  fs.readFile(target, (err, buffer) => {
    if (err) {
      return fail(res, 404, 'NOT_FOUND', '页面不存在');
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buffer);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return fail(res, 405, 'METHOD_NOT_ALLOWED', '不支持的请求方法');
    }
    serveStatic(req, res, url.pathname);
  } catch (err) {
    if (err && (err.message === 'BAD_JSON' || err.message === 'BODY_TOO_LARGE')) {
      return fail(res, 400, 'INVALID_INPUT', '请求内容格式不正确');
    }
    console.error('[server] 未处理异常：', err);
    if (!res.headersSent) fail(res, 500, 'INTERNAL', '服务器内部错误');
  }
});

const housekeeping = setInterval(() => {
  const { removed } = store.prune();
  if (removed > 0) {
    store.flush();
    console.log(`[store] 已清理 ${removed} 条过期消息，当前 ${store.messages.length} 条`);
  }
  sessions.sweep();
  const now = Date.now();
  for (const [key, hits] of rateMap) {
    if (!hits.some((t) => now - t < LIMITS.rateWindowMs)) rateMap.delete(key);
  }
}, 60 * 1000);
if (housekeeping.unref) housekeeping.unref();

server.listen(PORT, HOST, () => {
  console.log(`AI 助手已启动：http://localhost:${PORT}`);
  console.log(`局域网访问：http://<本机IP>:${PORT}`);
  console.log(`保留策略：${LIMITS.retainDays} 天 / ${LIMITS.maxMessages} 条 · 在线上限 ${LIMITS.maxOnline} 台设备 · 轮询 3 秒`);
});

function shutdown() {
  try {
    store.flush();
  } catch {
    /* ignore */
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
