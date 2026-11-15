'use strict';

// Cloudflare R2（S3 兼容）presigned PUT 签名。
// 纯 node:crypto 实现 AWS SigV4，不引入任何第三方依赖。

const crypto = require('node:crypto');

const SERVICE = 's3';
const REGION = 'auto';
const ALGORITHM = 'AWS4-HMAC-SHA256';
const UPLOAD_EXPIRES = 900; // 上传链接有效期 15 分钟
const RETAIN_DAYS = 7; // 与 R2 生命周期规则保持一致

let cachedEnv = null;

function r2Env() {
  if (cachedEnv) return cachedEnv;
  cachedEnv = {
    accountId: String(process.env.R2_ACCOUNT_ID || '').trim(),
    accessKey: String(process.env.R2_ACCESS_KEY || '').trim(),
    secretKey: String(process.env.R2_SECRET_KEY || '').trim(),
    bucket: String(process.env.R2_BUCKET || '').trim(),
    publicBase: String(process.env.R2_PUBLIC_BASE || '').trim().replace(/\/+$/, ''),
    maxBytes: Math.max(1, Number(process.env.R2_MAX_SIZE_MB || 100)) * 1024 * 1024,
  };
  return cachedEnv;
}

function isConfigured() {
  const cfg = r2Env();
  return Boolean(cfg.accountId && cfg.accessKey && cfg.secretKey && cfg.bucket && cfg.publicBase);
}

function publicBase() {
  return r2Env().publicBase;
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

// 对象键：<c|s>/<32位随机hex>/<文件名>
// 文件名进 URL 的好处：浏览器下载时直接使用真实文件名，无需设置 Content-Disposition，
// 也就不必把 content-disposition 额外签进请求头。
function buildObjectKey(scene, filename) {
  const prefix = scene === 'share' ? 's' : 'c';
  const id = crypto.randomBytes(16).toString('hex');
  return `${prefix}/${id}/${sanitizeFilename(filename)}`;
}

function objectPublicUrl(key) {
  const base = r2Env().publicBase;
  if (!base) return '';
  return `${base}/${key.split('/').map(awsUriEncode).join('/')}`;
}

// 生成 presigned PUT URL。
// key: 桶内对象键（如 c/<hex>/<name>）；contentType: 已经过 safeMime 处理。
function presignPut(key, contentType, expiresIn = UPLOAD_EXPIRES) {
  const cfg = r2Env();
  if (!isConfigured()) throw new Error('R2_NOT_CONFIGURED');

  const ttl = Math.min(Math.max(1, Math.floor(expiresIn)), 604800);
  const host = `${cfg.accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${cfg.bucket}/${key.split('/').map(awsUriEncode).join('/')}`;

  const now = new Date();
  const amzDate = `${now.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

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
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`;
  const canonicalRequest = [
    'PUT',
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    'content-type;host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    sha256hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${cfg.secretKey}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto
    .createHmac('sha256', kSigning)
    .update(stringToSign, 'utf8')
    .digest('hex');

  return {
    uploadUrl: `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    publicUrl: objectPublicUrl(key),
    key,
    contentType,
    expiresIn: ttl,
  };
}

// 随消息广播的文件元数据
function buildFileMeta({ key, name, size, mime }) {
  return {
    key,
    name: sanitizeFilename(name),
    size: Math.min(Number(size) || 0, Number.MAX_SAFE_INTEGER),
    mime: safeMime(mime),
    url: objectPublicUrl(key),
    expireAt: Date.now() + RETAIN_DAYS * 24 * 60 * 60 * 1000,
  };
}

module.exports = {
  r2Env,
  isConfigured,
  publicBase,
  presignPut,
  buildObjectKey,
  buildFileMeta,
  objectPublicUrl,
  safeMime,
  sanitizeFilename,
  RETAIN_DAYS,
  UPLOAD_EXPIRES,
};
