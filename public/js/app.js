(function () {
  'use strict';

  var POLL_MS = 3000;
  var HEARTBEAT_MS = 5000;
  var INITIAL_LIMIT = 3;
  var MAX_CONTENT = 2000;

  var STORAGE = {
    username: 'ai.username',
    device: 'ai.deviceName',
    session: 'ai.sessionId',
    limit: 'ai.displayLimit',
    shares: 'ai.shares',
  };

  // 「最近分享」本地保留条数
  var SHARE_HISTORY_MAX = 10;

  var COPY_ICON =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5"/></svg>';
  var CHECK_ICON =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.4l3 3 6-6.4"/></svg>';

  var state = {
    sessionId: null,
    me: null,
    cursor: 0,
    online: 0,
    maxOnline: 20,
    displayLimit: 50,
    seen: new Set(),
    list: [],
    polling: false,
    sending: false,
    connected: true,
    authMode: 'login',
    allowRegister: false,
    stream: null,
    sseOk: false,
    sseErrors: 0,
    pollTimer: null,
    beatTimer: null,
    users: [],
    editingUser: null,
    fileUpload: false,
    maxFileMB: 100,
    retainFileDays: 7,
    // 发文件页：当前结果与本地历史（null 表示尚未从 localStorage 载入）
    lastShare: null,
    shareHistory: null,
    // 上传中的 XHR 按场景隔离：聊天附件与发文件互不干扰
    uploadXhrs: { chat: null, share: null },
    // 云端文件（R2 桶内实际对象）与空间占用
    files: null,
    filesUsage: null,
    filesAt: 0,
    filesLoading: false,
    previewing: null,
    qrItem: null,
    // 云端文件当前页签：tmp = R2 临时（7 天）/ keep = Tigris 永久
    fileStore: 'tmp',
    keepUpload: false,
    // 云端目录：当前所在文件夹，以及每个存储各自的位置（切页签时恢复）
    folder: '',
    folderByStore: { tmp: '', keep: '' },
    subFolders: [],
    crumbs: [],
    // 目录弹层：newfolder（新建文件夹）/ move（移动文件）
    fsMode: '',
    fsKey: '',
    // 在线成员（服务器推名单，点头像发文件）
    members: [],
    // 点对点传文件会话：{ role:'send'|'recv', target, phase, pc, dc, blob, meta, ... }
    peerSession: null,
  };

  var el = {};

  function $(id) {
    return document.getElementById(id);
  }

  function cacheElements() {
    el.loginView = $('login-view');
    el.appView = $('app-view');
    el.authForm = $('auth-form');
    el.authUsername = $('auth-username');
    el.authPassword = $('auth-password');
    el.authDevice = $('auth-device');
    el.authError = $('auth-error');
    el.authSubmit = $('auth-submit');
    el.deviceField = $('device-field');
    el.loginFoot = $('login-foot');
    el.meAvatar = $('me-avatar');
    el.meName = $('me-name');
    el.meDevice = $('me-device');
    el.connDot = $('conn-dot');
    el.connText = $('conn-text');
    el.nav = $('nav');
    el.viewChat = $('view-chat');
    el.viewSettings = $('view-settings');
    el.messages = $('messages');
    el.jumpNew = $('jump-new');
    el.input = $('input');
    el.send = $('send');
    el.counter = $('counter');
    el.onlinePill = $('online-pill');
    el.toast = $('toast');
    el.setUsername = $('set-username');
    el.setCurrent = $('set-current');
    el.setNew = $('set-new');
    el.setConfirm = $('set-confirm');
    el.accountMsg = $('account-msg');
    el.saveAccount = $('save-account');
    el.setLimit = $('set-limit');
    el.setDevice = $('set-device');
    el.setOrigin = $('set-origin');
    el.aboutOnline = $('about-online');
    el.aboutRetain = $('about-retain');
    el.clearLocal = $('clear-local');
    el.logout = $('logout');
    el.cardUsers = $('card-users');
    el.userName = $('user-name');
    el.userPassword = $('user-password');
    el.userPasswordHint = $('user-password-hint');
    el.userRole = $('user-role');
    el.userMsg = $('user-msg');
    el.userSubmit = $('user-submit');
    el.userCancel = $('user-cancel');
    el.userList = $('user-list');

    el.attach = $('attach');
    el.chatFile = $('chat-file');
    el.uploadQueue = $('upload-queue');
    el.navFiles = $('nav-files');
    el.viewFiles = $('view-files');
    el.filesRetain = $('files-retain');
    el.shareDrop = $('share-drop');
    el.shareFile = $('share-file');
    el.shareHint = $('share-hint');
    el.shareProgress = $('share-progress');
    el.spName = $('sp-name');
    el.spPct = $('sp-pct');
    el.spFill = $('sp-fill');
    el.spMeta = $('sp-meta');
    el.spCancel = $('sp-cancel');
    el.shareResult = $('share-result');
    el.shareHistory = $('share-history');
    el.shareHistoryList = $('sh-list');
    el.srIcon = $('sr-icon');
    el.srName = $('sr-name');
    el.srSub = $('sr-sub');
    el.srUrl = $('sr-url');
    el.srCopy = $('sr-copy');
    el.srQr = $('sr-qr');
    el.srAgain = $('sr-again');
    el.srOpen = $('sr-open');
    el.usageCard = $('usage-card');
    el.usageUsed = $('usage-used');
    el.usageQuota = $('usage-quota');
    el.usagePct = $('usage-pct');
    el.usageFill = $('usage-fill');
    el.usageSplit = $('usage-split');
    el.filesRefresh = $('files-refresh');
    el.cloudFiles = $('cloud-files');
    el.cloudList = $('cf-list');
    el.cloudSub = $('cf-sub');
    el.cloudEmpty = $('cf-empty');
    el.cfTabs = $('cf-tabs');
    el.cfTabTmp = $('cf-tab-tmp');
    el.cfTabKeep = $('cf-tab-keep');
    el.cfCrumbs = $('cf-crumbs');
    el.cfNewFolder = $('cf-newfolder');
    el.shareTarget = $('share-target');
    el.fsModal = $('fs-modal');
    el.fsMask = $('fs-mask');
    el.fsTitle = $('fs-title');
    el.fsHint = $('fs-hint');
    el.fsInput = $('fs-input');
    el.fsList = $('fs-list');
    el.fsOk = $('fs-ok');
    el.fsCancel = $('fs-cancel');
    el.fsClose = $('fs-close');
    el.preview = $('preview');
    el.previewMask = $('preview-mask');
    el.previewName = $('preview-name');
    el.previewBody = $('preview-body');
    el.previewMeta = $('preview-meta');
    el.previewClose = $('preview-close');
    el.previewDownload = $('preview-download');
    el.qrModal = $('qr-modal');
    el.qrMask = $('qr-mask');
    el.qrClose = $('qr-close');
    el.qrCanvas = $('qr-canvas');
    el.qrFile = $('qr-file');
    el.qrUrl = $('qr-url');
    el.qrCopy = $('qr-copy');
    el.onlineChips = $('online-chips');
    el.sendModal = $('send-modal');
    el.sendMask = $('send-mask');
    el.sendTitle = $('send-title');
    el.sendBody = $('send-body');
    el.sendOk = $('send-ok');
    el.sendCancel = $('send-cancel');
    el.sendClose = $('send-close');
    el.sendFile = $('send-file');
    el.sendFolder = $('send-folder');
  }

  /* ---------------- 通用 ---------------- */

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      try {
        return window.crypto.randomUUID();
      } catch (err) {
        /* fallthrough */
      }
    }
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function firstChar(text) {
    var chars = Array.from(String(text || '?').trim());
    if (!chars.length) return '?';
    var head = chars[0];
    return /[a-z]/.test(head) ? head.toUpperCase() : head;
  }

  function formatTime(ts) {
    var date = new Date(ts);
    var now = new Date();
    function pad(n) {
      return n < 10 ? '0' + n : String(n);
    }
    var hm = pad(date.getHours()) + ':' + pad(date.getMinutes());
    if (date.toDateString() === now.toDateString()) return hm;
    var yesterday = new Date(now.getTime() - 86400000);
    if (date.toDateString() === yesterday.toDateString()) return '昨天 ' + hm;
    return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + hm;
  }

  function toast(text) {
    el.toast.textContent = text;
    el.toast.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () {
      el.toast.hidden = true;
    }, 1800);
  }

  function detectDeviceName() {
    var ua = navigator.userAgent || '';
    var os = 'Web';
    if (/Windows/i.test(ua)) os = 'Windows';
    else if (/iPad/i.test(ua)) os = 'iPad';
    else if (/iPhone|iPod/i.test(ua)) os = 'iPhone';
    else if (/Android/i.test(ua)) os = 'Android';
    else if (/Mac OS X/i.test(ua)) os = 'Mac';
    else if (/Linux/i.test(ua)) os = 'Linux';
    var browser = 'Browser';
    if (/Edg\//i.test(ua)) browser = 'Edge';
    else if (/OPR\//i.test(ua)) browser = 'Opera';
    else if (/Firefox\//i.test(ua)) browser = 'Firefox';
    else if (/Chrome\//i.test(ua)) browser = 'Chrome';
    else if (/Safari/i.test(ua)) browser = 'Safari';
    return (os + '-' + browser).slice(0, 20);
  }

  /* ---------------- 请求 ---------------- */

  function api(method, path, body) {
    var headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (state.sessionId) headers['X-Session-Id'] = state.sessionId;

    return fetch(path, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return null;
        })
        .then(function (data) {
          if (res.ok) return data;
          if (res.status === 401 && state.sessionId) {
            handleSessionExpired();
          }
          var message = (data && data.error && data.error.message) || '请求失败（' + res.status + '）';
          var err = new Error(message);
          err.status = res.status;
          err.code = data && data.error ? data.error.code : '';
          throw err;
        });
    });
  }

  function handleSessionExpired() {
    if (!state.sessionId) return;
    stopTimers();
    state.sessionId = null;
    state.me = null;
    localStorage.removeItem(STORAGE.session);
    showLogin('登录已过期，请重新登录');
  }

  /* ---------------- 登录 ---------------- */

  function showLogin(message) {
    el.loginView.hidden = false;
    el.appView.hidden = true;
    el.authPassword.value = '';
    showAuthError(message || '');
    setTimeout(function () {
      el.authPassword.focus();
    }, 60);
  }

  function showAuthError(text) {
    if (!text) {
      el.authError.hidden = true;
      el.authError.textContent = '';
      return;
    }
    el.authError.hidden = false;
    el.authError.textContent = text;
  }

  function setAuthMode(mode) {
    if (mode === 'register' && !state.allowRegister) mode = 'login';
    state.authMode = mode;
    var tabs = el.loginView.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i += 1) {
      tabs[i].classList.toggle('is-active', tabs[i].dataset.mode === mode);
    }
    el.deviceField.hidden = mode === 'register';
    el.authSubmit.textContent = mode === 'register' ? '创建并登录' : '进入';
    showAuthError('');
  }

  function setAuthBusy(busy) {
    el.authSubmit.disabled = busy;
    el.authSubmit.textContent = busy
      ? '处理中…'
      : state.authMode === 'register'
        ? '创建并登录'
        : '进入';
  }

  // 服务端开关：自助注册关闭时，隐藏「创建账号」页签并强制停在登录态
  function applyRegisterPolicy(allow) {
    state.allowRegister = !!allow;
    var tabs = el.loginView.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i += 1) {
      if (tabs[i].dataset.mode === 'register') tabs[i].hidden = !state.allowRegister;
    }
    if (el.loginFoot && !state.allowRegister) {
      el.loginFoot.textContent =
        '最多 ' + state.maxOnline + ' 台设备同时在线 · 账号由管理员统一创建';
    }
    if (!state.allowRegister && state.authMode === 'register') setAuthMode('login');
  }

  // 服务端未配置 R2 时整体隐藏文件入口，功能消失但不影响消息收发
  function applyFilePolicy(cfg) {
    state.fileUpload = Boolean(cfg && cfg.fileUpload);
    state.keepUpload = Boolean(cfg && cfg.keepUpload);
    if (cfg && typeof cfg.maxFileMB === 'number' && cfg.maxFileMB > 0) {
      state.maxFileMB = cfg.maxFileMB;
    }
    if (cfg && typeof cfg.retainFileDays === 'number' && cfg.retainFileDays > 0) {
      state.retainFileDays = cfg.retainFileDays;
    }
    if (el.attach) el.attach.hidden = !state.fileUpload;
    if (el.navFiles) el.navFiles.hidden = !state.fileUpload;
    if (el.filesRetain) el.filesRetain.textContent = String(state.retainFileDays);
    if (el.shareHint) syncShareHint();
    if (el.cfTabs) el.cfTabs.hidden = !state.fileUpload;
    if (el.cfTabKeep) el.cfTabKeep.hidden = !state.keepUpload;
    // 永久存储被关闭时退回临时页签
    if (!state.keepUpload && state.fileStore === 'keep') switchStore('tmp');
    if (!state.fileUpload) {
      if (el.usageCard) el.usageCard.hidden = true;
      if (el.cloudFiles) el.cloudFiles.hidden = true;
    }
    syncCloudVisibility();
  }

  // 云端文件列表（含空间用量）只对管理员开放：服务端也会拦，
  // 这里同步隐藏入口，普通成员连请求都不发。
  function canSeeCloudFiles() {
    return Boolean(state.fileUpload) && isAdmin();
  }

  function syncCloudVisibility() {
    if (canSeeCloudFiles()) return true;
    if (el.usageCard) el.usageCard.hidden = true;
    if (el.cloudFiles) el.cloudFiles.hidden = true;
    if (el.cloudList) el.cloudList.textContent = '';
    return false;
  }

  function handleAuthSubmit(event) {
    event.preventDefault();
    var username = el.authUsername.value.trim();
    var password = el.authPassword.value;
    var deviceName = el.authDevice.value.trim() || detectDeviceName();

    showAuthError('');
    if (state.authMode === 'register' && !state.allowRegister) {
      setAuthMode('login');
      showAuthError('自助注册已关闭，请联系管理员开通账号');
      return;
    }
    if (!username || !password) {
      showAuthError('请填写用户名和密码');
      return;
    }

    setAuthBusy(true);
    var step = state.authMode === 'register'
      ? api('POST', '/api/register', { username: username, password: password })
      : Promise.resolve(null);

    step
      .then(function () {
        return api('POST', '/api/login', {
          username: username,
          password: password,
          deviceName: deviceName,
        });
      })
      .then(function (data) {
        state.sessionId = data.sessionId;
        localStorage.setItem(STORAGE.session, data.sessionId);
        localStorage.setItem(STORAGE.username, data.me.username);
        localStorage.setItem(STORAGE.device, data.me.deviceName);
        return enterApp(data);
      })
      .catch(function (err) {
        showAuthError(err.message || '登录失败');
      })
      .then(function () {
        setAuthBusy(false);
      });
  }

  /* ---------------- 应用 ---------------- */

  function enterApp(data) {
    state.me = data.me;
    state.online = data.online || 1;
    if (data.limits) state.maxOnline = data.limits.maxOnline || 20;

    el.loginView.hidden = true;
    el.appView.hidden = false;

    el.meName.textContent = data.me.username;
    el.meDevice.textContent = data.me.deviceName;
    el.meAvatar.textContent = firstChar(data.me.username);
    el.authDevice.value = data.me.deviceName;

    // 角色这时才知道，云端文件区按角色显隐
    if (!canSeeCloudFiles()) {
      state.files = [];
      state.filesUsage = null;
      state.filesAt = 0;
    }
    syncCloudVisibility();

    updateOnline(state.online);
    setConnected(true);
    switchView(
      window.location.hash === '#settings'
        ? 'settings'
        : window.location.hash === '#files'
          ? 'files'
          : 'chat',
    );

    return loadInitial().then(function () {
      startTimers();
    });
  }

  function loadInitial() {
    return api('GET', '/api/messages?limit=' + INITIAL_LIMIT)
      .then(function (data) {
        replaceMessages(data.messages || []);
        state.cursor = data.cursor || 0;
        updateOnline(data.online);
        updateMembers(data.members);
        setConnected(true);
      })
      .catch(function (err) {
        if (err.status === 401) return;
        setConnected(false);
        toast('加载消息失败：' + err.message);
      });
  }

  /* ---------------- 实时通道：SSE 优先，失败回落轮询 ---------------- */

  function parseEvent(event) {
    try {
      return JSON.parse(event.data);
    } catch (err) {
      return null;
    }
  }

  function streamUrl() {
    return '/api/stream?sid=' + encodeURIComponent(state.sessionId) + '&afterId=' + state.cursor;
  }

  function handleChunk(payload) {
    if (!payload) return;
    if (payload.reset) {
      replaceMessages(payload.messages || []);
    } else if (payload.messages && payload.messages.length) {
      appendMessages(payload.messages);
    }
    if (typeof payload.cursor === 'number' && payload.cursor > state.cursor) {
      state.cursor = payload.cursor;
    }
    if (typeof payload.online === 'number') updateOnline(payload.online);
  }

  function openStream() {
    if (!state.sessionId) return;
    if (!window.EventSource) {
      startPolling();
      return;
    }

    closeStream();
    var es = new EventSource(streamUrl());
    state.stream = es;

    es.addEventListener('hello', function (event) {
      state.sseOk = true;
      state.sseErrors = 0;
      stopPolling();
      setConnected(true);
      var data = parseEvent(event);
      if (data && typeof data.online === 'number') updateOnline(data.online);
      if (data && data.members) updateMembers(data.members);
    });

    es.addEventListener('backlog', function (event) {
      handleChunk(parseEvent(event));
      setConnected(true);
    });

    es.addEventListener('message', function (event) {
      var data = parseEvent(event);
      if (!data) return;
      if (data.message) appendMessages([data.message]);
      if (typeof data.online === 'number') updateOnline(data.online);
      setConnected(true);
    });

    es.addEventListener('online', function (event) {
      var data = parseEvent(event);
      if (data && typeof data.online === 'number') updateOnline(data.online);
      if (data && data.members) updateMembers(data.members);
      if (!el.viewSettings.hidden && isAdmin()) loadUsers();
    });

    es.addEventListener('peer', function (event) {
      var data = parseEvent(event);
      if (data && data.payload) handlePeerSignal(data);
    });

    es.onerror = function () {
      state.sseOk = false;
      setConnected(false);
      startPolling();
      state.sseErrors += 1;
      if (state.sseErrors >= 3) verifySession();
    };
  }

  function closeStream() {
    if (state.stream) {
      state.stream.close();
      state.stream = null;
    }
    state.sseOk = false;
  }

  function verifySession() {
    if (!state.sessionId) return;
    state.sseErrors = 0;
    api('GET', '/api/me').catch(function (err) {
      if (err.status === 401) handleSessionExpired();
    });
  }

  function startPolling() {
    if (state.pollTimer || !state.sessionId) return;
    state.pollTimer = setInterval(function () {
      if (!document.hidden) poll();
    }, POLL_MS);
  }

  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function startTimers() {
    stopTimers();
    state.beatTimer = setInterval(heartbeat, HEARTBEAT_MS);
    openStream();
  }

  function stopTimers() {
    stopPolling();
    if (state.beatTimer) clearInterval(state.beatTimer);
    state.beatTimer = null;
    closeStream();
  }

  function heartbeat() {
    if (!state.sessionId) return;
    if (state.sseOk) return;
    api('POST', '/api/heartbeat')
      .then(function (data) {
        updateOnline(data.online);
        setConnected(true);
      })
      .catch(function (err) {
        if (err.status !== 401) setConnected(false);
      });
  }

  function poll() {
    if (!state.sessionId || state.polling) return;
    state.polling = true;
    var more = false;

    api('GET', '/api/messages?afterId=' + state.cursor + '&limit=' + state.displayLimit)
      .then(function (data) {
        if (typeof data.cursor === 'number' && data.cursor > state.cursor) state.cursor = data.cursor;
        if (data.reset) {
          replaceMessages(data.messages || []);
        } else if (data.messages && data.messages.length) {
          appendMessages(data.messages);
          more = data.messages.length >= state.displayLimit;
        }
        updateOnline(data.online);
        updateMembers(data.members);
        setConnected(true);
      })
      .catch(function (err) {
        if (err.status !== 401) setConnected(false);
      })
      .then(function () {
        state.polling = false;
        if (more) setTimeout(poll, 120);
      });
  }

  function updateOnline(count) {
    if (typeof count === 'number') state.online = count;
    var text = state.online + ' / ' + state.maxOnline;
    el.onlinePill.textContent = text;
    el.aboutOnline.textContent = text + ' 台';
    el.connText.textContent = (state.connected ? '已连接' : '重连中') + ' · ' + text + ' 在线';
  }

  function setConnected(ok) {
    if (state.connected === ok) return;
    state.connected = ok;
    el.connDot.classList.toggle('is-off', !ok);
    updateOnline();
  }

  /* ---------------- 消息渲染 ---------------- */

  function isNearBottom() {
    var box = el.messages;
    return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  }

  function scrollToBottom() {
    el.messages.scrollTop = el.messages.scrollHeight;
    el.jumpNew.hidden = true;
  }

  function showEmpty() {
    if (el.messages.querySelector('.empty')) return;
    var div = document.createElement('div');
    div.className = 'empty';
    var strong = document.createElement('strong');
    strong.textContent = '还没有消息';
    div.appendChild(strong);
    div.appendChild(document.createTextNode('在下方输入框发送第一条消息，所有在线成员都能看到。'));
    el.messages.appendChild(div);
  }

  function removeEmpty() {
    var empty = el.messages.querySelector('.empty');
    if (empty) empty.remove();
  }

  function renderText(container, content) {
    var parts = String(content).split(/(https?:\/\/[^\s<>"']+)/g);
    parts.forEach(function (part) {
      if (!part) return;
      if (/^https?:\/\//.test(part)) {
        var link = document.createElement('a');
        link.href = part;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = part;
        container.appendChild(link);
      } else {
        container.appendChild(document.createTextNode(part));
      }
    });
  }

  function buildMessage(message) {
    var row = document.createElement('div');
    row.className = 'msg';
    if (state.me && message.deviceKey === state.me.deviceKey) row.classList.add('is-self');
    row.dataset.id = message.id;

    var avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.textContent = firstChar(message.username);

    var body = document.createElement('div');
    body.className = 'msg-body';

    var head = document.createElement('div');
    head.className = 'msg-head';

    var name = document.createElement('span');
    name.className = 'msg-name';
    name.textContent = message.username;

    var device = document.createElement('span');
    device.className = 'msg-device';
    device.textContent = message.deviceName;

    var time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = formatTime(message.createdAt);

    head.appendChild(name);
    head.appendChild(device);
    // 私发消息标记：只有双方能看到这条
    if (message.to) {
      var tag = document.createElement('span');
      tag.className = 'msg-private';
      tag.textContent = message.username === (state.me && state.me.username) ? '私发·' + message.to : '私发';
      head.appendChild(tag);
    }
    head.appendChild(time);

    var text = document.createElement('div');
    text.className = 'msg-text';
    renderText(text, message.content);

    body.appendChild(head);

    // 纯附件消息的 content 是文件名兜底，正文与卡片重复，省掉正文
    var hasFile = Boolean(message.file && message.file.url);
    var textIsName = hasFile && message.content === message.file.name;
    if (!textIsName) body.appendChild(text);
    if (hasFile) body.appendChild(buildFileCard(message.file));

    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'msg-copy';
    copy.title = '复制这条消息';
    copy.setAttribute('aria-label', '复制这条消息');
    copy.innerHTML = COPY_ICON;
    copy.addEventListener('click', function () {
      copyMessage(message.content, copy);
    });

    row.appendChild(avatar);
    row.appendChild(body);
    row.appendChild(copy);
    return row;
  }

  function trimToLimit() {
    var rows = el.messages.querySelectorAll('.msg');
    var overflow = rows.length - state.displayLimit;
    for (var i = 0; i < overflow; i += 1) {
      if (rows[i] && rows[i].parentNode) rows[i].parentNode.removeChild(rows[i]);
    }
    if (overflow > 0) state.list = state.list.slice(overflow);
  }

  function appendMessages(list) {
    if (!list || !list.length) return;
    var nearBottom = isNearBottom();
    var added = 0;

    list.forEach(function (message) {
      if (state.seen.has(message.id)) return;
      state.seen.add(message.id);
      state.list.push(message);
      el.messages.appendChild(buildMessage(message));
      added += 1;
    });

    if (!added) return;
    removeEmpty();
    trimToLimit();
    if (typeof list[list.length - 1].id === 'number' && list[list.length - 1].id > state.cursor) {
      state.cursor = list[list.length - 1].id;
    }
    if (nearBottom) scrollToBottom();
    else el.jumpNew.hidden = false;
  }

  function replaceMessages(list) {
    el.messages.textContent = '';
    state.list = [];
    state.seen = new Set();

    if (!list || !list.length) {
      showEmpty();
      return;
    }
    list.forEach(function (message) {
      state.seen.add(message.id);
      state.list.push(message);
      el.messages.appendChild(buildMessage(message));
    });
    trimToLimit();
    scrollToBottom();
  }

  function copyMessage(content, button) {
    var done = function () {
      button.classList.add('is-copied');
      button.innerHTML = CHECK_ICON;
      toast('已复制');
      setTimeout(function () {
        button.classList.remove('is-copied');
        button.innerHTML = COPY_ICON;
      }, 1200);
    };

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(content).then(done, function () {
        legacyCopy(content, done);
      });
      return;
    }
    legacyCopy(content, done);
  }

  function legacyCopy(content, done) {
    var area = document.createElement('textarea');
    area.value = content;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
      done();
    } catch (err) {
      toast('复制失败，请手动选择文本');
    }
    document.body.removeChild(area);
  }

  /* ---------------- 发送 ---------------- */

  function updateCounter() {
    var length = Array.from(el.input.value).length;
    el.counter.textContent = length + ' / ' + MAX_CONTENT;
    el.counter.classList.toggle('is-over', length > MAX_CONTENT);
  }

  function autoGrow() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 132) + 'px';
  }

  function updateSendState() {
    el.send.disabled = state.sending || !el.input.value.trim();
  }

  function sendMessage() {
    var content = el.input.value.trim();
    if (!content || state.sending) return;
    state.sending = true;
    updateSendState();

    api('POST', '/api/messages', { content: content, clientMsgId: uuid() })
      .then(function (data) {
        el.input.value = '';
        autoGrow();
        updateCounter();
        if (data.message) {
          appendMessages([data.message]);
          if (data.message.id > state.cursor) state.cursor = data.message.id;
          scrollToBottom();
        }
        updateOnline(data.online);
        setConnected(true);
      })
      .catch(function (err) {
        if (err.status === 401) return;
        toast(err.message || '发送失败');
      })
      .then(function () {
        state.sending = false;
        updateSendState();
        el.input.focus();
      });
  }

  /* ---------------- 文件 ---------------- */

  function fmtSize(bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function fileExt(name) {
    var m = /\.([A-Za-z0-9]{1,6})$/.exec(String(name || ''));
    return m ? m[1].toUpperCase() : 'FILE';
  }

  function isImageMime(mime) {
    return typeof mime === 'string' && mime.indexOf('image/') === 0;
  }

  function expireText(ts) {
    var n = Number(ts);
    if (!n) return '永久保存';
    var left = n - Date.now();
    if (!isFinite(left) || left <= 0) return '已过期';
    var days = Math.floor(left / 86400000);
    if (days >= 1) return days + ' 天后失效';
    var hours = Math.floor(left / 3600000);
    if (hours >= 1) return hours + ' 小时后失效';
    return '即将失效';
  }

  // 先向服务端换取一次性上传许可，再由浏览器直传 R2。
  // 用 XHR 而非 fetch：只有 XHR 能读到上传进度。
  function uploadToR2(file, scene, onProgress, folder) {
    return api('POST', '/api/files/sign', {
      name: file.name,
      size: file.size,
      mime: file.type || '',
      scene: scene,
      folder: folder || '',
    }).then(function (ticket) {
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        // 按场景登记，避免一处取消/重置误杀另一处正在进行的上传
        state.uploadXhrs[scene] = xhr;
        xhr.open('PUT', ticket.uploadUrl, true);
        xhr.setRequestHeader('Content-Type', ticket.contentType);
        xhr.upload.onprogress = function (event) {
          if (event.lengthComputable && typeof onProgress === 'function') {
            onProgress(event.loaded / event.total);
          }
        };
        xhr.onload = function () {
          state.uploadXhrs[scene] = null;
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve({
              key: ticket.key,
              name: ticket.name,
              size: file.size,
              mime: ticket.contentType,
              url: ticket.publicUrl,
              expireAt: ticket.expireAt,
              store: ticket.store || (scene === 'keep' ? 'keep' : 'tmp'),
              folder: ticket.folder || '',
            });
          } else if (xhr.status === 403) {
            reject(new Error('上传许可已失效，请重试'));
          } else {
            reject(new Error('上传失败（HTTP ' + xhr.status + '）'));
          }
        };
        xhr.onerror = function () {
          state.uploadXhrs[scene] = null;
          reject(new Error('网络中断，上传失败'));
        };
        xhr.onabort = function () {
          state.uploadXhrs[scene] = null;
          reject(new Error('已取消上传'));
        };
        if (typeof onProgress === 'function') onProgress(0);
        xhr.send(file);
      });
    });
  }

  function sendFileMessage(meta, note) {
    return api('POST', '/api/messages', {
      content: note || '',
      clientMsgId: uuid(),
      file: meta,
    }).then(function (data) {
      if (data.message) appendMessages([data.message]);
      updateOnline(data.online);
      setConnected(true);
      scrollToBottom();
    });
  }

  function buildFileCard(file) {
    var expired = !file || Date.now() > Number(file.expireAt);
    var card = document.createElement('div');
    card.className = 'file-card' + (expired ? ' is-expired' : '');

    if (file && isImageMime(file.mime) && !expired) {
      var thumb = document.createElement('a');
      thumb.className = 'file-thumb';
      thumb.href = file.url;
      thumb.target = '_blank';
      thumb.rel = 'noopener';
      var img = document.createElement('img');
      img.src = file.url;
      img.alt = file.name;
      img.loading = 'lazy';
      thumb.appendChild(img);
      card.appendChild(thumb);
    }

    var main = document.createElement('div');
    main.className = 'file-main';

    var icon = document.createElement('div');
    icon.className = 'file-icon';
    icon.textContent = fileExt(file && file.name);

    var info = document.createElement('div');
    info.className = 'file-info';

    var title = document.createElement('div');
    title.className = 'file-name';
    title.textContent = (file && file.name) || '文件';
    title.title = title.textContent;

    var sub = document.createElement('div');
    sub.className = 'file-sub';
    sub.textContent = expired
      ? '已过期清理 · ' + fmtSize(file && file.size)
      : fmtSize(file && file.size) + ' · ' + expireText(file && file.expireAt);

    info.appendChild(title);
    info.appendChild(sub);
    main.appendChild(icon);
    main.appendChild(info);

    if (!expired) {
      var link = document.createElement('a');
      link.className = 'file-dl';
      link.href = file.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.setAttribute('download', file.name);
      link.textContent = '下载';
      main.appendChild(link);
    }

    card.appendChild(main);
    return card;
  }

  function buildQueueRow(file) {
    var node = document.createElement('div');
    node.className = 'queue-row';

    var name = document.createElement('span');
    name.className = 'queue-name';
    name.textContent = file.name;

    var bar = document.createElement('div');
    bar.className = 'queue-bar';
    var fill = document.createElement('div');
    fill.className = 'queue-fill';
    bar.appendChild(fill);

    var pct = document.createElement('span');
    pct.className = 'queue-pct';
    pct.textContent = '0%';

    node.appendChild(name);
    node.appendChild(bar);
    node.appendChild(pct);

    return {
      node: node,
      setProgress: function (ratio) {
        var p = Math.max(0, Math.min(1, ratio || 0));
        fill.style.width = (p * 100).toFixed(1) + '%';
        pct.textContent = Math.round(p * 100) + '%';
      },
      setDone: function () {
        node.classList.add('is-done');
        fill.style.width = '100%';
        pct.textContent = '完成';
      },
      setError: function (msg) {
        node.classList.add('is-error');
        pct.textContent = msg;
      },
    };
  }

  function removeQueueRow(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node);
    if (el.uploadQueue && !el.uploadQueue.children.length) el.uploadQueue.hidden = true;
  }

  // 聊天附件：串行上传，逐个显示进度，完成一条发一条消息
  function pickChatFiles(files) {
    if (!files || !files.length) return undefined;
    if (!state.fileUpload) {
      toast('文件上传未启用');
      return undefined;
    }
    var list = Array.prototype.slice.call(files);
    el.uploadQueue.hidden = false;

    var chain = Promise.resolve();
    list.forEach(function (file) {
      chain = chain.then(function () {
        var row = buildQueueRow(file);
        el.uploadQueue.appendChild(row.node);

        if (file.size > state.maxFileMB * 1024 * 1024) {
          row.setError('超过 ' + state.maxFileMB + ' MB');
          setTimeout(function () {
            removeQueueRow(row.node);
          }, 4000);
          return undefined;
        }

        return uploadToR2(file, 'chat', row.setProgress)
          .then(function (meta) {
            row.setDone();
            return sendFileMessage(meta, '');
          })
          .then(function () {
            removeQueueRow(row.node);
          })
          .catch(function (err) {
            if (err && err.status === 401) return;
            row.setError(err.message || '上传失败');
            setTimeout(function () {
              removeQueueRow(row.node);
            }, 6000);
          });
      });
    });
    return chain;
  }

  // 纯文本复制：本部署是 http 明文访问，Clipboard API 在非安全上下文不可用，
  // 必须回落到 execCommand。这里保留按钮文字而不替换图标。
  function copyPlain(text, button) {
    var restore = button.textContent;
    var done = function () {
      button.textContent = '已复制';
      setTimeout(function () {
        button.textContent = restore;
      }, 1400);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () {
        legacyCopy(text, done);
      });
      return;
    }
    legacyCopy(text, done);
  }

  /* ---------------- 发文件（独立分享） ---------------- */

  function syncShareHint() {
    if (!state.fileUpload) {
      el.shareHint.textContent = '文件功能未配置，请联系管理员填写存储凭据';
      el.shareDrop.classList.toggle('is-disabled', true);
      syncShareTarget();
      return;
    }
    var keep = state.fileStore === 'keep' && state.keepUpload;
    el.shareHint.textContent = keep
      ? '单个文件最大 ' + state.maxFileMB + ' MB · 永久保存（Tigris）'
      : '单个文件最大 ' + state.maxFileMB + ' MB · 文件保存 ' + state.retainFileDays + ' 天';
    el.shareDrop.classList.toggle('is-disabled', false);
    syncShareTarget();
  }

  // 上传目标：跟随云端列表当前所在目录（成员看不到目录列表，一律传根目录）
  function syncShareTarget() {
    if (!el.shareTarget) return;
    if (!state.fileUpload) {
      el.shareTarget.hidden = true;
      return;
    }
    var storeName = state.fileStore === 'keep' ? '永久存储' : '临时存储';
    var path = canSeeCloudFiles() ? state.folder || '' : '';
    el.shareTarget.hidden = false;
    el.shareTarget.textContent = '上传到：' + storeName + ' / ' + (path || '根目录');
  }

  // 「再传一个」：只清当前结果，不动本地历史
  function resetShare() {
    ['share', 'keep'].forEach(function (scene) {
      if (state.uploadXhrs[scene]) {
        try {
          state.uploadXhrs[scene].abort();
        } catch (err) {
          /* 忽略 */
        }
        state.uploadXhrs[scene] = null;
      }
    });
    state.lastShare = null;
    el.shareDrop.hidden = false;
    el.shareProgress.hidden = true;
    el.shareResult.hidden = true;
    el.shareFile.value = '';
    el.spFill.style.width = '0%';
    el.spPct.textContent = '0%';
    el.srQr.textContent = '';
    syncShareHint();
    renderShareHistory();
  }

  // 进入发文件页：恢复上次结果，而不是清空
  function enterFilesView() {
    if (state.shareHistory === null) loadShareHistory();
    var busy = Boolean(state.uploadXhrs.share);
    if (busy) {
      // 上传仍在进行：保留进度条，不要重置
      el.shareDrop.hidden = true;
      el.shareResult.hidden = true;
      el.shareProgress.hidden = false;
    } else if (state.lastShare) {
      renderShareResult(state.lastShare);
    } else {
      el.shareDrop.hidden = false;
      el.shareResult.hidden = true;
      el.shareProgress.hidden = true;
      el.srQr.textContent = '';
      syncShareHint();
    }
    renderShareHistory();
    // 缓存优先：服务端有 15 秒列表缓存，只有超过 60 秒才强刷，避免每次进页都等 R2 慢请求
    if (syncCloudVisibility()) {
      loadCloudFiles(Date.now() - state.filesAt > 60000);
    }
  }

  // 切换临时/永久存储页签：作废在途请求，清空当前列表状态，再按新存储重新拉取；
  // 上传区与最近分享同步跟随页签，保证整页都是当前存储的内容
  function switchStore(store) {
    if (store !== 'keep' && store !== 'tmp') store = 'tmp';
    if (state.fileStore === store) return;
    state.fileStore = store;
    if (el.cfTabTmp) el.cfTabTmp.classList.toggle('is-active', store === 'tmp');
    if (el.cfTabKeep) el.cfTabKeep.classList.toggle('is-active', store === 'keep');
    state.files = [];
    state.filesUsage = null;
    state.filesAt = 0;
    state.filesReqId = (state.filesReqId || 0) + 1;
    // 目录位置按存储各自记忆：从永久页签切回来时仍然停在原目录
    state.folder = state.folderByStore[store] || '';
    state.subFolders = [];
    state.crumbs = [];
    renderUsage(null);
    renderCloudFiles();
    // 上一条分享结果属于另一个存储时，重置为拖拽区，避免误导
    if (state.lastShare && (state.lastShare.store || 'tmp') !== store) {
      resetShare();
    }
    renderShareHistory();
    syncShareHint();
    loadCloudFiles(true);
  }

  // 进入子目录（path 为相对存储根的路径，'' 表示回到根目录）
  function enterFolder(path) {
    var target = String(path || '');
    if (target === state.folder) return;
    state.folder = target;
    state.folderByStore[state.fileStore === 'keep' ? 'keep' : 'tmp'] = target;
    state.files = [];
    state.subFolders = [];
    state.crumbs = [];
    state.filesAt = 0;
    state.filesReqId = (state.filesReqId || 0) + 1;
    renderCloudFiles();
    syncShareTarget();
    loadCloudFiles(false);
  }

  function shareHistoryKey() {
    return STORAGE.shares;
  }

  function loadShareHistory() {
    state.shareHistory = [];
    try {
      var raw = localStorage.getItem(shareHistoryKey());
      if (raw) {
        var parsed = JSON.parse(raw);
        if (Object.prototype.toString.call(parsed) === '[object Array]') {
          state.shareHistory = parsed
            .filter(function (item) {
              return item && typeof item.url === 'string' && typeof item.name === 'string';
            })
            .slice(0, SHARE_HISTORY_MAX);
        }
      }
    } catch (err) {
      state.shareHistory = [];
    }
    // 刷新后仍能显示上次生成的链接
    state.lastShare = state.shareHistory.length ? state.shareHistory[0] : null;
  }

  function saveShareHistory() {
    try {
      localStorage.setItem(shareHistoryKey(), JSON.stringify(state.shareHistory || []));
    } catch (err) {
      /* 隐私模式或配额满时忽略，不影响上传本身 */
    }
  }

  function pushShareHistory(meta) {
    if (state.shareHistory === null) loadShareHistory();
    var list = state.shareHistory.filter(function (item) {
      return item.url !== meta.url;
    });
    list.unshift({
      key: meta.key,
      name: meta.name,
      size: meta.size,
      mime: meta.mime,
      url: meta.url,
      expireAt: meta.expireAt,
      by: state.me ? state.me.username : '',
      at: Date.now(),
    });
    state.shareHistory = list.slice(0, SHARE_HISTORY_MAX);
    state.lastShare = meta;
    saveShareHistory();
    renderShareHistory();
  }

  function removeShareHistory(url) {
    state.shareHistory = (state.shareHistory || []).filter(function (item) {
      return item.url !== url;
    });
    if (state.lastShare && state.lastShare.url === url) {
      state.lastShare = state.shareHistory.length ? state.shareHistory[0] : null;
    }
    saveShareHistory();
    renderShareHistory();
  }

  function renderShareHistory() {
    if (!el.shareHistoryList) return;
    // 只显示当前页签对应的存储：临时页签看临时分享，永久页签看永久分享
    var cur = state.fileStore === 'keep' && state.keepUpload ? 'keep' : 'tmp';
    var items = (state.shareHistory || []).filter(function (it) {
      return (it.store || (Number(it.expireAt) > 0 ? 'tmp' : 'keep')) === cur;
    });
    el.shareHistoryList.textContent = '';
    el.shareHistory.hidden = !items.length;

    items.forEach(function (item) {
      var exp = Number(item.expireAt);
      var expired = exp > 0 && Date.now() > exp;
      var row = document.createElement('div');
      row.className = 'sh-row' + (expired ? ' is-expired' : '');

      var icon = document.createElement('span');
      icon.className = 'sh-icon';
      icon.textContent = fileExt(item.name);

      var meta = document.createElement('div');
      meta.className = 'sh-meta';
      var name = document.createElement('div');
      name.className = 'sh-name';
      name.textContent = item.name;
      name.title = item.name;
      var sub = document.createElement('div');
      sub.className = 'sh-sub';
      sub.textContent =
        fmtSize(item.size) +
        ' · ' +
        (exp > 0 ? expireText(item.expireAt) : '永久保存') +
        (item.store === 'keep' ? ' · Tigris' : '') +
        (item.folder ? ' · ' + item.folder : '');
      meta.appendChild(name);
      meta.appendChild(sub);

      var btns = document.createElement('div');
      btns.className = 'sh-btns';

      if (!expired) {
        var copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'btn-ghost btn-sm sh-copy';
        copy.textContent = '复制';
        copy.dataset.url = item.url;
        btns.appendChild(copy);

        var open = document.createElement('a');
        open.className = 'btn-ghost btn-sm';
        // 走免登录扫码入口强制 attachment 下载原名；老记录没有 key 才退回直链
        open.href = item.key ? scanDownloadUrl(item.key) : item.url;
        open.target = '_blank';
        open.rel = 'noopener';
        open.textContent = '下载';
        btns.appendChild(open);
      }

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn-ghost btn-sm sh-del';
      del.textContent = expired ? '移除' : '×';
      del.title = '从列表移除（不影响已上传的文件）';
      del.dataset.url = item.url;
      btns.appendChild(del);

      row.appendChild(icon);
      row.appendChild(meta);
      row.appendChild(btns);
      el.shareHistoryList.appendChild(row);
    });
  }

  function startShareUpload(file) {
    if (!state.fileUpload) return toast('文件上传未启用');
    if (file.size > state.maxFileMB * 1024 * 1024) {
      return toast('文件超过 ' + state.maxFileMB + ' MB');
    }
    // 当前页签决定去向：临时页签传 R2（7 天），永久页签传 Tigris（不清理）
    var scene = state.fileStore === 'keep' && state.keepUpload ? 'keep' : 'share';

    el.shareDrop.hidden = true;
    el.shareResult.hidden = true;
    el.shareProgress.hidden = false;
    el.spName.textContent = file.name;
    el.spMeta.textContent = fmtSize(file.size) + ' · 准备中';
    el.spFill.style.width = '0%';
    el.spPct.textContent = '0%';

    var startedAt = 0;
    // 上传到列表当前所在目录（成员没有目录列表，一律根目录）
    var targetFolder = canSeeCloudFiles() ? state.folder || '' : '';
    uploadToR2(
      file,
      scene,
      function (ratio) {
        var p = Math.max(0, Math.min(1, ratio || 0));
        el.spFill.style.width = (p * 100).toFixed(1) + '%';
        el.spPct.textContent = Math.round(p * 100) + '%';
        if (!startedAt && p > 0.02) startedAt = Date.now();
        if (startedAt && p < 1) {
          var speed = (file.size * p) / Math.max(0.3, (Date.now() - startedAt) / 1000);
          var remain = (file.size * (1 - p)) / Math.max(1, speed);
          el.spMeta.textContent =
            fmtSize(file.size) + ' · ' + (remain > 1 ? '剩余约 ' + Math.ceil(remain) + ' 秒' : '即将完成');
        } else if (p >= 1) {
          el.spMeta.textContent = fmtSize(file.size) + ' · 生成链接…';
        }
      },
      targetFolder,
    )
      .then(function (meta) {
        pushShareHistory(meta);
        renderShareResult(meta);
        // 新对象已落到桶里，刷新用量与云端列表
        loadCloudFiles(true);
      })
      .catch(function (err) {
        if (err && err.status === 401) return;
        el.shareProgress.hidden = true;
        el.shareDrop.hidden = false;
        syncShareHint();
        renderShareHistory();
        toast(err.message || '上传失败');
      });
  }

  // 免登录下载入口：302 到带 attachment 的签名链接，任何文件都直接另存原名，
  // 而公开域直链会把图片/PDF 在浏览器内打开而不是下载
  function scanDownloadUrl(key) {
    return window.location.origin + '/api/files/scan?key=' + encodeURIComponent(key);
  }

  function renderShareResult(meta) {
    if (meta) state.lastShare = meta;
    el.shareProgress.hidden = true;
    el.shareDrop.hidden = true;
    el.shareResult.hidden = false;

    el.srIcon.textContent = fileExt(meta.name);
    el.srName.textContent = meta.name;
    el.srName.title = meta.name;
    el.srSub.textContent =
      fmtSize(meta.size) +
      ' · ' +
      (Number(meta.expireAt) > 0 ? expireText(meta.expireAt) + ' · 保存 ' + state.retainFileDays + ' 天' : '永久保存 · Tigris') +
      (meta.folder ? ' · ' + meta.folder : '');
    el.srUrl.value = meta.url;
    el.srOpen.href = meta.key ? scanDownloadUrl(meta.key) : meta.url;
    el.srOpen.textContent = '下载文件';
    el.srCopy.dataset.url = meta.url;
    renderQr(meta.url);
  }

  function renderQr(url) {
    el.srQr.textContent = '';
    if (typeof window.qrcode !== 'function' || !url) return;
    try {
      var qr = window.qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      el.srQr.innerHTML = qr.createSvgTag({ cellSize: 3, margin: 1, scalable: true });
    } catch (err) {
      /* 二维码失败不影响链接使用 */
    }
  }

  /* ---------------- 云端文件（R2 桶内实际对象） ---------------- */

  // 浏览器能直接渲染的类型；其余只提供下载（HTML/SVG 已在签名时降级为二进制）
  var PREVIEW_BY_EXT = {
    jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', bmp: 'image', avif: 'image',
    mp4: 'video', webm: 'video', mov: 'video', m4v: 'video',
    mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', flac: 'audio', aac: 'audio',
    pdf: 'iframe',
    txt: 'iframe', log: 'iframe', md: 'iframe', json: 'iframe', csv: 'iframe',
  };

  function previewKind(name) {
    var m = /\.([A-Za-z0-9]{1,6})$/.exec(String(name || ''));
    if (!m) return '';
    return PREVIEW_BY_EXT[m[1].toLowerCase()] || '';
  }

  function fmtTime(ts) {
    var n = Number(ts);
    if (!isFinite(n) || n <= 0) return '—';
    var d = new Date(n);
    return (
      ('0' + (d.getMonth() + 1)).slice(-2) +
      '-' +
      ('0' + d.getDate()).slice(-2) +
      ' ' +
      ('0' + d.getHours()).slice(-2) +
      ':' +
      ('0' + d.getMinutes()).slice(-2)
    );
  }

  function renderUsage(usage) {
    if (!usage) {
      el.usageCard.hidden = true;
      return;
    }
    el.usageCard.hidden = false;
    el.usageUsed.textContent = fmtSize(usage.bytes);
    if (usage.quotaBytes) {
      // R2 免费 10GB / Tigris 免费 5GB：统一固定免费额度 + 百分比进度条
      el.usageQuota.textContent =
        '/ ' + fmtSize(usage.quotaBytes) + ' 免费额度' + (state.fileStore === 'keep' ? ' · 永久保存' : '');
      el.usagePct.textContent = usage.percent + '%';
      var width = Math.max(0, Math.min(100, Number(usage.percent) || 0));
      el.usageFill.style.width = (width > 0 && width < 1 ? 1 : width) + '%';
      el.usageFill.classList.toggle('is-warn', width >= 80);
    } else {
      // Tigris：无固定免费配额，只展示已用与对象数
      el.usageQuota.textContent = ' · ' + usage.count + ' 个文件 · 永久保存';
      el.usagePct.textContent = '';
      el.usageFill.style.width = '0%';
      el.usageFill.classList.toggle('is-warn', false);
    }

    var chat = (usage.byScene && usage.byScene.chat) || { count: 0, bytes: 0 };
    var share = (usage.byScene && usage.byScene.share) || { count: 0, bytes: 0 };
    var other = (usage.byScene && usage.byScene.other) || { count: 0, bytes: 0 };
    var parts = [
      '聊天附件 ' + chat.count + ' 个 · ' + fmtSize(chat.bytes),
      '分享 ' + share.count + ' 个 · ' + fmtSize(share.bytes),
    ];
    if (other.count) parts.push('其他 ' + other.count + ' 个 · ' + fmtSize(other.bytes));
    el.usageSplit.textContent = parts.join('　·　');
  }

  // 面包屑：根目录 / 子目录…，除末级外都可点
  function renderCrumbs() {
    if (!el.cfCrumbs) return;
    el.cfCrumbs.textContent = '';
    var crumbs = state.crumbs || [];

    var rootBtn = document.createElement('button');
    rootBtn.type = 'button';
    rootBtn.className = 'cf-crumb' + (crumbs.length ? '' : ' is-current');
    rootBtn.textContent = '根目录';
    rootBtn.title = '回到根目录';
    if (crumbs.length) {
      rootBtn.addEventListener('click', function () {
        enterFolder('');
      });
    }
    el.cfCrumbs.appendChild(rootBtn);

    crumbs.forEach(function (crumb, index) {
      var sep = document.createElement('span');
      sep.className = 'cf-sep';
      sep.textContent = '/';
      el.cfCrumbs.appendChild(sep);

      var last = index === crumbs.length - 1;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cf-crumb' + (last ? ' is-current' : '');
      btn.textContent = crumb.name;
      btn.title = crumb.path;
      if (!last) {
        btn.addEventListener('click', function () {
          enterFolder(crumb.path);
        });
      }
      el.cfCrumbs.appendChild(btn);
    });
  }

  function currentStore() {
    return state.fileStore === 'keep' && state.keepUpload ? 'keep' : 'tmp';
  }

  // 目录弹层：新建文件夹 / 移动文件共用
  function openFsModal(mode, item) {
    state.fsMode = mode;
    state.fsKey = item ? item.key : '';
    el.fsList.textContent = '';
    // 供输入框下拉提示：当前目录下的子文件夹
    (state.subFolders || []).forEach(function (dir) {
      var opt = document.createElement('option');
      opt.value = dir.path;
      el.fsList.appendChild(opt);
    });
    if (mode === 'move') {
      el.fsTitle.textContent = '移动文件';
      el.fsHint.textContent = '目标文件夹，留空表示根目录 · ' + (item ? item.name : '');
      el.fsInput.value = item && item.folder ? item.folder : '';
      el.fsOk.textContent = '移动';
    } else {
      el.fsTitle.textContent = '新建文件夹';
      el.fsHint.textContent = '可用 / 分隔建多层，例如 工作/2026';
      el.fsInput.value = state.folder ? state.folder + '/' : '';
      el.fsOk.textContent = '创建';
    }
    el.fsModal.hidden = false;
    setTimeout(function () {
      try {
        el.fsInput.focus();
      } catch (err) {
        /* 忽略 */
      }
    }, 0);
  }

  function closeFsModal() {
    state.fsMode = '';
    state.fsKey = '';
    if (el.fsModal) el.fsModal.hidden = true;
  }

  function submitFsModal() {
    var mode = state.fsMode;
    if (!mode) return;
    var value = String(el.fsInput.value || '').trim();
    var store = currentStore();
    el.fsOk.disabled = true;

    var done = function () {
      el.fsOk.disabled = false;
      closeFsModal();
    };

    if (mode === 'move') {
      var key = state.fsKey;
      if (!key) return done();
      api('POST', '/api/files/move', { key: key, folder: value }).then(
        function () {
          done();
          toast('已移动到 ' + (value || '根目录'));
          loadCloudFiles(true);
        },
        function (err) {
          el.fsOk.disabled = false;
          toast((err && err.message) || '移动失败');
        },
      );
      return;
    }

    if (!value) {
      el.fsOk.disabled = false;
      return toast('请填写文件夹名称');
    }
    api('POST', '/api/files/folder', { store: store, path: value }).then(
      function (data) {
        done();
        toast('已创建文件夹 ' + ((data && data.path) || value));
        loadCloudFiles(true);
      },
      function (err) {
        el.fsOk.disabled = false;
        toast((err && err.message) || '创建文件夹失败');
      },
    );
  }

  // 删除文件夹：非空时二次确认后连带删除（服务端按前缀批量删）
  function deleteFolder(dir) {
    var store = currentStore();
    var count = Number(dir.count) || 0;
    var tip = count
      ? '文件夹「' + dir.name + '」含 ' + count + ' 个文件（含子目录），删除后文件一并清除且不可恢复，确定删除？'
      : '确定删除空文件夹「' + dir.name + '」？';
    if (!window.confirm(tip)) return;
    api('DELETE', '/api/files/folder?store=' + store + '&path=' + encodeURIComponent(dir.path)).then(
      function (data) {
        toast('已删除文件夹' + (data && data.deleted ? '（' + data.deleted + ' 个对象）' : ''));
        // 删的正好是当前所在目录或其父级时，退回上一级
        if (state.folder === dir.path || state.folder.indexOf(dir.path + '/') === 0) {
          enterFolder('');
        } else {
          loadCloudFiles(true);
        }
      },
      function (err) {
        toast((err && err.message) || '删除文件夹失败');
      },
    );
  }

  function renderCloudFiles() {
    if (!syncCloudVisibility()) return;
    var items = state.files || [];
    var subFolders = state.subFolders || [];
    var shown = items.slice(0, 100);
    el.cloudFiles.hidden = false;
    el.cloudList.textContent = '';
    el.cloudEmpty.hidden = items.length > 0 || subFolders.length > 0;
    el.cloudSub.textContent = subFolders.length
      ? subFolders.length + ' 个文件夹 · ' + items.length + ' 个文件'
      : items.length
        ? '共 ' + items.length + ' 个' + (items.length > shown.length ? '，显示最近 ' + shown.length + ' 个' : '')
        : '';

    renderCrumbs();

    // 子文件夹：整行可点进入，右侧只有删除
    subFolders.forEach(function (dir) {
      var row = document.createElement('div');
      row.className = 'cf-row is-folder';
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.title = '进入 ' + dir.path;

      var thumb = document.createElement('div');
      thumb.className = 'cf-thumb is-folder';
      thumb.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17z"/></svg>';

      var meta = document.createElement('div');
      meta.className = 'cf-meta';
      var name = document.createElement('div');
      name.className = 'cf-name';
      name.textContent = dir.name;
      name.title = dir.path;
      var sub = document.createElement('div');
      sub.className = 'cf-folder-meta';
      sub.textContent = dir.count ? dir.count + ' 个文件 · ' + fmtSize(dir.bytes) : '空文件夹';
      meta.appendChild(name);
      meta.appendChild(sub);

      var btns = document.createElement('div');
      btns.className = 'cf-btns';
      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-ghost btn-sm cf-icon cf-danger';
      delBtn.title = '删除文件夹';
      delBtn.setAttribute('aria-label', '删除文件夹');
      delBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/>' +
        '<path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/>' +
        '<path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
      delBtn.addEventListener('click', function (event) {
        event.stopPropagation();
        deleteFolder(dir);
      });
      btns.appendChild(delBtn);

      row.addEventListener('click', function () {
        enterFolder(dir.path);
      });
      row.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          enterFolder(dir.path);
        }
      });

      row.appendChild(thumb);
      row.appendChild(meta);
      row.appendChild(btns);
      el.cloudList.appendChild(row);
    });

    shown.forEach(function (item) {
      var exp = Number(item.expireAt);
      var expired = exp > 0 && Date.now() > exp;
      var kind = previewKind(item.name);
      var row = document.createElement('div');
      row.className = 'cf-row' + (expired ? ' is-expired' : '');

      var thumb = document.createElement('div');
      thumb.className = 'cf-thumb';
      if (kind === 'image') {
        var img = document.createElement('img');
        img.src = item.url;
        img.alt = '';
        img.loading = 'lazy';
        thumb.appendChild(img);
      } else {
        thumb.textContent = fileExt(item.name);
      }

      var meta = document.createElement('div');
      meta.className = 'cf-meta';
      var name = document.createElement('div');
      name.className = 'cf-name';
      name.textContent = item.name;
      name.title = item.name;
      var sub = document.createElement('div');
      sub.className = 'cf-sub2';
      sub.textContent =
        fmtSize(item.size) +
        ' · ' +
        fmtTime(item.createdAt) +
        ' · ' +
        (exp > 0 ? (expired ? '已过期，待清理' : expireText(item.expireAt)) : '永久保存');
      meta.appendChild(name);
      meta.appendChild(sub);

      var btns = document.createElement('div');
      btns.className = 'cf-btns';

      if (kind) {
        var view = document.createElement('button');
        view.type = 'button';
        view.className = 'btn-ghost btn-sm';
        view.textContent = '查看';
        view.addEventListener('click', function () {
          openPreview(item);
        });
        btns.appendChild(view);
      }

      var dl = document.createElement('button');
      dl.type = 'button';
      dl.className = 'btn-ghost btn-sm';
      dl.textContent = '下载';
      dl.addEventListener('click', function () {
        downloadCloudFile(item, dl);
      });
      btns.appendChild(dl);

      var link = document.createElement('button');
      link.type = 'button';
      link.className = 'btn-ghost btn-sm cf-copy';
      link.textContent = '链接';
      link.title = '复制公开链接';
      link.addEventListener('click', function () {
        copyPlain(item.url, link);
      });
      btns.appendChild(link);

      var qrBtn = document.createElement('button');
      qrBtn.type = 'button';
      qrBtn.className = 'btn-ghost btn-sm cf-icon';
      qrBtn.title = '扫码下载';
      qrBtn.setAttribute('aria-label', '扫码下载');
      qrBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
        '<rect x="3" y="3" width="7" height="7" rx="1.2"/><rect x="14" y="3" width="7" height="7" rx="1.2"/>' +
        '<rect x="3" y="14" width="7" height="7" rx="1.2"/><path d="M14 14h3v3h-3z"/>' +
        '<path d="M20.5 14v.01"/><path d="M14 20.5v.01"/><path d="M20.5 20.5v.01"/><path d="M17.5 17.5v.01"/></svg>';
      qrBtn.addEventListener('click', function () {
        openQrModal(item);
      });
      btns.appendChild(qrBtn);

      var moveBtn = document.createElement('button');
      moveBtn.type = 'button';
      moveBtn.className = 'btn-ghost btn-sm cf-icon';
      moveBtn.title = '移动到文件夹';
      moveBtn.setAttribute('aria-label', '移动到文件夹');
      moveBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h3.6l2 2.5h7.4A1.5 1.5 0 0 1 19 10v1"/>' +
        '<path d="M3 17.5V10.5"/><path d="M3 17.5A1.5 1.5 0 0 0 4.5 19h5"/>' +
        '<path d="M14 15h7"/><path d="m18 12 3 3-3 3"/></svg>';
      moveBtn.addEventListener('click', function () {
        openFsModal('move', item);
      });
      btns.appendChild(moveBtn);

      var delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-ghost btn-sm cf-icon cf-danger';
      delBtn.title = '删除文件';
      delBtn.setAttribute('aria-label', '删除文件');
      delBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/>' +
        '<path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/>' +
        '<path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
      delBtn.addEventListener('click', function () {
        deleteCloudFile(item, delBtn);
      });
      btns.appendChild(delBtn);

      row.appendChild(thumb);
      row.appendChild(meta);
      row.appendChild(btns);
      el.cloudList.appendChild(row);
    });
  }

  function loadCloudFiles(force) {
    if (!state.fileUpload) return;
    // 普通成员没有权限：直接不发请求，省得每次都吃一个 403
    if (!canSeeCloudFiles()) {
      syncCloudVisibility();
      return;
    }
    var store = state.fileStore === 'keep' && state.keepUpload ? 'keep' : 'tmp';
    // 请求序号：切页签/再次刷新后，慢的在途响应直接作废，
    // 防止 A 存储的数据被渲染到 B 页签下（列表跨页签串数据的竞态）
    state.filesReqId = (state.filesReqId || 0) + 1;
    var reqId = state.filesReqId;
    state.filesLoading = true;
    el.filesRefresh.disabled = true;
    el.cloudSub.textContent = '加载中…';
    el.cloudEmpty.hidden = true;

    var folder = canSeeCloudFiles() ? state.folder || '' : '';
    var query =
      '/api/files?store=' +
      store +
      (folder ? '&folder=' + encodeURIComponent(folder) : '') +
      (force ? '&refresh=1' : '');

    api('GET', query).then(
      function (data) {
        if (reqId !== state.filesReqId) return;
        state.filesLoading = false;
        el.filesRefresh.disabled = false;
        state.filesAt = Date.now();
        state.folder = (data && data.folder) || '';
        state.folderByStore[store] = state.folder;
        state.files = (data && data.objects) || [];
        state.subFolders = (data && data.folders) || [];
        state.crumbs = (data && data.crumbs) || [];
        state.filesUsage = (data && data.usage) || null;
        renderUsage(state.filesUsage);
        renderCloudFiles();
        syncShareTarget();
      },
      function (err) {
        if (reqId !== state.filesReqId) return;
        state.filesLoading = false;
        el.filesRefresh.disabled = false;
        if (err && err.status === 401) return;
        if (err && err.status === 403) {
          syncCloudVisibility();
          return;
        }
        el.usageCard.hidden = true;
        el.cloudFiles.hidden = true;
        toast(err.message || '读取文件列表失败');
      },
    );
  }

  function openPreview(item) {
    var kind = previewKind(item.name);
    if (!kind) return;
    state.previewing = item;
    el.previewName.textContent = item.name;
    el.previewName.title = item.name;
    el.previewMeta.textContent = fmtSize(item.size) + ' · ' + fmtTime(item.createdAt);
    el.previewBody.textContent = '';

    var node;
    if (kind === 'image') {
      node = document.createElement('img');
      node.alt = item.name;
      node.src = item.url;
    } else if (kind === 'video') {
      node = document.createElement('video');
      node.controls = true;
      node.src = item.url;
    } else if (kind === 'audio') {
      node = document.createElement('audio');
      node.controls = true;
      node.src = item.url;
    } else {
      node = document.createElement('iframe');
      node.title = item.name;
      node.src = item.url;
    }
    el.previewBody.appendChild(node);
    el.preview.hidden = false;
  }

  function closePreview() {
    if (el.preview.hidden) return;
    el.preview.hidden = true;
    el.previewBody.textContent = ''; // 同时停掉视频/音频播放
    state.previewing = null;
  }

  // 下载走服务端签发的 5 分钟链接：public URL 上图片/PDF 是内联预览，
  // 只有带 response-content-disposition 的签名链接才会直接另存为原文件名。
  function downloadCloudFile(item, btn) {
    if (!item) return;
    var label = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = '准备…';
    }
    var restore = function () {
      if (btn) {
        btn.disabled = false;
        btn.textContent = label;
      }
    };
    api('GET', '/api/files/download?key=' + encodeURIComponent(item.key)).then(
      function (res) {
        restore();
        if (res && res.url) window.location.href = res.url;
      },
      function (err) {
        restore();
        if (err && err.status === 401) return;
        toast(err.message || '下载失败');
      },
    );
  }

  /* ---------------- 扫码下载 / 删除 ---------------- */

  // 二维码里放 /api/files/scan?key=...：扫码时服务端现签 5 分钟下载链接再 302，
  // 所以二维码本身不会过期；手机上不用登录也能下载，且强制另存为原文件名。
  function scanUrl(item) {
    return window.location.origin + '/api/files/scan?key=' + encodeURIComponent(item.key);
  }

  function openQrModal(item) {
    if (!item) return;
    var url = scanUrl(item);
    state.qrItem = item;
    el.qrCanvas.textContent = '';
    if (typeof window.qrcode === 'function') {
      try {
        var qr = window.qrcode(0, 'M');
        qr.addData(url);
        qr.make();
        el.qrCanvas.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 1, scalable: true });
      } catch (err) {
        el.qrCanvas.textContent = '二维码生成失败';
      }
    } else {
      el.qrCanvas.textContent = '二维码组件未加载';
    }
    el.qrFile.textContent = item.name;
    el.qrUrl.value = url;
    el.qrCopy.textContent = '复制';
    el.qrModal.hidden = false;
  }

  function closeQrModal() {
    if (!el.qrModal || el.qrModal.hidden) return;
    el.qrModal.hidden = true;
    el.qrCanvas.textContent = '';
    state.qrItem = null;
  }

  // 删除只走服务端：R2 删除是幂等的，删完立刻让本地列表与用量重新拉一遍
  function deleteCloudFile(item, btn) {
    if (!item) return;
    var ok = window.confirm('确定删除「' + item.name + '」？\n删除后链接立即失效，无法恢复。');
    if (!ok) return;
    if (btn) btn.disabled = true;
    api('DELETE', '/api/files?key=' + encodeURIComponent(item.key)).then(
      function () {
        if (state.previewing && state.previewing.key === item.key) closePreview();
        if (state.qrItem && state.qrItem.key === item.key) closeQrModal();
        state.files = (state.files || []).filter(function (o) {
          return o.key !== item.key;
        });
        state.filesAt = 0;
        renderCloudFiles();
        toast('已删除「' + item.name + '」');
        loadCloudFiles(true);
      },
      function (err) {
        if (btn) btn.disabled = false;
        if (err && err.status === 401) return;
        toast(err.message || '删除失败');
      },
    );
  }

  /* ---------------- 设置 ---------------- */

  function switchView(view) {
    var items = el.nav.querySelectorAll('.nav-item');
    for (var i = 0; i < items.length; i += 1) {
      items[i].classList.toggle('is-active', items[i].dataset.view === view);
    }
    el.viewChat.hidden = view !== 'chat';
    el.viewFiles.hidden = view !== 'files';
    el.viewSettings.hidden = view !== 'settings';
    if (window.history && window.history.replaceState) {
      var hash = view === 'settings' ? '#settings' : view === 'files' ? '#files' : '#';
      window.history.replaceState(null, '', hash);
    }
    if (view === 'settings') {
      fillSettings();
    } else if (view === 'files') {
      enterFilesView();
    } else {
      el.input.focus();
    }
  }

  function fillSettings() {
    if (!state.me) return;
    el.setUsername.value = state.me.username;
    el.setDevice.value = state.me.deviceName;
    el.setLimit.value = String(state.displayLimit);
    el.setOrigin.textContent = window.location.origin;
    el.aboutOnline.textContent = state.online + ' / ' + state.maxOnline + ' 台';
    el.accountMsg.textContent = '';
    el.accountMsg.className = 'inline-msg';
    el.setCurrent.value = '';
    el.setNew.value = '';
    el.setConfirm.value = '';

    var admin = isAdmin();
    el.cardUsers.hidden = !admin;
    if (admin) {
      resetUserForm();
      loadUsers();
    }
  }

  function saveAccount() {
    var username = el.setUsername.value.trim();
    var current = el.setCurrent.value;
    var next = el.setNew.value;
    var confirm = el.setConfirm.value;

    el.accountMsg.className = 'inline-msg';
    if (!username) {
      return accountError('用户名不能为空');
    }
    if (!current) {
      return accountError('请输入当前密码以验证身份');
    }
    if (next && next !== confirm) {
      return accountError('两次输入的新密码不一致');
    }
    if (next && (next.length < 6 || next.length > 32)) {
      return accountError('新密码长度需为 6-32 位');
    }

    el.saveAccount.disabled = true;
    api('POST', '/api/account', {
      username: username,
      currentPassword: current,
      newPassword: next || '',
    })
      .then(function () {
        el.accountMsg.textContent = '已保存，请重新登录';
        el.accountMsg.className = 'inline-msg is-ok';
        setTimeout(function () {
          stopTimers();
          state.sessionId = null;
          localStorage.removeItem(STORAGE.session);
          localStorage.setItem(STORAGE.username, username);
          showLogin('账号信息已更新，请用新账号重新登录');
        }, 700);
      })
      .catch(function (err) {
        if (err.status === 401) return;
        accountError(err.message || '保存失败');
      })
      .then(function () {
        el.saveAccount.disabled = false;
      });
  }

  function accountError(text) {
    el.accountMsg.textContent = text;
    el.accountMsg.className = 'inline-msg is-error';
  }

  /* ---------------- 用户管理（仅管理员） ---------------- */

  function isAdmin() {
    return !!state.me && state.me.role === 'admin';
  }

  function clearUserMsg() {
    el.userMsg.textContent = '';
    el.userMsg.className = 'inline-msg';
  }

  function userError(text) {
    el.userMsg.textContent = text;
    el.userMsg.className = 'inline-msg is-error';
  }

  function userOk(text) {
    el.userMsg.textContent = text;
    el.userMsg.className = 'inline-msg is-ok';
  }

  function loadUsers() {
    if (!isAdmin()) return;
    api('GET', '/api/users')
      .then(function (data) {
        state.users = (data && data.users) || [];
        renderUsers();
      })
      .catch(function (err) {
        if (err.status === 401 || err.status === 403) return;
        userError(err.message || '用户列表加载失败');
      });
  }

  function renderUsers() {
    el.userList.innerHTML = '';
    if (!state.users.length) {
      var empty = document.createElement('div');
      empty.className = 'user-empty';
      empty.textContent = '暂无可管理的账号';
      el.userList.appendChild(empty);
      return;
    }
    for (var i = 0; i < state.users.length; i += 1) {
      el.userList.appendChild(buildUserRow(state.users[i]));
    }
  }

  function buildUserRow(user) {
    var row = document.createElement('div');
    row.className = 'user-item';

    var main = document.createElement('div');
    main.className = 'user-main';

    var nameLine = document.createElement('div');
    nameLine.className = 'user-name';

    var name = document.createElement('span');
    name.textContent = user.username;
    nameLine.appendChild(name);

    if (state.me && user.username === state.me.username) {
      var meTag = document.createElement('span');
      meTag.className = 'role-tag';
      meTag.textContent = '我';
      nameLine.appendChild(meTag);
    }

    var roleTag = document.createElement('span');
    roleTag.className = 'role-tag' + (user.role === 'admin' ? ' is-admin' : '');
    roleTag.textContent = user.role === 'admin' ? '管理员' : '成员';
    nameLine.appendChild(roleTag);

    if (user.online > 0) {
      var onlineTag = document.createElement('span');
      onlineTag.className = 'online-tag';
      onlineTag.textContent = '在线 ' + user.online;
      nameLine.appendChild(onlineTag);
    }

    var meta = document.createElement('div');
    meta.className = 'user-meta';
    meta.textContent = user.updatedAt ? '最近修改 ' + formatTime(user.updatedAt) : '';

    main.appendChild(nameLine);
    main.appendChild(meta);

    var actions = document.createElement('div');
    actions.className = 'user-actions';

    var editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn-ghost';
    editBtn.textContent = '编辑';
    editBtn.onclick = function () {
      startEditUser(user.username);
    };

    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-ghost btn-danger';
    delBtn.textContent = '删除';
    delBtn.onclick = function () {
      removeUser(user.username);
    };

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    row.appendChild(main);
    row.appendChild(actions);
    return row;
  }

  function startEditUser(username) {
    var target = null;
    for (var i = 0; i < state.users.length; i += 1) {
      if (state.users[i].username === username) {
        target = state.users[i];
        break;
      }
    }
    if (!target) return;
    state.editingUser = target.username;
    el.userName.value = target.username;
    el.userPassword.value = '';
    el.userPassword.placeholder = '留空则不修改';
    el.userPasswordHint.textContent = '留空则不修改';
    el.userRole.value = target.role;
    el.userSubmit.textContent = '保存修改';
    el.userCancel.hidden = false;
    clearUserMsg();
    el.userName.focus();
  }

  function resetUserForm() {
    state.editingUser = null;
    el.userName.value = '';
    el.userPassword.value = '';
    el.userPassword.placeholder = '6-32 位';
    el.userPasswordHint.textContent = '6-32 位';
    el.userRole.value = 'member';
    el.userSubmit.textContent = '添加用户';
    el.userCancel.hidden = true;
    clearUserMsg();
  }

  function submitUser() {
    var username = el.userName.value.trim();
    var password = el.userPassword.value;
    var role = el.userRole.value;
    var editing = state.editingUser;

    if (!username) {
      return userError('请输入用户名');
    }
    if (password && (password.length < 6 || password.length > 32)) {
      return userError('密码需为 6-32 位');
    }
    if (!editing && !password) {
      return userError('请为新用户设置密码');
    }

    el.userSubmit.disabled = true;

    var request;
    if (editing) {
      var payload = { username: username, role: role };
      if (password) payload.password = password;
      request = api('PATCH', '/api/users/' + encodeURIComponent(editing), payload);
    } else {
      request = api('POST', '/api/users', {
        username: username,
        password: password,
        role: role,
      });
    }

    request
      .then(function (data) {
        if (data && data.relogin) {
          userOk('账号信息已更新，请重新登录');
          setTimeout(signOutForAccountChange, 700);
          return;
        }
        resetUserForm();
        loadUsers();
        userOk(editing ? '已保存修改' : '用户已添加');
      })
      .catch(function (err) {
        if (err.status === 401) return;
        userError(err.message || '操作失败');
      })
      .then(function () {
        el.userSubmit.disabled = false;
      });
  }

  function removeUser(username) {
    if (!window.confirm('确定删除账号「' + username + '」？该用户的在线会话会立即失效。')) {
      return;
    }
    api('DELETE', '/api/users/' + encodeURIComponent(username))
      .then(function (data) {
        if (state.editingUser === username) resetUserForm();
        loadUsers();
        var kicked = data && data.kicked ? '，已踢出 ' + data.kicked + ' 个会话' : '';
        userOk('已删除 ' + username + kicked);
      })
      .catch(function (err) {
        if (err.status === 401) return;
        userError(err.message || '删除失败');
      });
  }

  // 改了自己的用户名或密码：清会话回登录页
  function signOutForAccountChange() {
    var username = el.userName.value.trim() || (state.me && state.me.username) || '';
    stopTimers();
    state.sessionId = null;
    state.me = null;
    localStorage.removeItem(STORAGE.session);
    if (username) localStorage.setItem(STORAGE.username, username);
    showLogin('账号信息已更新，请用新账号重新登录');
  }

  function logout() {
    var sid = state.sessionId;
    stopTimers();
    state.sessionId = null;
    state.me = null;
    localStorage.removeItem(STORAGE.session);
    if (sid) {
      fetch('/api/logout', {
        method: 'POST',
        headers: { 'X-Session-Id': sid },
        keepalive: true,
      }).catch(function () {
        /* 忽略 */
      });
    }
    showLogin('已退出登录');
  }

  /* ---------------- 在线成员列表 ---------------- */

  function updateMembers(list) {
    state.members = Array.isArray(list) ? list : [];
    renderOnlineChips();
  }

  // 同一用户多台设备合并为一个头像块；点别人 = 发文件
  function renderOnlineChips() {
    if (!el.onlineChips) return;
    el.onlineChips.textContent = '';
    var map = new Map();
    state.members.forEach(function (m) {
      if (!m || !m.username) return;
      var entry = map.get(m.username);
      if (!entry) {
        entry = { username: m.username, devices: [] };
        map.set(m.username, entry);
      }
      entry.devices.push(m.deviceName || 'Web');
    });
    var me = state.me && state.me.username;
    if (!map.size) {
      var empty = document.createElement('span');
      empty.className = 'online-empty';
      empty.textContent = '暂无在线成员';
      el.onlineChips.appendChild(empty);
      return;
    }
    map.forEach(function (entry) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'online-chip';
      var isSelf = me && entry.username === me;
      if (isSelf) chip.classList.add('is-self');

      var avatar = document.createElement('span');
      avatar.className = 'oc-avatar';
      avatar.textContent = firstChar(entry.username);

      var texts = document.createElement('span');
      texts.className = 'oc-text';
      var name = document.createElement('span');
      name.className = 'oc-name';
      name.textContent = entry.username + (isSelf ? '（我）' : '');
      var dev = document.createElement('span');
      dev.className = 'oc-dev';
      dev.textContent = entry.devices.join(' / ');
      texts.appendChild(name);
      texts.appendChild(dev);

      chip.appendChild(avatar);
      chip.appendChild(texts);
      if (!isSelf) {
        chip.title = '给 ' + entry.username + ' 发文件';
        chip.addEventListener('click', function () {
          openSendModal(entry.username);
        });
      }
      el.onlineChips.appendChild(chip);
    });
  }

  /* ---------------- 客户端 zip 打包（仅存储不压缩，文件夹/多文件发送用） ---------------- */

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var i = 0; i < 256; i += 1) {
      var c = i;
      for (var k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32Update(crc, buf) {
    var table = CRC_TABLE;
    var c = crc ^ 0xffffffff;
    for (var i = 0; i < buf.length; i += 1) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(ts) {
    var d = new Date(ts || Date.now());
    var time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | (Math.floor(d.getSeconds() / 2) & 31);
    var date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time: time, date: date };
  }

  // entries: [{ name: '目录/文件.txt', file: File }] → Blob(zip)。
  // 文件数据块以 Blob 引用拼接，不整包读进内存；逐块算 CRC。
  function buildZip(entries, onProgress) {
    return new Promise(function (resolve, reject) {
      var encoder = new TextEncoder();
      var totalBytes = entries.reduce(function (sum, e) { return sum + e.file.size; }, 0);
      if (totalBytes > 4 * 1024 * 1024 * 1024) {
        reject(new Error('文件夹总大小超过 4GB，无法打包'));
        return;
      }
      var parts = [];
      var offsets = [];
      var records = [];
      var offset = 0;
      var index = 0;
      var CHUNK = 4 * 1024 * 1024;

      function next() {
        if (index >= entries.length) {
          finish();
          return;
        }
        var entry = entries[index];
        var nameBytes = encoder.encode(entry.name);
        var dt = dosDateTime(entry.file.lastModified);
        var size = entry.file.size;
        var crc = 0;
        var done = 0;

        function readChunk() {
          if (done >= size) {
            var local = new DataView(new ArrayBuffer(30));
            local.setUint32(0, 0x04034b50, true);
            local.setUint16(4, 20, true);
            local.setUint16(6, 0x0800, true); // UTF-8 文件名
            local.setUint16(8, 0, true); // store 不压缩
            local.setUint16(10, dt.time, true);
            local.setUint16(12, dt.date, true);
            local.setUint32(14, crc, true);
            local.setUint32(18, size, true);
            local.setUint32(22, size, true);
            local.setUint16(26, nameBytes.length, true);
            local.setUint16(28, 0, true);
            offsets.push(offset);
            parts.push(new Blob([local.buffer, nameBytes]));
            offset += 30 + nameBytes.length + size;
            records.push({ nameBytes: nameBytes, crc: crc, size: size, dt: dt });
            index += 1;
            if (typeof onProgress === 'function') {
              onProgress(Math.min(0.95, (totalBytes ? offset : 1) / (totalBytes + 1)));
            }
            setTimeout(next, 0);
            return;
          }
          var end = Math.min(done + CHUNK, size);
          entry.file
            .slice(done, end)
            .arrayBuffer()
            .then(function (buf) {
              crc = crc32Update(crc, new Uint8Array(buf));
              parts.push(entry.file.slice(done, end));
              done = end;
              readChunk();
            }, reject);
        }
        readChunk();
      }

      function finish() {
        var cdStart = offset;
        records.forEach(function (rec, idx) {
          var cd = new DataView(new ArrayBuffer(46));
          cd.setUint32(0, 0x02014b50, true);
          cd.setUint16(4, 20, true);
          cd.setUint16(6, 20, true);
          cd.setUint16(8, 0x0800, true);
          cd.setUint16(12, rec.dt.time, true);
          cd.setUint16(14, rec.dt.date, true);
          cd.setUint32(16, rec.crc, true);
          cd.setUint32(20, rec.size, true);
          cd.setUint32(24, rec.size, true);
          cd.setUint16(28, rec.nameBytes.length, true);
          cd.setUint32(42, offsets[idx], true);
          parts.push(new Blob([cd.buffer, rec.nameBytes]));
          offset += 46 + rec.nameBytes.length;
        });
        var eocd = new DataView(new ArrayBuffer(22));
        eocd.setUint32(0, 0x06054b50, true);
        eocd.setUint16(8, records.length, true);
        eocd.setUint16(10, records.length, true);
        eocd.setUint32(12, offset - cdStart, true);
        eocd.setUint32(16, cdStart, true);
        parts.push(new Blob([eocd.buffer]));
        if (typeof onProgress === 'function') onProgress(1);
        resolve(new Blob(parts, { type: 'application/zip' }));
      }

      next();
    });
  }

  /* ---------------- 点对点传文件（WebRTC 直传，文件不经过服务器） ---------------- */

  var PEER_CHUNK = 16 * 1024;
  var PEER_HIGH = 4 * 1024 * 1024;
  var PEER_LOW = 1 * 1024 * 1024;
  var LAN_RTT_MS = 10;
  var PROBE_TIMEOUT = 15000;
  var ICE_SERVERS = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

  function peerSignal(to, payload) {
    return api('POST', '/api/peer/signal', { to: to, payload: payload });
  }

  function openSendModal(username) {
    state.peerSession = { role: 'send', target: username, phase: 'pick', meta: null, blob: null };
    el.sendTitle.textContent = '发送文件给 ' + username;
    el.sendOk.hidden = true;
    el.sendCancel.hidden = false;
    el.sendCancel.textContent = '取消';
    renderSendPhase();
    el.sendModal.hidden = false;
  }

  function sendProgressRow(label) {
    var row = document.createElement('div');
    row.className = 'p-row';
    var text = document.createElement('div');
    text.className = 'p-label';
    text.textContent = label || '';
    var line = document.createElement('div');
    line.className = 'p-line';
    var bar = document.createElement('div');
    bar.className = 'p-bar';
    var fill = document.createElement('div');
    fill.className = 'p-fill';
    fill.style.width = '0%';
    bar.appendChild(fill);
    var pct = document.createElement('span');
    pct.className = 'p-pct';
    pct.textContent = '0%';
    line.appendChild(bar);
    line.appendChild(pct);
    row.appendChild(text);
    row.appendChild(line);
    var ps = state.peerSession;
    if (ps) {
      ps._fill = fill;
      ps._pct = pct;
      ps._label = text;
    }
    return row;
  }

  function setSendProgress(ratio, label) {
    var ps = state.peerSession;
    if (!ps || !ps._fill) return;
    var p = Math.max(0, Math.min(1, ratio || 0));
    ps._fill.style.width = (p * 100).toFixed(1) + '%';
    if (ps._pct) ps._pct.textContent = Math.round(p * 100) + '%';
    if (label && ps._label) ps._label.textContent = label;
  }

  function renderSendPhase() {
    var ps = state.peerSession;
    if (!ps || !el.sendBody) return;
    el.sendBody.textContent = '';
    var psRole = ps.role;
    var phase = ps.phase;

    function hint(text) {
      var div = document.createElement('div');
      div.className = 'fs-hint';
      div.textContent = text;
      el.sendBody.appendChild(div);
      return div;
    }

    function actionButton(text, handler, primary) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = primary ? 'btn-primary btn-auto' : 'btn-ghost';
      btn.textContent = text;
      btn.addEventListener('click', handler);
      el.sendBody.appendChild(btn);
      return btn;
    }

    if (phase === 'pick') {
      hint('选择文件或整个文件夹。建立连接后自动探测延迟：同局域网（≤' + LAN_RTT_MS + 'ms）内点对点直传，文件不经过服务器；否则询问是否云盘中转。');
      var row = document.createElement('div');
      row.className = 'send-actions';
      el.sendBody.appendChild(row);
      var pickFile = document.createElement('button');
      pickFile.type = 'button';
      pickFile.className = 'btn-ghost';
      pickFile.textContent = '选择文件';
      pickFile.addEventListener('click', function () {
        el.sendFile.click();
      });
      var pickFolder = document.createElement('button');
      pickFolder.type = 'button';
      pickFolder.className = 'btn-ghost';
      pickFolder.textContent = '选择文件夹';
      pickFolder.addEventListener('click', function () {
        el.sendFolder.click();
      });
      row.appendChild(pickFile);
      row.appendChild(pickFolder);
    } else if (phase === 'zipping') {
      sendProgressRow('正在打包…');
    } else if (phase === 'probing') {
      hint('正在建立点对点连接并探测链路延迟…');
    } else if (phase === 'connecting') {
      hint('对方已同意接收，正在建立直连…');
    } else if (phase === 'transferring') {
      sendProgressRow(psRole === 'recv' ? '接收中' : '局域网直传中');
    } else if (phase === 'uploading') {
      sendProgressRow('云盘中转上传中');
    } else if (phase === 'relay') {
      hint('直传不可用：' + (ps.reason || '与对方不在同一局域网') + '。');
      hint('同意后文件将上传到云盘中转（7 天自动过期），对方从云端下载。');
    } else if (phase === 'incoming') {
      hint(
        (ps.target || '对方') + '（' + (ps.fromDevice || 'Web') + '）想给你发送文件，接收后通过局域网点对点直传，文件不经过服务器：'
      );
      var info = document.createElement('div');
      info.className = 'p-fileinfo';
      info.textContent = ps.meta && ps.meta.name ? ps.meta.name + '（' + fmtSize(ps.meta.size) + (ps.meta.count > 1 ? '，' + ps.meta.count + ' 个文件打包' : '') + '）' : '未知文件';
      el.sendBody.appendChild(info);
    } else if (phase === 'done') {
      hint('✓ 传输完成');
    } else if (phase === 'done-relay') {
      hint('✓ 已通过云盘中转，等对方下载');
    }
  }

  function onSendOk() {
    var ps = state.peerSession;
    if (!ps) return;
    if (ps.phase === 'incoming') acceptIncoming();
    else if (ps.phase === 'relay') doRelay();
  }

  function onSendCancel() {
    var ps = state.peerSession;
    if (!ps) return closeSendModal();
    if (ps.phase === 'incoming') {
      declineIncoming();
      return;
    }
    if (ps.phase === 'transferring' || ps.phase === 'probing' || ps.phase === 'connecting') {
      // 中途取消：通知对方
      peerSignal(ps.target, { kind: 'ctrl', t: 'cancel' }).catch(function () {});
    }
    closeSendModal();
  }

  function closeSendModal() {
    var ps = state.peerSession;
    if (ps) cleanupPeerSession(ps);
    state.peerSession = null;
    if (el.sendModal) el.sendModal.hidden = true;
  }

  function cleanupPeerSession(ps) {
    if (ps.probeTimer) {
      clearTimeout(ps.probeTimer);
      ps.probeTimer = null;
    }
    if (ps.rttTimer) {
      clearTimeout(ps.rttTimer);
      ps.rttTimer = null;
    }
    if (ps.dc) {
      try {
        ps.dc.close();
      } catch (err) {
        /* 忽略 */
      }
      ps.dc = null;
    }
    if (ps.pc) {
      try {
        ps.pc.close();
      } catch (err) {
        /* 忽略 */
      }
      ps.pc = null;
    }
    if (ps.writer) {
      try {
        ps.writer.close();
      } catch (err) {
        /* 忽略 */
      }
      ps.writer = null;
    }
  }

  function prepareSend(fileList, isFolder) {
    var ps = state.peerSession;
    if (!ps || ps.role !== 'send') return;
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;

    if (files.length === 1 && !isFolder) {
      startProbe(files[0], files[0].name, 1);
      return;
    }

    var baseName = 'files.zip';
    var rel0 = files[0].webkitRelativePath || '';
    if (isFolder && rel0 && rel0.indexOf('/') > 0) {
      baseName = rel0.split('/')[0] + '.zip';
    }
    ps.phase = 'zipping';
    el.sendOk.hidden = true;
    renderSendPhase();

    var entries = files.map(function (f) {
      return { name: f.webkitRelativePath || f.name, file: f };
    });
    buildZip(entries, function (ratio) {
      setSendProgress(ratio, '正在打包 ' + files.length + ' 个文件…');
    })
      .then(function (blob) {
        if (state.peerSession !== ps) return;
        startProbe(blob, baseName, files.length);
      })
      .catch(function (err) {
        toast(err.message || '打包失败');
        ps.phase = 'pick';
        renderSendPhase();
      });
  }

  function startProbe(blob, name, count) {
    var ps = state.peerSession;
    if (!ps || ps.role !== 'send') return;
    ps.blob = blob;
    ps.meta = { name: name, size: blob.size, count: count };

    if (!window.RTCPeerConnection) {
      offerRelay('当前浏览器不支持点对点直传');
      return;
    }
    if (!state.sseOk) {
      offerRelay('当前未建立实时通道，无法完成直连握手');
      return;
    }

    ps.phase = 'probing';
    ps.rttList = [];
    ps.pendingCands = [];
    el.sendOk.hidden = true;
    renderSendPhase();

    ps.probeTimer = setTimeout(function () {
      if (state.peerSession === ps && ps.phase === 'probing') {
        offerRelay('连接超时，对方无响应');
      }
    }, PROBE_TIMEOUT);

    var pc;
    try {
      pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    } catch (err) {
      offerRelay('创建点对点连接失败');
      return;
    }
    ps.pc = pc;
    var dc = pc.createDataChannel('file', { ordered: true });
    ps.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = function () {
      peerChannelOpen(ps);
    };
    dc.onmessage = function (event) {
      senderOnMessage(ps, event.data);
    };

    pc.onicecandidate = function (event) {
      if (event.candidate) {
        peerSignal(ps.target, { kind: 'cand', cand: event.candidate.toJSON() }).catch(function () {});
      }
    };
    pc.onconnectionstatechange = function () {
      if (state.peerSession !== ps) return;
      if (pc.connectionState === 'failed' && (ps.phase === 'probing' || ps.phase === 'connecting')) {
        offerRelay('点对点连接失败（可能被多层路由隔离）');
      }
    };

    pc.createOffer()
      .then(function (offer) {
        return pc.setLocalDescription(offer);
      })
      .then(function () {
        peerSignal(ps.target, { kind: 'offer', sdp: ps.pc.localDescription.toJSON(), meta: ps.meta }).catch(function (err) {
          if (state.peerSession === ps && ps.phase === 'probing') {
            offerRelay(err && err.message ? err.message : '信令发送失败');
          }
        });
      })
      .catch(function () {
        if (state.peerSession === ps && ps.phase === 'probing') offerRelay('创建点对点连接失败');
      });
  }

  function peerChannelOpen(ps) {
    if (state.peerSession !== ps) return;
    try {
      ps.dc.send(JSON.stringify({ t: 'meta', name: ps.meta.name, size: ps.meta.size, count: ps.meta.count }));
    } catch (err) {
      /* 忽略 */
    }
    ps.rttList = [];
    for (var i = 0; i < 5; i += 1) {
      (function (n) {
        setTimeout(function () {
          if (state.peerSession === ps && ps.dc && ps.dc.readyState === 'open') {
            try {
              ps.dc.send(JSON.stringify({ t: 'ping', n: n, ts: Date.now() }));
            } catch (err) {
              /* 忽略 */
            }
          }
        }, n * 120);
      })(i);
    }
    ps.rttTimer = setTimeout(function () {
      evaluateRtt(ps);
    }, 5 * 120 + 1200);
  }

  function senderOnMessage(ps, data) {
    if (state.peerSession !== ps || typeof data !== 'string') return;
    var msg;
    try {
      msg = JSON.parse(data);
    } catch (err) {
      return;
    }
    if (msg.t === 'pong' && typeof msg.ts === 'number') {
      ps.rttList.push(Date.now() - msg.ts);
      if (ps.rttList.length >= 5 && ps.rttTimer) {
        clearTimeout(ps.rttTimer);
        ps.rttTimer = null;
        evaluateRtt(ps);
      }
    } else if (msg.t === 'decline') {
      closeSendModal();
      toast('对方拒绝了接收');
    } else if (msg.t === 'cancel') {
      closeSendModal();
      toast('对方取消了接收');
    }
  }

  function evaluateRtt(ps) {
    if (state.peerSession !== ps || ps.phase !== 'probing') return;
    if (ps.rttTimer) {
      clearTimeout(ps.rttTimer);
      ps.rttTimer = null;
    }
    if (!ps.rttList.length) {
      offerRelay('未收到对方延迟回应');
      return;
    }
    var sorted = ps.rttList.slice().sort(function (a, b) { return a - b; });
    var median = sorted[Math.floor(sorted.length / 2)];
    if (median <= LAN_RTT_MS) {
      ps.rtt = median;
      ps.phase = 'transferring';
      renderSendPhase();
      try {
        ps.dc.send(JSON.stringify({ t: 'start', rtt: median }));
      } catch (err) {
        offerRelay('传输启动失败');
        return;
      }
      dcSendFile(ps);
    } else {
      try {
        ps.dc.send(JSON.stringify({ t: 'abort', rtt: median }));
      } catch (err) {
        /* 忽略 */
      }
      offerRelay('实测延迟 ' + median + 'ms（>' + LAN_RTT_MS + 'ms），不在同一局域网');
    }
  }

  function dcSendFile(ps) {
    var blob = ps.blob;
    var dc = ps.dc;
    var offset = 0;
    dc.bufferedAmountLowThreshold = PEER_LOW;

    function pump() {
      if (state.peerSession !== ps || ps.phase !== 'transferring') return;
      try {
        while (offset < blob.size && dc.bufferedAmount < PEER_HIGH) {
          var end = Math.min(offset + PEER_CHUNK, blob.size);
          dc.send(blob.slice(offset, end));
          offset = end;
        }
      } catch (err) {
        toast('传输中断：' + (err.message || '未知错误'));
        closeSendModal();
        return;
      }
      setSendProgress(blob.size ? offset / blob.size : 1);
      if (offset >= blob.size) {
        finishSend(ps);
        return;
      }
    }

    dc.addEventListener('bufferedamountlow', pump);
    pump();
  }

  function finishSend(ps) {
    if (state.peerSession !== ps) return;
    try {
      ps.dc.send(JSON.stringify({ t: 'end' }));
    } catch (err) {
      /* 忽略 */
    }
    ps.phase = 'done';
    renderSendPhase();
    // 留一条私发记录（只有双方可见），文件本体不经过服务器
    api('POST', '/api/messages', {
      content: '已通过局域网直传「' + (ps.meta && ps.meta.name ? ps.meta.name : '文件') + '」（' + fmtSize(ps.meta.size) + '）',
      clientMsgId: uuid(),
      to: ps.target,
    })
      .then(function (data) {
        if (data.message) appendMessages([data.message]);
      })
      .catch(function () {});
    setTimeout(function () {
      if (state.peerSession === ps) closeSendModal();
    }, 1200);
  }

  function offerRelay(reason) {
    var ps = state.peerSession;
    if (!ps) return;
    cleanupPeerSession(ps);
    ps.pc = null;
    ps.dc = null;
    ps.phase = 'relay';
    ps.reason = reason;
    el.sendTitle.textContent = '发送文件给 ' + ps.target;
    el.sendOk.hidden = false;
    el.sendOk.textContent = '同意中转';
    el.sendCancel.hidden = false;
    el.sendCancel.textContent = '取消';
    renderSendPhase();
  }

  function doRelay() {
    var ps = state.peerSession;
    if (!ps || !ps.blob) return;
    ps.phase = 'uploading';
    el.sendOk.hidden = true;
    renderSendPhase();
    var file = ps.blob instanceof File ? ps.blob : new File([ps.blob], ps.meta.name, { type: 'application/zip' });
    uploadToR2(file, 'chat', function (ratio) {
      setSendProgress(ratio);
    })
      .then(function (meta) {
        return api('POST', '/api/messages', {
          content: '已通过云盘中转「' + meta.name + '」（' + fmtSize(meta.size) + '）',
          clientMsgId: uuid(),
          file: meta,
          to: ps.target,
        });
      })
      .then(function (data) {
        if (state.peerSession !== ps) return;
        if (data.message) appendMessages([data.message]);
        ps.phase = 'done-relay';
        renderSendPhase();
        setTimeout(function () {
          if (state.peerSession === ps) closeSendModal();
        }, 1200);
      })
      .catch(function (err) {
        if (err.status === 401) return;
        if (state.peerSession !== ps) return;
        ps.phase = 'relay';
        ps.reason = (err && err.message) || '云盘中转上传失败';
        el.sendOk.hidden = false;
        renderSendPhase();
      });
  }

  /* ---------------- 接收端 ---------------- */

  function handlePeerSignal(data) {
    var p = data.payload || {};
    var ps = state.peerSession;

    if (p.kind === 'offer') {
      if (ps && ps.phase !== 'pick' && ps.phase !== 'relay' && ps.phase !== 'done' && ps.phase !== 'done-relay') {
        peerSignal(data.from, { kind: 'ctrl', t: 'busy' }).catch(function () {});
        return;
      }
      if (ps) cleanupPeerSession(ps);
      state.peerSession = {
        role: 'recv',
        target: data.from,
        fromDevice: data.fromDevice || 'Web',
        phase: 'incoming',
        meta: p.meta || { name: '文件', size: 0, count: 1 },
        offer: p.sdp,
        pc: null,
        dc: null,
        writer: null,
        chunks: [],
        received: 0,
        pendingCands: [],
      };
      el.sendTitle.textContent = data.from + ' 请求发送文件';
      el.sendOk.hidden = false;
      el.sendOk.textContent = '接收';
      el.sendCancel.hidden = false;
      el.sendCancel.textContent = '拒绝';
      renderSendPhase();
      el.sendModal.hidden = false;
      return;
    }

    if (!ps || ps.target !== data.from) return; // 非本会话的信号直接丢弃

    if (p.kind === 'answer' && ps.role === 'send' && ps.pc) {
      ps.pc
        .setRemoteDescription(p.sdp)
        .then(function () {
          (ps.pendingCands || []).forEach(function (cand) {
            try {
              ps.pc.addIceCandidate(cand).catch(function () {});
            } catch (err) {
              /* 忽略 */
            }
          });
          ps.pendingCands = null;
        })
        .catch(function () {});
      return;
    }
    if (p.kind === 'cand' && ps.pc && p.cand) {
      if (ps.pc.remoteDescription) {
        try {
          ps.pc.addIceCandidate(p.cand).catch(function () {});
        } catch (err) {
          /* 忽略 */
        }
      } else if (ps.pendingCands) {
        ps.pendingCands.push(p.cand);
      }
      return;
    }
    if (p.kind === 'ctrl') {
      if (p.t === 'busy') {
        closeSendModal();
        toast('对方正忙，请稍后再试');
      } else if (p.t === 'decline') {
        closeSendModal();
        toast('对方拒绝了接收');
      } else if (p.t === 'cancel') {
        closeSendModal();
        toast('对方取消了传输');
      }
    }
  }

  function acceptIncoming() {
    var ps = state.peerSession;
    if (!ps || ps.role !== 'recv' || ps.accepting) return;
    ps.accepting = true;

    var proceed = function (writer) {
      ps.writer = writer || null;
      answerPeer(ps);
    };

    // 优先让用户选保存位置并流式写盘（大文件不吃内存）；取消选择视为拒绝
    if (window.showSaveFilePicker) {
      window.showSaveFilePicker({ suggestedName: ps.meta.name || 'file' })
        .then(function (handle) {
          return handle.createWritable().then(function (w) {
            proceed(w);
          });
        })
        .catch(function (err) {
          if (err && err.name === 'AbortError') {
            declineIncoming();
            return;
          }
          proceed(null);
        });
      return;
    }
    proceed(null);
  }

  function declineIncoming() {
    var ps = state.peerSession;
    if (ps) peerSignal(ps.target, { kind: 'ctrl', t: 'decline' }).catch(function () {});
    closeSendModal();
  }

  function answerPeer(ps) {
    ps.phase = 'connecting';
    el.sendOk.hidden = true;
    renderSendPhase();
    var pc;
    try {
      pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    } catch (err) {
      closeSendModal();
      toast('创建点对点连接失败');
      return;
    }
    ps.pc = pc;
    pc.onicecandidate = function (event) {
      if (event.candidate) {
        peerSignal(ps.target, { kind: 'cand', cand: event.candidate.toJSON() }).catch(function () {});
      }
    };
    pc.ondatachannel = function (event) {
      var dc = event.channel;
      ps.dc = dc;
      dc.binaryType = 'arraybuffer';
      dc.onmessage = function (ev) {
        receiverOnMessage(ps, ev.data);
      };
      dc.onclose = function () {
        if (state.peerSession === ps && ps.phase === 'transferring') {
          closeSendModal();
          toast('传输中断');
        }
      };
    };
    pc.setRemoteDescription(ps.offer)
      .then(function () {
        return pc.createAnswer();
      })
      .then(function (answer) {
        return pc.setLocalDescription(answer);
      })
      .then(function () {
        peerSignal(ps.target, { kind: 'answer', sdp: ps.pc.localDescription.toJSON() }).catch(function () {});
        (ps.pendingCands || []).forEach(function (cand) {
          try {
            pc.addIceCandidate(cand).catch(function () {});
          } catch (err) {
            /* 忽略 */
          }
        });
        ps.pendingCands = null;
      })
      .catch(function () {
        closeSendModal();
        toast('直连握手失败');
      });
  }

  function receiverOnMessage(ps, data) {
    if (state.peerSession !== ps) return;
    if (typeof data === 'string') {
      var msg;
      try {
        msg = JSON.parse(data);
      } catch (err) {
        return;
      }
      if (msg.t === 'start') {
        ps.phase = 'transferring';
        renderSendPhase();
      } else if (msg.t === 'ping') {
        // 回应发送方的链路探测：原样带时间戳回 pong
        try {
          ps.dc.send(JSON.stringify({ t: 'pong', n: msg.n, ts: msg.ts }));
        } catch (err) {
          /* 忽略 */
        }
      } else if (msg.t === 'end') {
        finishIncoming(ps);
      } else if (msg.t === 'abort') {
        closeSendModal();
        toast('对方不在同一局域网，改走了云盘中转');
      } else if (msg.t === 'cancel') {
        closeSendModal();
        toast('对方取消了发送');
      }
      return;
    }
    var buf = data instanceof ArrayBuffer ? data : null;
    if (!buf) return;
    ps.received += buf.byteLength;
    if (ps.writer) {
      ps.writer.write(buf).catch(function () {});
    } else {
      ps.chunks.push(buf);
    }
    if (ps.meta && ps.meta.size) setSendProgress(ps.received / ps.meta.size);
  }

  function finishIncoming(ps) {
    if (state.peerSession !== ps) return;
    var done = function () {
      ps.phase = 'done';
      renderSendPhase();
      toast('已接收 ' + (ps.meta && ps.meta.name ? ps.meta.name : '文件'));
      setTimeout(function () {
        if (state.peerSession === ps) closeSendModal();
      }, 1200);
    };
    if (ps.writer) {
      ps.writer.close().then(done, done);
      ps.writer = null;
      return;
    }
    var blob = new Blob(ps.chunks, { type: 'application/octet-stream' });
    ps.chunks = [];
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (ps.meta && ps.meta.name) || 'file';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 10000);
    done();
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindEvents() {
    var tabs = el.loginView.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i += 1) {
      tabs[i].addEventListener('click', function (event) {
        setAuthMode(event.currentTarget.dataset.mode);
      });
    }

    el.authForm.addEventListener('submit', handleAuthSubmit);

    el.nav.addEventListener('click', function (event) {
      var button = event.target.closest('.nav-item');
      if (button) switchView(button.dataset.view);
    });

    el.input.addEventListener('input', function () {
      autoGrow();
      updateCounter();
      updateSendState();
    });

    el.input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        sendMessage();
      }
    });

    el.send.addEventListener('click', sendMessage);

    el.attach.addEventListener('click', function () {
      el.chatFile.click();
    });

    el.chatFile.addEventListener('change', function () {
      pickChatFiles(el.chatFile.files);
      el.chatFile.value = '';
    });

    el.shareDrop.addEventListener('click', function () {
      if (state.fileUpload) el.shareFile.click();
    });

    el.shareDrop.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (state.fileUpload) el.shareFile.click();
      }
    });

    el.shareFile.addEventListener('change', function () {
      if (el.shareFile.files && el.shareFile.files[0]) startShareUpload(el.shareFile.files[0]);
      el.shareFile.value = '';
    });

    ['dragenter', 'dragover'].forEach(function (type) {
      el.shareDrop.addEventListener(type, function (event) {
        event.preventDefault();
        if (state.fileUpload) el.shareDrop.classList.add('is-over');
      });
    });

    ['dragleave', 'dragend'].forEach(function (type) {
      el.shareDrop.addEventListener(type, function () {
        el.shareDrop.classList.remove('is-over');
      });
    });

    el.shareDrop.addEventListener('drop', function (event) {
      event.preventDefault();
      el.shareDrop.classList.remove('is-over');
      var dropped = event.dataTransfer && event.dataTransfer.files;
      if (dropped && dropped[0]) startShareUpload(dropped[0]);
    });

    el.spCancel.addEventListener('click', function () {
      // 上传按场景登记：临时页签是 share，永久页签是 keep，两处都要能取消
      ['share', 'keep'].forEach(function (scene) {
        var xhr = state.uploadXhrs[scene];
        if (!xhr) return;
        try {
          xhr.abort();
        } catch (err) {
          /* 忽略 */
        }
        state.uploadXhrs[scene] = null;
      });
      el.shareProgress.hidden = true;
      el.shareDrop.hidden = false;
      syncShareHint();
    });

    el.shareHistoryList.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || !target.dataset) return;
      var url = target.dataset.url;
      if (!url) return;
      if (target.classList.contains('sh-copy')) {
        copyPlain(url, target);
      } else if (target.classList.contains('sh-del')) {
        removeShareHistory(url);
      }
    });

    el.srAgain.addEventListener('click', resetShare);

    el.srCopy.addEventListener('click', function () {
      copyPlain(el.srUrl.value, el.srCopy);
    });

    el.filesRefresh.addEventListener('click', function () {
      loadCloudFiles(true);
    });

    el.cfTabs.addEventListener('click', function (event) {
      var tab = event.target.closest ? event.target.closest('.store-tab') : null;
      if (tab && tab.dataset && tab.dataset.store) switchStore(tab.dataset.store);
    });

    el.cfNewFolder.addEventListener('click', function () {
      openFsModal('newfolder');
    });

    el.fsOk.addEventListener('click', submitFsModal);
    el.fsCancel.addEventListener('click', closeFsModal);
    el.fsClose.addEventListener('click', closeFsModal);
    el.fsMask.addEventListener('click', closeFsModal);
    el.fsInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitFsModal();
      }
    });

    el.sendOk.addEventListener('click', onSendOk);
    el.sendCancel.addEventListener('click', onSendCancel);
    el.sendClose.addEventListener('click', closeSendModal);
    el.sendMask.addEventListener('click', closeSendModal);
    el.sendFile.addEventListener('change', function () {
      prepareSend(el.sendFile.files, false);
      el.sendFile.value = '';
    });
    el.sendFolder.addEventListener('change', function () {
      prepareSend(el.sendFolder.files, true);
      el.sendFolder.value = '';
    });

    el.previewClose.addEventListener('click', closePreview);
    el.previewMask.addEventListener('click', closePreview);
    el.previewDownload.addEventListener('click', function () {
      downloadCloudFile(state.previewing, el.previewDownload);
    });
    el.qrClose.addEventListener('click', closeQrModal);
    el.qrMask.addEventListener('click', closeQrModal);
    el.qrCopy.addEventListener('click', function () {
      copyPlain(el.qrUrl.value, el.qrCopy);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (el.sendModal && !el.sendModal.hidden) {
        onSendCancel();
        return;
      }
      if (el.fsModal && !el.fsModal.hidden) {
        closeFsModal();
        return;
      }
      if (!el.qrModal.hidden) {
        closeQrModal();
        return;
      }
      closePreview();
    });

    el.messages.addEventListener('scroll', function () {
      if (isNearBottom()) el.jumpNew.hidden = true;
    });

    el.jumpNew.addEventListener('click', scrollToBottom);

    el.setLimit.addEventListener('change', function () {
      state.displayLimit = Number(el.setLimit.value) || 50;
      localStorage.setItem(STORAGE.limit, String(state.displayLimit));
      trimToLimit();
      toast('显示条数已设为 ' + state.displayLimit + ' 条');
    });

    el.setDevice.addEventListener('change', function () {
      var value = el.setDevice.value.trim().slice(0, 20);
      if (!value) {
        el.setDevice.value = state.me ? state.me.deviceName : detectDeviceName();
        return;
      }
      localStorage.setItem(STORAGE.device, value);
      toast('设备名已保存，下次登录生效');
    });

    el.saveAccount.addEventListener('click', saveAccount);
    el.userSubmit.addEventListener('click', submitUser);
    el.userCancel.addEventListener('click', resetUserForm);
    el.userPassword.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitUser();
      }
    });
    el.logout.addEventListener('click', logout);

    el.clearLocal.addEventListener('click', function () {
      localStorage.removeItem(STORAGE.limit);
      state.displayLimit = 50;
      el.setLimit.value = '50';
      trimToLimit();
      toast('本地偏好已清空');
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden || !state.sessionId) return;
      if (!state.stream || state.stream.readyState === 2) {
        state.sseErrors = 0;
        openStream();
      }
      poll();
    });

    window.addEventListener('pagehide', function () {
      if (!state.sessionId) return;
      var payload = new Blob(['{}'], { type: 'application/json' });
      navigator.sendBeacon('/api/logout?sid=' + encodeURIComponent(state.sessionId), payload);
    });
  }

  /* ---------------- 启动 ---------------- */

  function init() {
    cacheElements();
    bindEvents();

    var savedLimit = Number(localStorage.getItem(STORAGE.limit));
    state.displayLimit = savedLimit === 20 || savedLimit === 50 || savedLimit === 100 ? savedLimit : 50;

    el.authUsername.value = localStorage.getItem(STORAGE.username) || '';
    el.authDevice.value = localStorage.getItem(STORAGE.device) || detectDeviceName();
    setAuthMode('login');
    updateCounter();

    // 拉一次服务端配置，决定是否显示「创建账号」页签（默认隐藏，取不到就当关闭）
    api('GET', '/api/config')
      .then(function (cfg) {
        if (cfg && typeof cfg.maxOnline === 'number') state.maxOnline = cfg.maxOnline;
        applyRegisterPolicy(cfg && cfg.allowRegister);
        applyFilePolicy(cfg);
      })
      .catch(function () {
        applyRegisterPolicy(false);
        applyFilePolicy(null);
      });

    var savedSession = localStorage.getItem(STORAGE.session);
    if (!savedSession) {
      showLogin('');
      return;
    }

    state.sessionId = savedSession;
    api('GET', '/api/me')
      .then(function (data) {
        return enterApp({
          me: data.me,
          sessionId: savedSession,
          online: data.online,
          limits: data.limits,
        });
      })
      .catch(function () {
        state.sessionId = null;
        localStorage.removeItem(STORAGE.session);
        showLogin('');
      });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
