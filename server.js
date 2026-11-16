'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// 本地开发时自动读取 .env.local（该文件被 .gitignore 与 .dockerignore 双重排除）。
// 生产环境通过 docker -e 注入变量，镜像内不包含任何密钥文件。
// 必须在 require('./lib/r2') 之前执行，因为该模块会缓存读取到的环境变量。
(function loadLocalEnv() {
  try {
    const file = path.join(__dirname, '.env.local');
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const text = line.trim();
      if (!text || text.startsWith('#')) continue;
      const eq = text.indexOf('=');
      if (eq < 1) continue;
      const key = text.slice(0, eq).trim();
      const value = text.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // 读取失败不影响启动，走纯环境变量
  }
})();

const { MessageStore } = require('./lib/store');
const { SessionManager } = require('./lib/sessions');
const { AccountStore } = require('./lib/accounts');
const r2 = require('./lib/r2');

const PORT = Number(process.env.PORT || 3080);
const HOST = process.env.HOST || '0.0.0.0';

// 自助注册默认关闭：账号一律由管理员在「系统设置 → 用户管理」里创建。
// 需要开回来自助注册时，启动时带上 ALLOW_REGISTER=1。
const ALLOW_REGISTER = /^(1|true|yes|on)$/i.test(String(process.env.ALLOW_REGISTER || ''));

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
  maxFileMB: Math.max(1, Number(process.env.R2_MAX_SIZE_MB || 100)),
};

const RETAIN_DAYS = r2.RETAIN_DAYS;

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

function requireAdmin(req, res, message) {
  const session = requireSession(req, res);
  if (!session) return null;
  if (!accounts.isAdmin(session.username)) {
    fail(res, 403, 'FORBIDDEN', message || '仅管理员可以管理账号');
    return null;
  }
  return session;
}

// 账号库为空时永远放行，避免误配置导致谁也建不了号（首次启动会自动建 admin，正常不会走到这里）
function registerAllowed() {
  return ALLOW_REGISTER || accounts.count() === 0;
}

async function handleRegister(req, res) {
  if (!registerAllowed()) {
    return fail(res, 403, 'REGISTER_DISABLED', '自助注册已关闭，请联系管理员开通账号');
  }
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

// 签发一次性的上传许可。文件字节不经过本服务，直接由浏览器 PUT 到对应的对象存储。
// scene：chat（聊天附件，R2）/ share（独立分享，R2）/ keep（永久保存，Tigris）
async function handleFileSign(req, res, session) {
  let body;
  try {
    body = await readBody(req, 8 * 1024);
  } catch (err) {
    return fail(res, 400, 'INVALID_INPUT', err.message === 'BODY_TOO_LARGE' ? '请求体过大' : '请求格式错误');
  }

  const scene = body.scene === 'keep' ? 'keep' : body.scene === 'chat' ? 'chat' : 'share';
  const store = scene === 'keep' ? 'keep' : 'tmp';
  if (!r2.isConfigured(store)) {
    return fail(res, 503, 'FILE_UPLOAD_DISABLED', scene === 'keep' ? '永久存储未启用' : '文件上传功能未启用');
  }

  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0) {
    return fail(res, 400, 'INVALID_INPUT', '文件大小无效');
  }
  if (size > r2.maxBytes(store)) {
    return fail(res, 413, 'FILE_TOO_LARGE', `单个文件不能超过 ${LIMITS.maxFileMB} MB`);
  }

  if (rateLimited(`file:${session.deviceKey}`)) {
    return fail(res, 429, 'RATE_LIMITED', '上传太频繁了，请稍后再试');
  }

  const name = r2.sanitizeFilename(body.name);
  const contentType = r2.safeMime(body.mime);
  const key = r2.buildObjectKey(scene, name);

  let signed;
  try {
    signed = r2.presignPut(store, key, contentType);
  } catch (err) {
    console.error('[files] 签名失败：', err.message);
    return fail(res, 500, 'SIGN_FAILED', '签发上传许可失败');
  }

  // 有新文件要进来，让列表缓存失效，避免别人 15 秒内看不到
  fileListCache[store] = { at: 0, data: null };

  return sendJson(res, 200, {
    uploadUrl: signed.uploadUrl,
    // Tigris 无公开域：分享链接指向免登录的扫码下载入口，同样长期有效
    publicUrl: signed.publicUrl || requestOrigin(req) + '/api/files/scan?key=' + encodeURIComponent(key),
    key,
    name,
    contentType,
    size,
    store,
    expiresIn: signed.expiresIn,
    expireAt: scene === 'keep' ? 0 : Date.now() + RETAIN_DAYS * 24 * 60 * 60 * 1000,
    retainDays: scene === 'keep' ? 0 : RETAIN_DAYS,
  });
}

// 请求来源（扫码/分享链接要写明本服务地址）：内网 http，走反代时认 x-forwarded-proto
function requestOrigin(req) {
  const proto =
    String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim() || 'http';
  const host = String(req.headers.host || '').trim();
  return host ? `${proto}://${host}` : '';
}

// 桶内对象列表 + 空间占用，按存储分桶缓存（tmp=R2 / keep=Tigris）。
// 列表有 15 秒缓存：翻页属于 Class A 操作，多人同时打开页面时不该每次都去敲存储。
let fileListCache = { tmp: { at: 0, data: null }, keep: { at: 0, data: null } };

function summarizeUsage(objects, store) {
  const isKeep = store === 'keep';
  const quotaBytes = isKeep ? r2.KEEP_QUOTA_BYTES : r2.FREE_QUOTA_BYTES; // R2 免费 10GB / Tigris 免费 5GB
  const bytes = objects.reduce((sum, o) => sum + (Number(o.size) || 0), 0);
  const byScene = {
    chat: { count: 0, bytes: 0 },
    share: { count: 0, bytes: 0 },
    keep: { count: 0, bytes: 0 },
    other: { count: 0, bytes: 0 },
  };
  for (const o of objects) {
    const bucket = byScene[o.scene] || byScene.other;
    bucket.count += 1;
    bucket.bytes += Number(o.size) || 0;
  }
  return {
    count: objects.length,
    bytes,
    quotaBytes,
    percent: quotaBytes ? Number(((bytes / quotaBytes) * 100).toFixed(2)) : null,
    byScene,
  };
}

async function collectFiles(force, store) {
  const cache = fileListCache[store] || { at: 0, data: null };
  if (!force && cache.data && Date.now() - cache.at < r2.LIST_CACHE_MS) {
    return Object.assign({}, cache.data, { cached: true });
  }
  const { objects, truncated } = await r2.listObjects(store);
  const data = {
    store,
    objects,
    truncated,
    usage: summarizeUsage(objects, store),
    fetchedAt: Date.now(),
    cached: false,
  };
  fileListCache[store] = { at: Date.now(), data };
  return data;
}

// 对象键合法性：只接受我们签出的 <scene>/<hex>/<name> 结构
function isValidFileKey(key) {
  return (
    typeof key === 'string' &&
    key.length > 0 &&
    key.length <= 400 &&
    key.indexOf('..') < 0 &&
    /^[^/]+\/[^/]+\//.test(key)
  );
}

// 按 key 找对象：key 首段决定查哪个桶（k/ → Tigris，其余 → R2），优先用缓存，
// 找不到再强制刷一次（缓存可能落后于真实状态：刚上传完，或刚被生命周期删掉）
async function findFile(key) {
  const store = r2.storeFromKey(key);
  const payload = await collectFiles(false, store);
  const hit = payload.objects.find((o) => o.key === key);
  if (hit) return hit;
  const fresh = await collectFiles(true, store);
  return fresh.objects.find((o) => o.key === key) || null;
}

async function handleFileList(req, res, url) {
  const store = url.searchParams.get('store') === 'keep' ? 'keep' : 'tmp';
  if (!r2.isConfigured(store)) {
    return fail(res, 503, 'FILE_UPLOAD_DISABLED', store === 'keep' ? '永久存储未启用' : '文件功能未启用');
  }
  const force = url.searchParams.get('refresh') === '1';
  try {
    const payload = await collectFiles(force, store);
    return sendJson(res, 200, payload);
  } catch (err) {
    console.error('[files] 列表读取失败：', err.message);
    const msg = /^LIST_FAILED_403/.test(err.message)
      ? 'API 令牌没有读取对象的权限'
      : '读取文件列表失败';
    return fail(res, 502, 'LIST_FAILED', msg);
  }
}

// 签发下载链接：302 不适合前端带自定义头，所以返回 JSON 由前端跳转。
// 链接 5 分钟有效，附带 attachment 头，图片/PDF 也会直接另存而不是在新标签打开。
async function handleFileDownload(req, res, url) {
  const key = String(url.searchParams.get('key') || '').trim();
  const store = r2.storeFromKey(key);
  if (!r2.isConfigured(store)) {
    return fail(res, 503, 'FILE_UPLOAD_DISABLED', '文件功能未启用');
  }
  if (!isValidFileKey(key)) {
    return fail(res, 400, 'INVALID_KEY', '文件标识无效');
  }

  let target = null;
  try {
    target = await findFile(key);
  } catch (err) {
    console.error('[files] 下载前校验失败：', err.message);
    return fail(res, 502, 'LIST_FAILED', '读取文件信息失败');
  }
  if (!target) {
    return fail(res, 404, 'NOT_FOUND', '文件不存在或已过期清理');
  }

  try {
    const signed = r2.presignGet(store, key, { expiresIn: 300, downloadName: target.name });
    return sendJson(res, 200, {
      url: signed.url,
      name: target.name,
      size: target.size,
      expiresIn: signed.expiresIn,
    });
  } catch (err) {
    console.error('[files] 下载签名失败：', err.message);
    return fail(res, 500, 'SIGN_FAILED', '签发下载链接失败');
  }
}

// 扫码下载：手机扫码时没有登录态，所以这条路径免登录。
// 保密性由 key 里的 32 位随机 hex 提供，与公开域直链同等强度；
// 区别是这里强制走 attachment，图片/PDF 扫码后也会直接另存为原文件名。
// 响应是 302 跳转到现签的 5 分钟链接，因此二维码本身永不过期。
async function handleFileScan(req, res, url) {
  const key = String(url.searchParams.get('key') || '').trim();
  const store = r2.storeFromKey(key);
  if (!r2.isConfigured(store)) {
    return fail(res, 503, 'FILE_UPLOAD_DISABLED', '文件功能未启用');
  }
  if (!isValidFileKey(key)) {
    return fail(res, 400, 'INVALID_KEY', '文件标识无效');
  }

  let target = null;
  try {
    target = await findFile(key);
  } catch (err) {
    console.error('[files] 扫码下载校验失败：', err.message);
    return fail(res, 502, 'LIST_FAILED', '读取文件信息失败');
  }
  if (!target) {
    return fail(res, 404, 'NOT_FOUND', '文件不存在或已过期清理');
  }

  let signed;
  try {
    signed = r2.presignGet(store, key, { expiresIn: 300, downloadName: target.name });
  } catch (err) {
    console.error('[files] 扫码下载签名失败：', err.message);
    return fail(res, 500, 'SIGN_FAILED', '签发下载链接失败');
  }
  res.writeHead(302, { Location: signed.url, 'Cache-Control': 'no-store' });
  res.end();
  return undefined;
}

// 删除单个对象。仅管理员可调用，删完立刻让列表缓存失效。
async function handleFileDelete(req, res, url) {
  const key = String(url.searchParams.get('key') || '').trim();
  const store = r2.storeFromKey(key);
  if (!r2.isConfigured(store)) {
    return fail(res, 503, 'FILE_UPLOAD_DISABLED', '文件功能未启用');
  }
  if (!isValidFileKey(key)) {
    return fail(res, 400, 'INVALID_KEY', '文件标识无效');
  }

  let target = null;
  try {
    target = await findFile(key);
  } catch (err) {
    console.error('[files] 删除前校验失败：', err.message);
    return fail(res, 502, 'LIST_FAILED', '读取文件信息失败');
  }
  if (!target) {
    return fail(res, 404, 'NOT_FOUND', '文件不存在或已过期清理');
  }

  try {
    await r2.deleteObject(store, key);
  } catch (err) {
    console.error('[files] 删除失败：', err.message);
    return fail(res, 502, 'DELETE_FAILED', '删除失败，请稍后重试');
  }

  fileListCache[store] = { at: 0, data: null };
  console.log(`[files] 已删除 ${key}（${target.name}，${target.size} 字节）`);
  return sendJson(res, 200, { ok: true, key, name: target.name });
}

// 校验前端回传的文件元数据：只接受我们自己签出的 key 前缀，且 URL 必须落在公开域上，
// 避免客户端伪造一条指向外站的「文件消息」。
function normalizeIncomingFile(input) {
  if (!input || typeof input !== 'object') return null;
  if (!r2.isConfigured('tmp')) return null;

  const key = String(input.key || '');
  // 消息附件一律走临时存储（R2），永久存储的文件只存在于「文件」页
  if (!/^[cs]\/[0-9a-f]{32}\//.test(key)) return null;

  const url = String(input.url || '');
  const base = r2.publicBase('tmp');
  if (!base || !url.startsWith(`${base}/`)) return null;

  const size = Number(input.size);
  if (!Number.isFinite(size) || size <= 0 || size > r2.maxBytes('tmp')) return null;

  const name = r2.sanitizeFilename(input.name);
  if (!name) return null;

  const expireAt = Number(input.expireAt);
  const ttl = RETAIN_DAYS * 24 * 60 * 60 * 1000;
  return {
    key,
    name,
    size,
    mime: r2.safeMime(input.mime),
    url,
    // 不信任客户端给的过期时间，最多按保留期上界截断
    expireAt:
      Number.isFinite(expireAt) && expireAt > Date.now()
        ? Math.min(expireAt, Date.now() + ttl)
        : Date.now() + ttl,
  };
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
  const file = normalizeIncomingFile(body.file);
  const raw = typeof body.content === 'string' ? body.content : '';
  let content = raw.replace(/\r\n/g, '\n').trim();
  // 纯附件消息没有文字，用文件名兜底，保证 content 非空（搜索、复制、通知都有内容可显示）
  if (!content && file) content = file.name;
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
    file,
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
      return sendJson(
        res,
        200,
        Object.assign({}, LIMITS, {
          allowRegister: registerAllowed(),
          fileUpload: r2.isConfigured('tmp'),
          keepUpload: r2.keepConfigured(),
          retainFileDays: RETAIN_DAYS,
        }),
      );
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

  if (route === 'POST /api/files/sign') {
    const session = requireSession(req, res);
    if (!session) return undefined;
    return handleFileSign(req, res, session);
  }

  if (route === 'GET /api/files') {
    const session = requireAdmin(req, res, '仅管理员可以查看云端文件列表');
    if (!session) return undefined;
    return handleFileList(req, res, url);
  }

  if (route === 'GET /api/files/download') {
    const session = requireAdmin(req, res, '仅管理员可以下载云端文件');
    if (!session) return undefined;
    return handleFileDownload(req, res, url);
  }

  if (route === 'DELETE /api/files') {
    const session = requireAdmin(req, res, '仅管理员可以删除云端文件');
    if (!session) return undefined;
    return handleFileDelete(req, res, url);
  }

  // 扫码下载走免登录：手机扫码没有登录态，key 本身即凭证
  if (route === 'GET /api/files/scan') {
    return handleFileScan(req, res, url);
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
  console.log(
    `账号：${accounts.count()} 个 · 自助注册${registerAllowed() ? '已开启' : '已关闭（由管理员创建）'}`,
  );
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
