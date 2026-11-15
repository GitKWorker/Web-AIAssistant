'use strict';

const fs = require('node:fs');

class MessageStore {
  constructor(file, { maxMessages = 10000, retainDays = 30 } = {}) {
    this.file = file;
    this.maxMessages = maxMessages;
    this.retainDays = retainDays;
    this.messages = [];
    this.nextId = 1;
    this.saveTimer = null;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw);
      const list = Array.isArray(data) ? data : data.messages || [];
      this.messages = list.filter((m) => m && typeof m.id === 'number');
      const last = this.messages[this.messages.length - 1];
      this.nextId = (data && data.nextId) || (last ? last.id + 1 : 1);
    } catch {
      this.messages = [];
      this.nextId = 1;
    }
    const { removed } = this.prune();
    if (removed > 0) this.flush();
    return this.messages.length;
  }

  add(entry) {
    const msg = {
      id: this.nextId++,
      deviceKey: entry.deviceKey,
      username: entry.username,
      deviceName: entry.deviceName,
      displayName: entry.displayName,
      content: entry.content,
      clientMsgId: entry.clientMsgId || '',
      createdAt: Date.now(),
    };
    this.messages.push(msg);
    this.prune();
    this.scheduleSave();
    return msg;
  }

  prune() {
    const cutoff = Date.now() - this.retainDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    if (this.messages.length) {
      const kept = this.messages.filter((m) => m.createdAt >= cutoff);
      removed += this.messages.length - kept.length;
      this.messages = kept;
    }
    if (this.messages.length > this.maxMessages) {
      const overflow = this.messages.length - this.maxMessages;
      removed += overflow;
      this.messages.splice(0, overflow);
    }
    return { removed };
  }

  latest(limit) {
    const list = this.messages.slice(-limit);
    return {
      messages: list,
      cursor: list.length ? list[list.length - 1].id : this.nextId - 1,
      reset: false,
      total: this.messages.length,
    };
  }

  listAfter(afterId, limit) {
    if (!this.messages.length) {
      return { messages: [], cursor: Math.max(afterId, this.nextId - 1), reset: false, total: 0 };
    }
    const minId = this.messages[0].id;
    if (afterId < minId - 1) {
      const snapshot = this.latest(limit);
      return Object.assign({}, snapshot, { reset: true });
    }
    const out = [];
    for (const m of this.messages) {
      if (m.id > afterId) {
        out.push(m);
        if (out.length >= limit) break;
      }
    }
    return {
      messages: out,
      cursor: out.length ? out[out.length - 1].id : afterId,
      reset: false,
      total: this.messages.length,
    };
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 250);
  }

  flush() {
    const payload = JSON.stringify({ nextId: this.nextId, messages: this.messages });
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] 消息保存失败：', err.message);
    }
  }
}

module.exports = { MessageStore };
