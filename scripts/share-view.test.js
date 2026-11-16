/* eslint-disable */
/* 发文件页状态保留 —— jsdom DOM 级回归测试
 * 依赖：npm i -D jsdom（仅本地测试用，运行镜像不含此依赖）
 * 运行：node scripts/share-view.test.js
 * 覆盖：上传后切页返回、刷新后恢复、历史列表、上传 XHR 场景隔离、云端文件列表与用量
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PROJ = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(PROJ, 'public/index.html'), 'utf8');
const APP_JS = fs.readFileSync(path.join(PROJ, 'public/js/app.js'), 'utf8');
const QR_JS = fs.readFileSync(path.join(PROJ, 'public/js/vendor/qrcode.js'), 'utf8');

const PUBLIC_URL = 'https://files.frkang.top/s/abc123/%E6%8A%A5%E8%A1%A8.pdf';
// 删除后让 mock 的列表真的少一条，才能验证「删完列表跟着变」
const deletedKeys = new Set();
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

function makeFetch(log, role) {
  const meRole = role || 'admin';
  return function (url, opts) {
    const method = (opts && opts.method) || 'GET';
    const u = String(url);
    let data = {};
    if (u.indexOf('/api/config') === 0) {
      data = { maxOnline: 20, allowRegister: false, fileUpload: true, keepUpload: true, maxFileMB: 100, retainFileDays: 7 };
    } else if (u.split('?')[0] === '/api/me') {
      data = {
        me: { username: meRole === 'admin' ? 'admin' : 'bob', deviceName: 'jsdom', displayName: 'jsdom', role: meRole },
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
    } else if (u.indexOf('/api/files/download') === 0) {
      data = { url: 'https://r2.example/signed-get?x=1', name: '照片.png', size: 2097152, expiresIn: 300 };
    } else if (u.split('?')[0] === '/api/files' && method === 'DELETE') {
      deletedKeys.add(decodeURIComponent((u.split('key=')[1] || '')));
      data = { ok: true, key: 's/a1/照片.png', name: '照片.png' };
    } else if (u.split('?')[0] === '/api/files') {
      if (u.indexOf('store=keep') >= 0) {
        // 永久存储（Tigris）：无配额、不过期
        data = {
          store: 'keep',
          usage: {
            count: 1,
            bytes: 5242880,
            quotaBytes: null,
            percent: null,
            byScene: {
              chat: { count: 0, bytes: 0 },
              share: { count: 0, bytes: 0 },
              keep: { count: 1, bytes: 5242880 },
              other: { count: 0, bytes: 0 },
            },
          },
          objects: [
            {
              key: 'k/k1/备份.zip',
              name: '备份.zip',
              size: 5242880,
              createdAt: Date.now() - 600000,
              expireAt: 0,
              scene: 'keep',
              url: '',
            },
          ],
          truncated: false,
          cached: false,
          fetchedAt: Date.now(),
        };
      } else {
      data = {
        usage: {
          count: 2,
          bytes: 3145728,
          quotaBytes: 10737418240,
          percent: 0.03,
          byScene: {
            chat: { count: 1, bytes: 1048576 },
            share: { count: 1, bytes: 2097152 },
            other: { count: 0, bytes: 0 },
          },
        },
        objects: [
          {
            key: 's/a1/照片.png',
            name: '照片.png',
            size: 2097152,
            createdAt: Date.now() - 3600000,
            expireAt: Date.now() + 6 * 86400000,
            scene: 'share',
            url: 'https://files.frkang.top/s/a1/%E7%85%A7%E7%89%87.png',
          },
          {
            key: 'c/b2/说明.pdf',
            name: '说明.pdf',
            size: 1048576,
            createdAt: Date.now() - 7200000,
            expireAt: Date.now() + 6 * 86400000,
            scene: 'chat',
            url: 'https://files.frkang.top/c/b2/%E8%AF%B4%E6%98%8E.pdf',
          },
        ].filter((o) => !deletedKeys.has(o.key)),
        truncated: false,
        cached: false,
        fetchedAt: Date.now(),
      };
      }
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

async function boot(seedShares, role) {
  // 下载成功后会赋值 location.href，jsdom 不支持真实导航，吞掉这条噪声
  const vc = new VirtualConsole();
  vc.on('jsdomError', () => {});

  const dom = new JSDOM(HTML, {
    url: 'http://127.0.0.1:3080/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc,
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

  win.fetch = makeFetch(calls, role);
  win.EventSource = NoopEventSource;
  win.XMLHttpRequest = FakeXHR;
  win.confirm = () => true; // 删除按钮用原生 confirm，jsdom 未实现会直接返回 false
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

  /* ---------- 场景 7：云端文件列表与空间用量 ---------- */
  console.log('\n[7] 云端文件列表、预览与下载');
  const E = await boot(null);
  nav(E.doc, 'files');
  await sleep(200);

  ok('用量卡片显示', E.doc.getElementById('usage-card').hidden === false);
  ok(
    '已用空间',
    E.doc.getElementById('usage-used').textContent === '3.0 MB',
    E.doc.getElementById('usage-used').textContent,
  );
  ok(
    '占比与配额',
    E.doc.getElementById('usage-pct').textContent === '0.03%' &&
      E.doc.getElementById('usage-quota').textContent.indexOf('10.00 GB') >= 0,
    E.doc.getElementById('usage-pct').textContent,
  );
  ok(
    '分类明细含聊天与分享',
    E.doc.getElementById('usage-split').textContent.indexOf('聊天附件 1 个') >= 0 &&
      E.doc.getElementById('usage-split').textContent.indexOf('分享 1 个') >= 0,
  );

  const rows = E.doc.querySelectorAll('#cf-list .cf-row');
  ok('文件行数 2', rows.length === 2, rows.length + ' 行');
  ok('图片行渲染缩略图', Boolean(rows[0].querySelector('.cf-thumb img')));
  ok(
    '每行按钮齐全（查看/下载/链接/二维码/删除）',
    rows[0].querySelectorAll('.cf-btns button').length === 5,
    rows[0].querySelector('.cf-btns').textContent,
  );
  ok(
    '二维码按钮有提示',
    rows[0].querySelectorAll('.cf-btns button')[3].title === '扫码下载',
  );
  ok(
    '删除按钮为危险色',
    rows[0].querySelectorAll('.cf-btns button')[4].classList.contains('cf-danger'),
  );
  ok('名称与大小正确', rows[0].querySelector('.cf-name').textContent === '照片.png');

  rows[0].querySelectorAll('.cf-btns button')[0].click();
  await sleep(40);
  const pv = E.doc.getElementById('preview');
  ok('点击查看打开预览层', pv.hidden === false);
  ok('预览内容为 img', Boolean(E.doc.querySelector('#preview-body img')));
  E.doc.getElementById('preview-close').click();
  await sleep(30);
  ok('关闭预览', pv.hidden === true);

  rows[1].querySelectorAll('.cf-btns button')[1].click();
  await sleep(120);
  ok('点击下载调用签名接口', E.calls.indexOf('GET /api/files/download') >= 0, E.calls.join(','));

  /* ---------- 场景 8：扫码下载与删除 ---------- */
  console.log('\n[8] 每行的二维码与删除');
  const rowA = E.doc.querySelectorAll('#cf-list .cf-row')[0];
  rowA.querySelectorAll('.cf-btns button')[3].click();
  await sleep(60);
  const qrModal = E.doc.getElementById('qr-modal');
  ok('二维码弹层打开', qrModal.hidden === false);
  ok('二维码已渲染', E.doc.getElementById('qr-canvas').innerHTML.indexOf('<svg') >= 0);
  const qrUrl = E.doc.getElementById('qr-url').value;
  ok(
    '二维码指向扫码下载入口',
    qrUrl.indexOf('/api/files/scan?key=') > 0 && qrUrl.indexOf(encodeURIComponent('s/a1/照片.png')) > 0,
    qrUrl,
  );
  ok('弹层显示文件名', E.doc.getElementById('qr-file').textContent === '照片.png');
  E.doc.getElementById('qr-close').click();
  await sleep(30);
  ok('二维码弹层关闭', qrModal.hidden === true);

  const before = E.doc.querySelectorAll('#cf-list .cf-row').length;
  E.doc.querySelectorAll('#cf-list .cf-row')[0].querySelectorAll('.cf-btns button')[4].click();
  await sleep(200);
  ok('删除走 DELETE 接口', E.calls.indexOf('DELETE /api/files') >= 0, E.calls.join(','));
  ok(
    '删除后列表少一条',
    E.doc.querySelectorAll('#cf-list .cf-row').length === before - 1,
    before + ' → ' + E.doc.querySelectorAll('#cf-list .cf-row').length,
  );
  ok('删除后有提示', E.doc.getElementById('toast').textContent.indexOf('已删除') === 0);

  /* ---------- 场景 9：普通成员看不到云端文件 ---------- */
  console.log('\n[9] 普通成员（无云端文件权限）');
  const M = await boot(null, 'member');
  nav(M.doc, 'files');
  await sleep(80);
  ok('上传区对成员可见', M.doc.getElementById('share-drop').hidden === false);
  ok('顶部页签对成员可见（控制上传去向）', M.doc.getElementById('cf-tabs').hidden === false);
  ok('云端文件区隐藏', M.doc.getElementById('cloud-files').hidden === true);
  ok('空间用量卡片隐藏', M.doc.getElementById('usage-card').hidden === true);
  ok('成员根本没请求列表接口', M.calls.indexOf('GET /api/files') < 0, M.calls.join(','));

  /* ---------- 场景 10：临时 / 永久存储页签 ---------- */
  console.log('\n[10] 永久存储（Tigris）页签');
  ok('页签位于页面顶部（不在云端列表内）',
    E.doc.getElementById('cf-tabs').closest('#cloud-files') === null &&
      E.doc.getElementById('cf-tabs').nextElementSibling.classList.contains('files-body'));
  ok('永久页签可见（服务端上报 keepUpload）', E.doc.getElementById('cf-tab-keep').hidden === false);
  E.doc.getElementById('cf-tab-keep').click();
  await sleep(120);
  ok('切换后列表为永久存储内容', E.doc.getElementById('cf-list').textContent.indexOf('备份.zip') >= 0);
  ok('永久文件不过期', E.doc.getElementById('cf-list').textContent.indexOf('永久保存') >= 0);
  ok(
    '用量卡片按无配额展示',
    E.doc.getElementById('usage-quota').textContent.indexOf('永久保存') >= 0,
    E.doc.getElementById('usage-quota').textContent,
  );
  E.doc.getElementById('cf-tab-tmp').click();
  await sleep(120);
  // 场景 8 已删除「照片.png」，临时列表应只剩「说明.pdf」
  ok(
    '切回临时页签列表恢复',
    E.doc.getElementById('cf-list').textContent.indexOf('说明.pdf') >= 0 &&
      E.doc.getElementById('cf-list').textContent.indexOf('备份.zip') < 0,
  );

  /* ---------- 汇总 ---------- */
  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('测试脚本异常：', err);
  process.exit(2);
});
