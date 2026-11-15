'use strict';

// R2 连通性自检：读取 .env.local -> 生成 presigned PUT -> 真实上传 -> 从公开域读回。
// 用法：node scripts/r2-smoke.js
// 产物会在桶里留下 t/smoke-<时间戳>.txt，7 天后由生命周期规则自动清理。

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const ROOT = path.join(__dirname, '..');

function loadEnvFile() {
  const file = path.join(ROOT, '.env.local');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

function request(url, options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

function fmtMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function main() {
  loadEnvFile();
  const r2 = require(path.join(ROOT, 'lib', 'r2.js'));

  console.log('[1/4] 环境变量检查');
  const cfg = r2.r2Env();
  const masked = (v) => (v ? `${v.slice(0, 6)}...${v.slice(-4)} (${v.length})` : '(缺失)');
  console.log('  account :', masked(cfg.accountId));
  console.log('  access  :', masked(cfg.accessKey));
  console.log('  secret  :', masked(cfg.secretKey));
  console.log('  bucket  :', cfg.bucket || '(缺失)');
  console.log('  base    :', cfg.publicBase || '(缺失)');

  if (!r2.isConfigured()) {
    console.error('\n配置不完整，中止。');
    process.exitCode = 1;
    return;
  }

  const name = `smoke-${Date.now()}.txt`;
  const key = `t/${name}`;
  const payload = `r2 smoke test at ${new Date().toISOString()}\n`;
  const contentType = r2.safeMime('text/plain');

  console.log('\n[2/4] 生成签名');
  const signed = r2.presignPut(key, contentType, 900);
  console.log('  key     :', key);
  console.log('  签名 URL :', `${signed.uploadUrl.slice(0, 90)}...`);
  console.log('  公开 URL :', signed.publicUrl);

  console.log('\n[3/4] 上传');
  const put = await request(
    signed.uploadUrl,
    {
      method: 'PUT',
      headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(payload) },
    },
    payload,
  );
  console.log('  HTTP', put.status);
  if (put.status !== 200) {
    console.log('  响应体:', put.body.slice(0, 600));
    console.error('\n上传失败：请检查 Access Key / Secret 是否正确，以及令牌是否含「对象读和写」权限。');
    process.exitCode = 1;
    return;
  }
  console.log('  ETag    :', put.headers.etag);

  console.log('\n[4/4] 通过公开域读回');
  const got = await request(signed.publicUrl, { method: 'GET' });
  console.log('  HTTP', got.status, '| type:', got.headers['content-type']);
  if (got.status !== 200) {
    console.log('  响应体:', got.body.slice(0, 400));
    console.error('\n读回失败：公开访问可能还没就绪，或自定义域未绑定到该桶。');
    process.exitCode = 1;
    return;
  }
  const ok = got.body === payload;
  console.log('  内容一致:', ok ? '是' : '否');
  console.log('  字节数  :', `${Buffer.byteLength(got.body)} (${fmtMB(Buffer.byteLength(got.body))})`);

  console.log(ok ? '\n通过：签名、上传、公开读取全链路正常。' : '\n内容不一致，请检查。');
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error('自检失败：', err.message);
  process.exitCode = 1;
});
