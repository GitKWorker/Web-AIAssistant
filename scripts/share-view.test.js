/* eslint-disable */
/* 发文件页状态保留 —— jsdom DOM 级回归测试
 * 依赖：npm i -D jsdom（仅本地测试用，运行镜像不含此依赖）
 * 运行：node scripts/share-view.test.js
 * 覆盖：上传后切页返回、刷新后恢复、历史列表、上传 XHR 场景隔离
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const PROJ = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(PROJ, 'public/index.html'), 'utf8');
const APP_JS = fs.readFileSync(path.join(PROJ, 'public/js/app.js'), 'utf8');
const QR_JS = fs.readFileSync(path.join(PROJ, 'public/js/vendor/qrcode.js'), 'utf8');

const PUBLIC_URL = 'https://files.frkang.top/s/abc123/%E6%8A%A5%E8%A1%A8.pdf';
let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log('  PASS  ' + name + (extra ? '  [' + extra + ']' : ''));
  } else {
    fail += 1;
    console.log('  FAIL  ' + name + (extra ? '  [' + extra + ']' : ''));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms || 30));

class FakeXHR {
  constructor() {
    this.upload = {};
    this.status = 0;
    this.aborted = false;
    FakeXHR.instances.push(this);
  }
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader() {}
  send() {
    this.sent = true;
  }
  abort() {
    this.aborted = true;
    if (this.onabort) this.onabort();
  }
  finish(status) {
    this.status = status || 200;
    if (this.onload) this.onload();
  }
}
FakeXHR.instances = [];

function makeFetch(log) {
  return function (url, opts) {
    const method = (opts && opts.method) || 'GET';
    const u = String(url);
    let data = {};
    if (u.indexOf('/api/config') === 0) {
      data = { maxOnline: 20, allowRegister: false, fileUpload: true, maxFileMB: 100, retainFileDays: 7 };
    } else if (u.split('?')[0] === '/api/me') {
      data = {
        me: { username: 'admin', deviceName: 'jsdom', displayName: 'admin', role: 'admin' },
        online: 1,
        limits: { maxOnline: 20 },
      };
    } else if (u.indexOf('/api/messages?') === 0) {
      data = { messages: [], cursor: 0, online: 1 };
    } else if (u.indexOf('/api/files/sign') === 0) {
      data = {
        uploadUrl: 'https://r2.example/put',
        contentType: 'application/pdf',
        key: 's/abc123/x.pdf',
        name: '报表.pdf',
        publicUrl: PUBLIC_URL,
        expireAt: Date.now() + 7 * 86400000,
      };
    } else if (u.indexOf('/api/messages') === 0 && method === 'POST') {
      const body = JSON.parse((opts && opts.body) || '{}');
      data = {
        message: {
          id: 'm-' + Math.random().toString(16).slice(2),
          username: 'admin',
          deviceName: 'jsdom',
          displayName: 'admin',
          content: body.content || '',
          file: body.file || null,
          createdAt: Date.now(),
        },
        online: 1,
      };
    }
    log.push(method + ' ' + u.split('?')[0]);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(data),
      headers: { get: () => null },
    });
  };
}

class NoopEventSource {
  constructor() {}
  addEventListener() {}
  close() {}
}

async function boot(seedShares) {
  const dom = new JSDOM(HTML, {
    url: 'http://127.0.0.1:3080/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const win = dom.window;

  // 关键：等 jsdom 完成解析，避免它稍后自动再触发一次 DOMContentLoaded 导致 init 跑两遍
  if (win.document.readyState !== 'complete') {
    await new Promise((res) => win.addEventListener('load', res));
  }

  const calls = [];
  FakeXHR.instances = [];

  win.localStorage.setItem('ai.sessionId', 'sess-test');
  win.localStorage.setItem('ai.username', 'admin');
  if (seedShares) win.localStorage.setItem('ai.shares', seedShares);

  win.fetch = makeFetch(calls);
  win.EventSource = NoopEventSource;
  win.XMLHttpRequest = FakeXHR;
  win.eval(QR_JS);
  win.eval(APP_JS);
  win.document.dispatchEvent(new win.Event('DOMContentLoaded'));
  await sleep(120);

  return { win, doc: win.document, calls };
}

function nav(doc, view) {
  doc.querySelector('.nav-item[data-view="' + view + '"]').click();
}

function dropFile(win, doc, name, type, size) {
  const file = new win.File([new Array(size || 1024).fill('x').join('')], name, { type: type });
  const ev = new win.Event('drop', { bubbles: true, cancelable: true });
  ev.dataTransfer = { files: [file] };
  doc.getElementById('share-drop').dispatchEvent(ev);
  return file;
}

(async () => {
  /* ---------- 场景 1：首次进入发文件页 ---------- */
  console.log('\n[1] 首次进入「发文件」页');
  const A = await boot(null);
  nav(A.doc, 'files');
  await sleep(60);
  ok('拖拽区显示', A.doc.getElementById('share-drop').hidden === false);
  ok('结果卡片隐藏', A.doc.getElementById('share-result').hidden === true);
  ok('历史区块隐藏（无记录）', A.doc.getElementById('share-history').hidden === true);

  /* ---------- 场景 2：上传完成后切页返回 ---------- */
  console.log('\n[2] 上传完成后，切到聊天再切回');
  dropFile(A.win, A.doc, '报表.pdf', 'application/pdf', 2048);
  await sleep(80);
  const xhrA = FakeXHR.instances[FakeXHR.instances.length - 1];
  ok('已发起 R2 PUT 请求', Boolean(xhrA && xhrA.sent), xhrA && xhrA.url);
  xhrA.finish(200);
  await sleep(120);

  const srUrl = A.doc.getElementById('sr-url');
  ok('结果卡片显示', A.doc.getElementById('share-result').hidden === false);
  ok('链接已填入', srUrl.value === PUBLIC_URL, srUrl.value.slice(0, 42) + '…');
  ok('二维码已生成', A.doc.getElementById('sr-qr').innerHTML.indexOf('<svg') >= 0);
  ok('历史新增 1 条', A.doc.querySelectorAll('#sh-list .sh-row').length === 1);

  nav(A.doc, 'chat');
  await sleep(60);
  ok('切到聊天后发文件视图隐藏', A.doc.getElementById('view-files').hidden === true);

  nav(A.doc, 'files');
  await sleep(60);
  ok('切回后结果卡片仍在', A.doc.getElementById('share-result').hidden === false, '这是本次修复的核心');
  ok('切回后链接仍可读', A.doc.getElementById('sr-url').value === PUBLIC_URL);
  ok('切回后二维码仍在', A.doc.getElementById('sr-qr').innerHTML.indexOf('<svg') >= 0);
  ok('切回后历史仍为 1 条', A.doc.querySelectorAll('#sh-list .sh-row').length === 1);

  /* ---------- 场景 3：刷新页面后恢复 ---------- */
  console.log('\n[3] 模拟刷新（重新加载页面，沿用 localStorage）');
  const saved = A.win.localStorage.getItem('ai.shares');
  ok('已写入 localStorage', typeof saved === 'string' && saved.indexOf(PUBLIC_URL) >= 0);
  const B = await boot(saved);
  nav(B.doc, 'files');
  await sleep(60);
  ok('刷新后结果卡片自动恢复', B.doc.getElementById('share-result').hidden === false);
  ok('刷新后链接一致', B.doc.getElementById('sr-url').value === PUBLIC_URL);
  ok('刷新后二维码重建', B.doc.getElementById('sr-qr').innerHTML.indexOf('<svg') >= 0);

  /* ---------- 场景 4：「再传一个」只清当前结果 ---------- */
  console.log('\n[4] 点击「再传一个」');
  B.doc.getElementById('sr-again').click();
  await sleep(60);
  ok('结果卡片被清空', B.doc.getElementById('share-result').hidden === true);
  ok('拖拽区回来', B.doc.getElementById('share-drop').hidden === false);
  ok('历史记录保留', B.doc.querySelectorAll('#sh-list .sh-row').length === 1);

  /* ---------- 场景 5：上传中切页不中断（XHR 场景隔离） ---------- */
  console.log('\n[5] 聊天附件上传中，切到「发文件」页');
  const C = await boot(null);
  const inp = C.doc.getElementById('chat-file');
  const chatFile = new C.win.File([new Array(4096).fill('y').join('')], '日志.txt', { type: 'text/plain' });
  Object.defineProperty(inp, 'files', { value: [chatFile], configurable: true });
  inp.dispatchEvent(new C.win.Event('change'));
  await sleep(100);
  const chatXhr = FakeXHR.instances[FakeXHR.instances.length - 1];
  ok('聊天上传已开始', Boolean(chatXhr && chatXhr.sent));

  nav(C.doc, 'files');
  await sleep(80);
  ok('切页后聊天上传未被中断', chatXhr.aborted === false, '修复前这里会被 abort');

  chatXhr.finish(200);
  await sleep(150);
  const posted = C.calls.filter((c) => c === 'POST /api/messages').length;
  ok('聊天附件仍成功发出', posted === 1, 'POST /api/messages x' + posted);
  ok('消息包含文件字段', C.doc.querySelectorAll('.msg .file-card').length === 1);

  /* ---------- 场景 6：过期记录 ---------- */
  console.log('\n[6] 过期文件的历史记录');
  const expiredShare = JSON.stringify([
    { key: 's/old/x', name: '过期.pdf', size: 100, mime: 'application/pdf', url: 'https://files.frkang.top/s/old/x', expireAt: Date.now() - 86400000, by: 'admin', at: Date.now() - 8 * 86400000 },
  ]);
  const D = await boot(expiredShare);
  nav(D.doc, 'files');
  await sleep(60);
  const rowD = D.doc.querySelector('#sh-list .sh-row');
  ok('过期记录标红样式', Boolean(rowD && rowD.className.indexOf('is-expired') >= 0));
  ok('过期记录不提供复制', !rowD.querySelector('.sh-copy'));
  ok('过期记录只给移除', Boolean(rowD.querySelector('.sh-del')));
  ok('过期状态文案', rowD.querySelector('.sh-sub').textContent.indexOf('已过期') >= 0, rowD.querySelector('.sh-sub').textContent);

  /* ---------- 汇总 ---------- */
  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('测试脚本异常：', err);
  process.exit(2);
});
