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
  };

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
    shareTask: null,
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
    el.srIcon = $('sr-icon');
    el.srName = $('sr-name');
    el.srSub = $('sr-sub');
    el.srUrl = $('sr-url');
    el.srCopy = $('sr-copy');
    el.srQr = $('sr-qr');
    el.srAgain = $('sr-again');
    el.srOpen = $('sr-open');
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
    if (cfg && typeof cfg.maxFileMB === 'number' && cfg.maxFileMB > 0) {
      state.maxFileMB = cfg.maxFileMB;
    }
    if (cfg && typeof cfg.retainFileDays === 'number' && cfg.retainFileDays > 0) {
      state.retainFileDays = cfg.retainFileDays;
    }
    if (el.attach) el.attach.hidden = !state.fileUpload;
    if (el.navFiles) el.navFiles.hidden = !state.fileUpload;
    if (el.filesRetain) el.filesRetain.textContent = String(state.retainFileDays);
    if (el.shareHint) {
      el.shareHint.textContent = state.fileUpload
        ? '单个文件最大 ' + state.maxFileMB + ' MB · 文件保存 ' + state.retainFileDays + ' 天'
        : '文件功能未配置，请联系管理员填写 R2 凭据';
    }
    if (el.shareDrop) el.shareDrop.classList.toggle('is-disabled', !state.fileUpload);
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
      if (!el.viewSettings.hidden && isAdmin()) loadUsers();
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
    var left = Number(ts) - Date.now();
    if (!isFinite(left) || left <= 0) return '已过期';
    var days = Math.floor(left / 86400000);
    if (days >= 1) return days + ' 天后失效';
    var hours = Math.floor(left / 3600000);
    if (hours >= 1) return hours + ' 小时后失效';
    return '即将失效';
  }

  // 先向服务端换取一次性上传许可，再由浏览器直传 R2。
  // 用 XHR 而非 fetch：只有 XHR 能读到上传进度。
  function uploadToR2(file, scene, onProgress) {
    return api('POST', '/api/files/sign', {
      name: file.name,
      size: file.size,
      mime: file.type || '',
      scene: scene,
    }).then(function (ticket) {
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        state.uploadXhr = xhr;
        xhr.open('PUT', ticket.uploadUrl, true);
        xhr.setRequestHeader('Content-Type', ticket.contentType);
        xhr.upload.onprogress = function (event) {
          if (event.lengthComputable && typeof onProgress === 'function') {
            onProgress(event.loaded / event.total);
          }
        };
        xhr.onload = function () {
          state.uploadXhr = null;
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve({
              key: ticket.key,
              name: ticket.name,
              size: file.size,
              mime: ticket.contentType,
              url: ticket.publicUrl,
              expireAt: ticket.expireAt,
            });
          } else if (xhr.status === 403) {
            reject(new Error('上传许可已失效，请重试'));
          } else {
            reject(new Error('上传失败（HTTP ' + xhr.status + '）'));
          }
        };
        xhr.onerror = function () {
          state.uploadXhr = null;
          reject(new Error('网络中断，上传失败'));
        };
        xhr.onabort = function () {
          state.uploadXhr = null;
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

  function resetShare() {
    if (state.uploadXhr) {
      try {
        state.uploadXhr.abort();
      } catch (err) {
        /* 忽略 */
      }
      state.uploadXhr = null;
    }
    el.shareDrop.hidden = false;
    el.shareProgress.hidden = true;
    el.shareResult.hidden = true;
    el.shareFile.value = '';
    el.spFill.style.width = '0%';
    el.spPct.textContent = '0%';
    el.srQr.textContent = '';
    el.shareHint.textContent = state.fileUpload
      ? '单个文件最大 ' + state.maxFileMB + ' MB · 文件保存 ' + state.retainFileDays + ' 天'
      : '文件功能未配置，请联系管理员填写 R2 凭据';
    el.shareDrop.classList.toggle('is-disabled', !state.fileUpload);
  }

  function startShareUpload(file) {
    if (!state.fileUpload) return toast('文件上传未启用');
    if (file.size > state.maxFileMB * 1024 * 1024) {
      return toast('文件超过 ' + state.maxFileMB + ' MB');
    }

    el.shareDrop.hidden = true;
    el.shareResult.hidden = true;
    el.shareProgress.hidden = false;
    el.spName.textContent = file.name;
    el.spMeta.textContent = fmtSize(file.size) + ' · 准备中';
    el.spFill.style.width = '0%';
    el.spPct.textContent = '0%';

    var startedAt = 0;
    uploadToR2(file, 'share', function (ratio) {
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
    })
      .then(renderShareResult)
      .catch(function (err) {
        if (err && err.status === 401) return;
        el.shareProgress.hidden = true;
        el.shareDrop.hidden = false;
        toast(err.message || '上传失败');
      });
  }

  function renderShareResult(meta) {
    el.shareProgress.hidden = true;
    el.shareDrop.hidden = true;
    el.shareResult.hidden = false;

    el.srIcon.textContent = fileExt(meta.name);
    el.srName.textContent = meta.name;
    el.srName.title = meta.name;
    el.srSub.textContent =
      fmtSize(meta.size) + ' · ' + expireText(meta.expireAt) + ' · 保存 ' + state.retainFileDays + ' 天';
    el.srUrl.value = meta.url;
    el.srOpen.href = meta.url;
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
      resetShare();
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
      if (state.uploadXhr) {
        try {
          state.uploadXhr.abort();
        } catch (err) {
          /* 忽略 */
        }
      }
    });

    el.srAgain.addEventListener('click', resetShare);

    el.srCopy.addEventListener('click', function () {
      copyPlain(el.srUrl.value, el.srCopy);
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
