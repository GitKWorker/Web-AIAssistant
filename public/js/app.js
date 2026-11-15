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
    stream: null,
    sseOk: false,
    sseErrors: 0,
    pollTimer: null,
    beatTimer: null,
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

  function handleAuthSubmit(event) {
    event.preventDefault();
    var username = el.authUsername.value.trim();
    var password = el.authPassword.value;
    var deviceName = el.authDevice.value.trim() || detectDeviceName();

    showAuthError('');
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
    switchView(window.location.hash === '#settings' ? 'settings' : 'chat');

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
    body.appendChild(text);

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

  /* ---------------- 设置 ---------------- */

  function switchView(view) {
    var items = el.nav.querySelectorAll('.nav-item');
    for (var i = 0; i < items.length; i += 1) {
      items[i].classList.toggle('is-active', items[i].dataset.view === view);
    }
    el.viewChat.hidden = view !== 'chat';
    el.viewSettings.hidden = view !== 'settings';
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', view === 'settings' ? '#settings' : '#');
    }
    if (view === 'settings') {
      fillSettings();
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
