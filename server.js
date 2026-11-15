'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { MessageStore } = require('./lib/store');
const { SessionManager } = require('./lib/sessions');
const { AccountStore } = require('./lib/accounts');

const PORT = Number(process.env.PORT || 3080);
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

const GZIP_MIN = 512;
const STREAM_PING_MS = 10000;
const gzipCache = new Map();

const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
fs.mkdirSync(DATA_DIR, { recursive: true });

const store = new MessageStore(path.join(DATA_DIR, 'messages.ndjson'), LIMITS);
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
  let body = Buffer.from(JSON.stringify(payload), 'utf8');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (body.length >= GZIP_MIN && acceptsGzip(res.req)) {
    body = zlib.gzipSync(body);
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(body);
}

function acceptsGzip(req) {
  return /\bgzip\b/i.test(String((req && req.headers['accept-encoding']) || ''));
}

const streamClients = new Set();

function broadcast(event, data) {
  if (!streamClients.size) return;
  const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of streamClients) {
    try {
      client.res.write(chunk);
    } catch {
      streamClients.delete(client);
    }
  }
}

function openStream(req, res, url) {
  const raw = req.headers['x-session-id'] || url.searchParams.get('sid');
  const session = raw ? sessions.touch(String(raw)) : null;
  if (!session) {
    return fail(res, 401, 'SESSION_EXPIRED', '登录已过期，请重新登录');
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (res.socket) {
    res.socket.setNoDelay(true);
    res.socket.setKeepAlive(true);
    res.socket.setTimeout(0);
  }
  res.write('retry: 2000\n\n');

  const afterId = Number(url.searchParams.get('afterId'));
  if (url.searchParams.get('afterId') !== null && Number.isFinite(afterId)) {
    const backlog = store.listAfter(afterId, LIMITS.maxFetch);
    if (backlog.reset || backlog.messages.length) {
      res.write(
        `event: backlog\ndata: ${JSON.stringify({
          messages: backlog.messages,
          cursor: backlog.cursor,
          reset: backlog.reset,
        })}\n\n`,
      );
    }
  }

  const last = store.messages.length ? store.messages[store.messages.length - 1].id : 0;
  res.write(
    `event: hello\ndata: ${JSON.stringify({ online: sessions.count(), cursor: last, serverTime: Date.now() })}\n\n`,
  );

  const client = { res, sessionId: session.sessionId };
  streamClients.add(client);

  const ping = setInterval(() => {
    sessions.touch(session.sessionId);
    try {
      res.write(': ping\n\n');
    } catch {
      cleanup();
    }
  }, STREAM_PING_MS);
  if (ping.unref) ping.unref();

  let closed = false;
  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    streamClients.delete(client);
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
  return undefined;
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
    role: accounts.isAdmin(session.username) ? 'admin' : 'member',
    deviceName: session.deviceName,
    displayName: session.displayName,
    deviceKey: session.deviceKey,
  };
}

function requireAdmin(req, res) {
  const session = requireSession(req, res);
  if (!session) return null;
  if (!accounts.isAdmin(session.username)) {
    fail(res, 403, 'FORBIDDEN', '仅管理员可以管理账号');
    return null;
  }
  return session;
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
  broadcast('online', { online: sessions.count() });
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
  broadcast('online', { online: sessions.count() });
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

/* ---------------- 用户管理（仅管理员） ---------------- */

const NAME_RULE_TEXT = '用户名需为 2-16 位，支持中文、字母、数字、下划线和短横线';
const PASSWORD_RULE_TEXT = '密码长度需为 6-32 位';

function onlineCountByUser() {
  const map = new Map();
  for (const member of sessions.members()) {
    map.set(member.username, (map.get(member.username) || 0) + 1);
  }
  return map;
}

function userPayload(user, onlineMap) {
  return {
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    online: onlineMap ? onlineMap.get(user.username) || 0 : 0,
  };
}

async function handleUserList(req, res) {
  const session = requireAdmin(req, res);
  if (!session) return undefined;
  const onlineMap = onlineCountByUser();
  return sendJson(res, 200, {
    users: accounts.list().map((user) => userPayload(user, onlineMap)),
    me: publicMe(session),
    limits: { maxAccounts: LIMITS.maxAccounts, maxOnline: LIMITS.maxOnline },
  });
}

async function handleUserCreate(req, res) {
  const session = requireAdmin(req, res);
  if (!session) return undefined;
  const body = await readBody(req);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const role = body.role === 'admin' ? 'admin' : 'member';

  if (!NAME_RE.test(username)) return fail(res, 400, 'INVALID_INPUT', NAME_RULE_TEXT);
  if (password.length < 6 || password.length > 32) {
    return fail(res, 400, 'INVALID_INPUT', PASSWORD_RULE_TEXT);
  }
  if (accounts.findByUsername(username)) {
    return fail(res, 409, 'USERNAME_TAKEN', '该用户名已被使用');
  }
  if (accounts.count() >= LIMITS.maxAccounts) {
    return fail(res, 400, 'ACCOUNT_LIMIT', `账号数量已达上限（${LIMITS.maxAccounts}）`);
  }

  const user = accounts.create({ username, password, role });
  return sendJson(res, 200, { ok: true, user: userPayload(user, onlineCountByUser()) });
}

async function handleUserUpdate(req, res, target) {
  const session = requireAdmin(req, res);
  if (!session) return undefined;
  const account = accounts.findByUsername(target);
  if (!account) return fail(res, 404, 'NOT_FOUND', '用户不存在');

  const body = await readBody(req);
  const hasName = Object.prototype.hasOwnProperty.call(body, 'username');
  const hasPassword = Object.prototype.hasOwnProperty.call(body, 'password');
  const hasRole = Object.prototype.hasOwnProperty.call(body, 'role');

  const nextName = hasName ? String(body.username || '').trim() : '';
  const nextPassword = hasPassword ? String(body.password || '') : '';
  const nextRole = hasRole ? String(body.role || '') : '';
  const renaming = !!nextName && nextName !== account.username;

  if (renaming && !NAME_RE.test(nextName)) {
    return fail(res, 400, 'INVALID_INPUT', NAME_RULE_TEXT);
  }
  if (renaming && accounts.findByUsername(nextName)) {
    return fail(res, 409, 'USERNAME_TAKEN', '该用户名已被使用');
  }
  if (nextPassword && (nextPassword.length < 6 || nextPassword.length > 32)) {
    return fail(res, 400, 'INVALID_INPUT', PASSWORD_RULE_TEXT);
  }
  if (nextRole && nextRole !== 'admin' && nextRole !== 'member') {
    return fail(res, 400, 'INVALID_INPUT', '角色只能是管理员或普通成员');
  }
  if (!renaming && !nextPassword && !nextRole) {
    return fail(res, 400, 'INVALID_INPUT', '没有需要修改的内容');
  }
  if (
    nextRole === 'member' &&
    account.role === 'admin' &&
    accounts.adminCount() <= 1
  ) {
    return fail(res, 400, 'LAST_ADMIN', '至少要保留一个管理员，无法取消该账号的管理员身份');
  }

  const previousName = account.username;
  const isSelf = previousName === session.username;

  accounts.update(previousName, {
    username: renaming ? nextName : null,
    password: nextPassword || null,
    role: nextRole || null,
  });

  let kicked = 0;
  if (renaming) kicked += sessions.destroyByUsername(previousName);
  if (nextPassword) kicked += sessions.destroyByUsername(account.username);
  if (kicked > 0) broadcast('online', { online: sessions.count() });

  const updated = accounts.findByUsername(account.username);
  return sendJson(res, 200, {
    ok: true,
    user: userPayload(updated || account, onlineCountByUser()),
    kicked,
    relogin: isSelf && (renaming || !!nextPassword),
  });
}

async function handleUserDelete(req, res, target) {
  const session = requireAdmin(req, res);
  if (!session) return undefined;
  const account = accounts.findByUsername(target);
  if (!account) return fail(res, 404, 'NOT_FOUND', '用户不存在');
  if (account.username === session.username) {
    return fail(res, 400, 'SELF_DELETE', '不能删除当前登录的账号');
  }
  if (account.role === 'admin' && accounts.adminCount() <= 1) {
    return fail(res, 400, 'LAST_ADMIN', '至少要保留一个管理员，无法删除该账号');
  }

  const removed = accounts.remove(account.username);
  const kicked = sessions.destroyByUsername(account.username);
  if (kicked > 0) broadcast('online', { online: sessions.count() });

  return sendJson(res, 200, { ok: true, removed: removed.username, kicked });
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

  broadcast('message', { message, online: sessions.count() });

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
    case 'GET /api/stream':
      return openStream(req, res, url);
    case 'GET /api/health':
      return sendJson(
        res,
        200,
        Object.assign(
          { ok: true, online: sessions.count(), stream: streamClients.size },
          store.stats(),
        ),
      );
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

  if (route === 'GET /api/users') {
    return handleUserList(req, res);
  }

  if (route === 'POST /api/users') {
    return handleUserCreate(req, res);
  }

  if (url.pathname.indexOf('/api/users/') === 0) {
    let target = '';
    try {
      target = decodeURIComponent(url.pathname.slice('/api/users/'.length)).trim();
    } catch {
      target = '';
    }
    if (!target) return fail(res, 400, 'INVALID_INPUT', '缺少用户名');
    if (req.method === 'PATCH') return handleUserUpdate(req, res, target);
    if (req.method === 'DELETE') return handleUserDelete(req, res, target);
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

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      return fail(res, 404, 'NOT_FOUND', '页面不存在');
    }

    const ext = path.extname(target).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
      ETag: etag,
      Vary: 'Accept-Encoding',
    };

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers).end();
      return undefined;
    }

    const compressible = /^(text\/|application\/(javascript|json)|image\/svg)/.test(type);
    const headOnly = req.method === 'HEAD';

    if (compressible && stat.size > 1024 && acceptsGzip(req)) {
      const cached = gzipCache.get(target);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = cached.body.length;
        res.writeHead(200, headers);
        return res.end(headOnly ? undefined : cached.body);
      }
      fs.readFile(target, (readErr, buffer) => {
        if (readErr) return fail(res, 404, 'NOT_FOUND', '页面不存在');
        const packed = zlib.gzipSync(buffer, { level: 9 });
        gzipCache.set(target, { mtimeMs: stat.mtimeMs, size: stat.size, body: packed });
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = packed.length;
        res.writeHead(200, headers);
        return res.end(headOnly ? undefined : packed);
      });
      return undefined;
    }

    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    if (headOnly) return res.end();
    fs.createReadStream(target)
      .on('error', () => {
        if (!res.headersSent) fail(res, 500, 'INTERNAL', '服务器内部错误');
        else res.end();
      })
      .pipe(res);
    return undefined;
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
    store.maybeCompact();
    store.flush();
    console.log(`[store] 已清理 ${removed} 条过期消息，当前 ${store.messages.length} 条`);
  }
  const before = sessions.count();
  sessions.sweep();
  const after = sessions.count();
  if (before !== after) broadcast('online', { online: after });
  const now = Date.now();
  for (const [key, hits] of rateMap) {
    if (!hits.some((t) => now - t < LIMITS.rateWindowMs)) rateMap.delete(key);
  }
}, 60 * 1000);
if (housekeeping.unref) housekeeping.unref();

server.listen(PORT, HOST, () => {
  console.log(`AI 助手已启动：http://localhost:${PORT}`);
  console.log(`局域网访问：http://<本机IP>:${PORT}`);
  console.log(`保留策略：${LIMITS.retainDays} 天 / ${LIMITS.maxMessages} 条 · 在线上限 ${LIMITS.maxOnline} 台设备 · SSE 推送（轮询兜底）`);
  console.log(`存储：NDJSON 追加写 · 当前 ${store.messages.length} 条`);
});

function shutdown() {
  try {
    for (const client of streamClients) {
      try {
        client.res.end();
      } catch {
        /* ignore */
      }
    }
    streamClients.clear();
    store.flush();
  } catch {
    /* ignore */
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
