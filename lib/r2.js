'use strict';

// 双对象存储签名客户端：临时存储（Cloudflare R2）与永久存储（Tigris）。
// 两者都是 S3 兼容 API，SigV4 用纯 node:crypto 实现，不引入任何第三方依赖。
//
// store 约定：
//   'tmp'  → R2，对象键前缀 c/（聊天附件）与 s/（独立分享），配 7 天生命周期自动清理
//   'keep' → Tigris，对象键前缀 k/，无生命周期，永久保存
// key 首段即归属：storeFromKey() 据此把下载/删除/扫码请求路由到正确的桶。

const crypto = require('node:crypto');

const SERVICE = 's3';
const REGION = 'auto';
const ALGORITHM = 'AWS4-HMAC-SHA256';
const UPLOAD_EXPIRES = 900; // 上传链接有效期 15 分钟
const RETAIN_DAYS = 7; // R2 临时文件保留期，与 R2 生命周期规则保持一致；Tigris 永久不受此限
const FREE_QUOTA_BYTES = 10 * 1024 * 1024 * 1024; // R2 免费额度 10 GB-月（Tigris 无固定配额，按已用量展示）
const LIST_CACHE_MS = 15000; // 列表缓存，避免频繁翻页消耗 Class A 操作
const KEEP_INLINE_EXPIRES = 3600; // Tigris 无公开域，预览链接 1 小时有效

let cachedEnv = null;

function envCfg() {
  if (cachedEnv) return cachedEnv;
  cachedEnv = {
    accountId: String(process.env.R2_ACCOUNT_ID || '').trim(),
    accessKey: String(process.env.R2_ACCESS_KEY || '').trim(),
    secretKey: String(process.env.R2_SECRET_KEY || '').trim(),
    bucket: String(process.env.R2_BUCKET || '').trim(),
    publicBase: String(process.env.R2_PUBLIC_BASE || '').trim().replace(/\/+$/, ''),
    maxBytes: Math.max(1, Number(process.env.R2_MAX_SIZE_MB || 100)) * 1024 * 1024,
    tigrisEndpoint: (String(process.env.TIGRIS_S3_ENDPOINT || 'https://fly.storage.tigris.dev').trim().replace(/\/+$/, '')) || 'https://fly.storage.tigris.dev',
    tigrisAccessKey: String(process.env.TIGRIS_ACCESS_KEY || '').trim(),
    tigrisSecretKey: String(process.env.TIGRIS_SECRET_KEY || '').trim(),
    tigrisBucket: String(process.env.TIGRIS_BUCKET || '').trim(),
    tigrisMaxBytes: Math.max(1, Number(process.env.TIGRIS_MAX_SIZE_MB || 100)) * 1024 * 1024,
  };
  return cachedEnv;
}

// 两个存储的完整连接配置。host 取自 endpoint，签名一律用 region 'auto'。
function storeCfg(store) {
  const e = envCfg();
  if (store === 'keep') {
    const endpoint = e.tigrisEndpoint;
    return {
      store: 'keep',
      endpoint,
      host: endpoint.replace(/^https?:\/\//, ''),
      accessKey: e.tigrisAccessKey,
      secretKey: e.tigrisSecretKey,
      bucket: e.tigrisBucket,
      region: REGION,
      publicBase: '', // Tigris 侧不配公开域，读走服务端签名链接
      maxBytes: e.tigrisMaxBytes,
    };
  }
  const endpoint = `https://${e.accountId}.r2.cloudflarestorage.com`;
  return {
    store: 'tmp',
    endpoint,
    host: `${e.accountId}.r2.cloudflarestorage.com`,
    accessKey: e.accessKey,
    secretKey: e.secretKey,
    bucket: e.bucket,
    region: REGION,
    publicBase: e.publicBase,
    maxBytes: e.maxBytes,
  };
}

function isConfigured(store) {
  const cfg = storeCfg(store);
  return Boolean(cfg.accessKey && cfg.secretKey && cfg.bucket);
}

// 是否配置了永久存储（用于 /api/config 决定是否展示「永久存储」页签）
function keepConfigured() {
  return isConfigured('keep');
}

function maxBytes(store) {
  return storeCfg(store).maxBytes;
}

function publicBase(store) {
  return storeCfg(store).publicBase;
}

// 对象键首段即归属：k/ → 永久（Tigris），其余 → 临时（R2）
function storeFromKey(key) {
  return typeof key === 'string' && key.indexOf('k/') === 0 ? 'keep' : 'tmp';
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

// RFC 3986 编码（SigV4 要求，保留 A-Za-z0-9-._~，其余转 %XX 大写）
function awsUriEncode(value) {
  return String(value).replace(/[^A-Za-z0-9\-._~]/g, (ch) => {
    return Buffer.from(ch, 'utf8')
      .toString('hex')
      .replace(/(..)/g, '%$1')
      .toUpperCase();
  });
}

// 允许 inline 展示/预览的类型；其余（含 html/svg 等可执行内容的载体）
// 一律降级为 application/octet-stream，浏览器只会下载不会执行。
const INLINE_MIME = [
  /^image\/(png|jpeg|jpg|gif|webp|bmp|avif|heic|heif)$/,
  /^application\/pdf$/,
  /^text\/plain$/,
  /^application\/(zip|x-rar-compressed|vnd\.rar|x-7z-compressed|x-zip-compressed|x-tar|gzip|vnd\.android\.package-archive)$/,
  /^application\/(msword|vnd\.ms-excel|vnd\.ms-powerpoint)$/,
  /^application\/vnd\.(openxmlformats-officedocument|ms-excel|ms-powerpoint|ms-word)[\w.\-]*$/,
  /^video\/(mp4|webm|quicktime|x-matroska)$/,
  /^audio\/(mpeg|mp4|ogg|wav|aac|flac)$/,
];

function safeMime(mime) {
  const value = String(mime || '').toLowerCase().trim().split(';')[0];
  if (!value || value.length > 120) return 'application/octet-stream';
  for (const pattern of INLINE_MIME) {
    if (pattern.test(value)) return value;
  }
  return 'application/octet-stream';
}

// 文件名清洗：去路径分隔符与控制字符，限长 100（保留扩展名）
function sanitizeFilename(name) {
  const cleaned = String(name || '')
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const base = !cleaned || /^\.+$/.test(cleaned) ? 'file' : cleaned;
  const chars = Array.from(base);
  if (chars.length <= 100) return base;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 && base.length - dot <= 12 ? base.slice(dot) : '';
  return chars.slice(0, 100 - ext.length).join('') + ext;
}

// 对象键：<c|s|k>/<32位随机hex>/<文件名>
// 文件名进 URL 的好处：浏览器下载时直接使用真实文件名，无需设置 Content-Disposition，
// 也就不必把 content-disposition 额外签进请求头。
function buildObjectKey(scene, filename) {
  const prefix = scene === 'keep' ? 'k' : scene === 'share' ? 's' : 'c';
  const id = crypto.randomBytes(16).toString('hex');
  return `${prefix}/${id}/${sanitizeFilename(filename)}`;
}

function canonicalUriOf(cfg, key) {
  return `/${cfg.bucket}/${key.split('/').map(awsUriEncode).join('/')}`;
}

function signingKeyOf(cfg, dateStamp) {
  const kDate = hmac(`AWS4${cfg.secretKey}`, dateStamp);
  return hmac(hmac(hmac(kDate, cfg.region), SERVICE), 'aws4_request');
}

function amzDates() {
  const now = new Date();
  const amzDate = `${now.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function objectPublicUrl(store, key) {
  const cfg = storeCfg(store);
  if (!cfg.publicBase) return '';
  return `${cfg.publicBase}/${key.split('/').map(awsUriEncode).join('/')}`;
}

// 生成 presigned PUT URL（content-type 签进请求，客户端 PUT 时必须带同样的头）。
function presignPut(store, key, contentType, expiresIn = UPLOAD_EXPIRES) {
  const cfg = storeCfg(store);
  if (!isConfigured(store)) throw new Error('STORE_NOT_CONFIGURED');

  const ttl = Math.min(Math.max(1, Math.floor(expiresIn)), 604800);
  const canonicalUri = canonicalUriOf(cfg, key);
  const { amzDate, dateStamp } = amzDates();
  const credentialScope = `${dateStamp}/${cfg.region}/${SERVICE}/aws4_request`;

  const queryPairs = [
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${cfg.accessKey}/${credentialScope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(ttl)],
    ['X-Amz-SignedHeaders', 'content-type;host'],
  ]
    .map(([k, v]) => [awsUriEncode(k), awsUriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`);

  const canonicalQuery = queryPairs.join('&');
  const canonicalHeaders = `content-type:${contentType}\nhost:${cfg.host}\n`;
  const canonicalRequest = [
    'PUT',
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    'content-type;host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, credentialScope, sha256hex(canonicalRequest)].join('\n');
  const signature = crypto
    .createHmac('sha256', signingKeyOf(cfg, dateStamp))
    .update(stringToSign, 'utf8')
    .digest('hex');

  return {
    uploadUrl: `${cfg.endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    publicUrl: objectPublicUrl(store, key),
    key,
    contentType,
    expiresIn: ttl,
  };
}

// ---------------- 服务端读取（列桶 / 签发下载 / 删除） ----------------

// 服务端管理请求（header 式签名，query 参与排序签名）。用于 ListObjectsV2 / DeleteObject。
async function signedRequest(store, method, canonicalUri, query = {}) {
  const cfg = storeCfg(store);
  if (!isConfigured(store)) throw new Error('STORE_NOT_CONFIGURED');

  const { amzDate, dateStamp } = amzDates();
  const scope = `${dateStamp}/${cfg.region}/${SERVICE}/aws4_request`;

  const pairs = Object.keys(query)
    .filter((k) => query[k] !== undefined && query[k] !== null && query[k] !== '')
    .map((k) => [awsUriEncode(k), awsUriEncode(query[k])])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalQuery = pairs.map(([k, v]) => `${k}=${v}`).join('&');

  const canonicalHeaders = `host:${cfg.host}\nx-amz-content-sha256:UNSIGNED-PAYLOAD\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const signature = crypto
    .createHmac('sha256', signingKeyOf(cfg, dateStamp))
    .update(stringToSign, 'utf8')
    .digest('hex');

  const url = `${cfg.endpoint}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
  return fetch(url, {
    method,
    headers: {
      'x-amz-date': amzDate,
      'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      Authorization:
        `${ALGORITHM} Credential=${cfg.accessKey}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  });
}

function pickAll(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function pick(xml, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? m[1] : '';
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// 列出桶内对象。S3 兼容端点单页最多 1000 条，这里限制总页数。
// expireAt 为 0 表示永久保存（Tigris 侧没有生命周期）。
async function listObjects(store, { maxPages = 10 } = {}) {
  const cfg = storeCfg(store);
  if (!isConfigured(store)) throw new Error('STORE_NOT_CONFIGURED');

  const isKeep = store === 'keep';
  const objects = [];
  let token = '';
  let truncated = false;
  let pages = 0;

  for (;;) {
    const res = await signedRequest(store, 'GET', `/${cfg.bucket}`, {
      'list-type': '2',
      'max-keys': '1000',
      'continuation-token': token,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`LIST_FAILED_${res.status}:${body.slice(0, 200)}`);
    }
    const xml = await res.text();
    pages += 1;

    for (const block of pickAll(xml, 'Contents')) {
      const key = decodeXml(pick(block, 'Key'));
      if (!key) continue;
      const lastModified = decodeXml(pick(block, 'LastModified'));
      const segs = key.split('/');
      const scene = segs[0] === 's' ? 'share' : segs[0] === 'c' ? 'chat' : isKeep ? 'keep' : 'other';
      objects.push({
        key,
        name: segs[segs.length - 1] || key,
        size: Number(pick(block, 'Size') || 0),
        lastModified,
        createdAt: lastModified ? Date.parse(lastModified) : 0,
        expireAt: isKeep || !lastModified ? 0 : Date.parse(lastModified) + RETAIN_DAYS * 86400000,
        scene,
        // R2：公开域直链；Tigris：无公开域，改发 1 小时有效的 inline 签名链接用于预览
        url: isKeep ? previewUrl(store, key) : objectPublicUrl(store, key),
      });
    }

    if (pick(xml, 'IsTruncated') !== 'true') break;
    token = decodeXml(pick(xml, 'NextContinuationToken'));
    if (!token) break;
    if (pages >= maxPages) {
      truncated = true;
      break;
    }
  }

  objects.sort((a, b) => b.createdAt - a.createdAt);
  return { objects, truncated };
}

// 删除单个对象（SigV4 DELETE）。S3 语义幂等，重复删除也返回 204。
async function deleteObject(store, key) {
  const cfg = storeCfg(store);
  if (!isConfigured(store)) throw new Error('STORE_NOT_CONFIGURED');

  const res = await signedRequest(store, 'DELETE', canonicalUriOf(cfg, key));
  if (!res.ok && res.status !== 204) {
    const body = await res.text().catch(() => '');
    throw new Error(`DELETE_FAILED_${res.status}:${String(body).slice(0, 200)}`);
  }
  return true;
}

// 签一个有失效时间的下载链接。
// 传 downloadName 时附带 response-content-disposition，浏览器会直接另存为原名
// （公开域/内联打开时图片/PDF 默认是预览，点「下载」不该只是打开新标签）。
function presignGet(store, key, { expiresIn = 300, downloadName = '' } = {}) {
  const cfg = storeCfg(store);
  if (!isConfigured(store)) throw new Error('STORE_NOT_CONFIGURED');

  const ttl = Math.min(Math.max(1, Math.floor(expiresIn)), 7776000);
  const canonicalUri = canonicalUriOf(cfg, key);
  const { amzDate, dateStamp } = amzDates();
  const scope = `${dateStamp}/${cfg.region}/${SERVICE}/aws4_request`;

  const params = [
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${cfg.accessKey}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(ttl)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  if (downloadName) {
    // RFC 5987：中文文件名必须用 filename*，否则部分浏览器会乱码
    const ascii = sanitizeFilename(downloadName).replace(/[^\x20-\x7e]/g, '_');
    params.push([
      'response-content-disposition',
      `attachment; filename="${ascii}"; filename*=UTF-8''${awsUriEncode(sanitizeFilename(downloadName))}`,
    ]);
  }

  const canonicalQuery = params
    .map(([k, v]) => [awsUriEncode(k), awsUriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalHeaders = `host:${cfg.host}\n`;
  const canonicalRequest = ['GET', canonicalUri, canonicalQuery, canonicalHeaders, 'host', 'UNSIGNED-PAYLOAD'].join(
    '\n',
  );

  const stringToSign = [ALGORITHM, amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const signature = crypto
    .createHmac('sha256', signingKeyOf(cfg, dateStamp))
    .update(stringToSign, 'utf8')
    .digest('hex');

  return {
    url: `${cfg.endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    expiresIn: ttl,
  };
}

// Tigris 无公开域：列表页的预览链接用不带头部的签名 GET（inline），1 小时有效。
// R2 维持公开域直链不变。
function previewUrl(store, key) {
  const url = objectPublicUrl(store, key);
  if (url) return url;
  if (!isConfigured(store)) return '';
  try {
    return presignGet(store, key, { expiresIn: KEEP_INLINE_EXPIRES }).url;
  } catch (err) {
    return '';
  }
}

// 随消息广播的文件元数据。keep 场景不进消息流（消息附件一律走 R2），但保持结构一致。
function buildFileMeta({ key, name, size, mime, scene }) {
  const store = scene === 'keep' ? 'keep' : 'tmp';
  return {
    key,
    name: sanitizeFilename(name),
    size: Math.min(Number(size) || 0, Number.MAX_SAFE_INTEGER),
    mime: safeMime(mime),
    url: objectPublicUrl(store, key),
    expireAt: scene === 'keep' ? 0 : Date.now() + RETAIN_DAYS * 24 * 60 * 60 * 1000,
  };
}

module.exports = {
  storeCfg,
  isConfigured,
  keepConfigured,
  storeFromKey,
  maxBytes,
  publicBase,
  presignPut,
  presignGet,
  previewUrl,
  listObjects,
  deleteObject,
  buildObjectKey,
  buildFileMeta,
  objectPublicUrl,
  safeMime,
  sanitizeFilename,
  FREE_QUOTA_BYTES,
  LIST_CACHE_MS,
  RETAIN_DAYS,
  UPLOAD_EXPIRES,
  KEEP_INLINE_EXPIRES,
};
