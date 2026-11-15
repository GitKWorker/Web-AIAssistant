'use strict';

// 本地端到端流程验证：登录 -> 取签名 -> 直传 R2 -> 发带附件消息 -> 拉回消息核对。
// 前提：node server.js 已在 3080 端口运行。
// 用法：node scripts/upload-flow.js [用户名] [密码]

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const BASE = 'http://127.0.0.1:3080';
const USER = process.argv[2] || 'admin';
const PASS = process.argv[3] || 'admin123';

function post(urlPath, body, headers) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return request(
    new URL(BASE + urlPath),
    {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'Content-Length': payload.length },
        headers || {},
      ),
    },
    payload,
  );
}

function get(urlPath, headers) {
  return request(new URL(BASE + urlPath), { method: 'GET', headers: headers || {} });
}

function request(url, options, body) {
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('请求超时')));
    if (body) req.write(body);
    req.end();
  });
}

function step(n, text) {
  console.log(`\n[${n}] ${text}`);
}

async function main() {
  step('1/6', '读取 /api/config');
  const cfg = await get('/api/config');
  console.log('  fileUpload:', cfg.json && cfg.json.fileUpload, '| maxFileMB:', cfg.json && cfg.json.maxFileMB);
  if (!cfg.json || !cfg.json.fileUpload) {
    console.error('  文件上传未启用，检查 .env.local 是否被正确加载');
    process.exitCode = 1;
    return;
  }

  step('2/6', '登录 ' + USER);
  const login = await post('/api/login', { username: USER, password: PASS, deviceName: 'flow-test' });
  if (login.status !== 200) {
    console.log('  ', login.text.slice(0, 200));
    console.error('  登录失败，请确认账号密码（默认 admin / admin123）');
    process.exitCode = 1;
    return;
  }
  const sid = login.json.sessionId;
  const auth = { 'x-session-id': sid };
  console.log('  sessionId:', sid.slice(0, 8) + '…', '| online:', login.json.online);

  step('3/6', '申请上传许可（chat 场景）');
  // 生成一个约 1.2MB 的伪二进制文件，验证大一点的真实传输
  const body = Buffer.alloc(1200 * 1024);
  for (let i = 0; i < body.length; i += 1) body[i] = i % 251;
  const fileName = `流程测试-${Date.now()}.bin`;
  const sign = await post(
    '/api/files/sign',
    { name: fileName, size: body.length, mime: 'application/octet-stream', scene: 'chat' },
    auth,
  );
  if (sign.status !== 200) {
    console.log('  ', sign.text.slice(0, 300));
    console.error('  签名失败');
    process.exitCode = 1;
    return;
  }
  const ticket = sign.json;
  console.log('  key:', ticket.key);
  console.log('  公开地址:', ticket.publicUrl);
  console.log('  MIME:', ticket.contentType, '| 保留天数:', ticket.retainDays);

  step('4/6', `上传 ${(body.length / 1024 / 1024).toFixed(2)} MB 到 R2`);
  const putStart = Date.now();
  const put = await request(
    new URL(ticket.uploadUrl),
    {
      method: 'PUT',
      headers: { 'Content-Type': ticket.contentType, 'Content-Length': body.length },
    },
    body,
  );
  console.log('  HTTP', put.status, `| 耗时 ${Date.now() - putStart} ms`);
  if (put.status !== 200) {
    console.log('  ', put.text.slice(0, 400));
    console.error('  上传失败');
    process.exitCode = 1;
    return;
  }

  step('5/6', '发一条带附件的消息');
  const msg = await post(
    '/api/messages',
    {
      content: '',
      clientMsgId: 'flow-' + Date.now(),
      file: {
        key: ticket.key,
        name: ticket.name,
        size: body.length,
        mime: ticket.contentType,
        url: ticket.publicUrl,
        expireAt: ticket.expireAt,
      },
    },
    auth,
  );
  if (msg.status !== 200) {
    console.log('  ', msg.text.slice(0, 300));
    console.error('  发送失败');
    process.exitCode = 1;
    return;
  }
  const saved = msg.json.message;
  console.log('  消息 id:', saved.id, '| content:', JSON.stringify(saved.content));
  console.log('  file.name:', saved.file && saved.file.name);
  console.log('  file.url :', saved.file && saved.file.url);

  step('6/6', '拉回消息并核对附件字段');
  const back = await get('/api/messages?limit=5', auth);
  const found = (back.json.messages || []).find((m) => m.id === saved.id);
  console.log('  找到该条:', Boolean(found), '| 含 file 字段:', Boolean(found && found.file));

  const dl = await request(new URL(ticket.publicUrl), { method: 'GET' });
  const sizeOk = Number(dl.headers['content-length']) === body.length;
  console.log('  公开下载 HTTP', dl.status, '| 字节数一致:', sizeOk);

  const pass = Boolean(found && found.file) && dl.status === 200 && sizeOk;
  console.log(pass ? '\n全流程通过。' : '\n存在不一致，请检查上面的输出。');
  if (!pass) process.exitCode = 1;
}

main().catch((err) => {
  console.error('流程失败：', err.message);
  process.exitCode = 1;
});
