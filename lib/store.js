'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FLUSH_DELAY = 250;
const COMPACT_MIN = 200;
const COMPACT_RATIO = 0.25;

class MessageStore {
  constructor(file, { maxMessages = 10000, retainDays = 30 } = {}) {
    this.file = file;
    this.legacyFile = path.join(path.dirname(file), 'messages.json');
    this.maxMessages = maxMessages;
    this.retainDays = retainDays;
    this.messages = [];
    this.nextId = 1;
    this.pending = [];
    this.saveTimer = null;
    this.stale = 0;
  }

  load() {
    this.migrateLegacy();

    let raw = '';
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      raw = '';
    }

    const list = [];
    let broken = 0;
    const lines = raw.split('\n');
    for (const line of lines) {
      if (!line) continue;
      try {
        const item = JSON.parse(line);
        if (!item || typeof item.id !== 'number' || typeof item.createdAt !== 'number') {
          broken += 1;
          continue;
        }
        list.push(item);
      } catch {
        broken += 1;
      }
    }

    list.sort((a, b) => a.id - b.id);
    const deduped = [];
    for (const item of list) {
      if (deduped.length && deduped[deduped.length - 1].id === item.id) continue;
      deduped.push(item);
    }
    this.messages = deduped;

    const last = this.messages[this.messages.length - 1];
    this.nextId = last ? last.id + 1 : 1;

    const { removed } = this.prune();
    if (removed > 0 || broken > 0) {
      this.compact();
      if (removed > 0) console.log(`[store] 启动清理 ${removed} 条过期消息，当前 ${this.messages.length} 条`);
      if (broken > 0) console.log(`[store] 跳过 ${broken} 行损坏数据并压缩文件`);
    }
    return this.messages.length;
  }

  migrateLegacy() {
    try {
      if (fs.existsSync(this.file)) return;
      if (!fs.existsSync(this.legacyFile)) return;
      const data = JSON.parse(fs.readFileSync(this.legacyFile, 'utf8'));
      const list = Array.isArray(data) ? data : data.messages || [];
      const body = list
        .filter((m) => m && typeof m.id === 'number')
        .map((m) => JSON.stringify(m))
        .join('\n');
      this.writeAtomic(body ? `${body}\n` : '');
      fs.renameSync(this.legacyFile, `${this.legacyFile}.bak`);
      console.log(`[store] 旧版 messages.json 已迁移为 NDJSON，共 ${list.length} 条`);
    } catch (err) {
      console.error('[store] 旧数据迁移失败：', err.message);
    }
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
    this.pending.push(msg);
    const { removed } = this.prune();
    if (removed > 0) {
      this.pending = this.pending.filter((item) => this.messages.includes(item));
    }
    this.scheduleSave();
    this.maybeCompact();
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
    this.stale += removed;
    return { removed };
  }

  maybeCompact() {
    const live = this.messages.length;
    const threshold = Math.max(COMPACT_MIN, Math.floor(live * COMPACT_RATIO));
    if (this.stale >= threshold) this.compact();
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
    }, FLUSH_DELAY);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  flush() {
    if (!this.pending.length) return;
    const chunk = this.pending.map((item) => `${JSON.stringify(item)}\n`).join('');
    this.pending = [];
    try {
      fs.appendFileSync(this.file, chunk, 'utf8');
    } catch (err) {
      console.error('[store] 追加消息失败：', err.message);
    }
  }

  compact() {
    const body = this.messages.map((item) => JSON.stringify(item)).join('\n');
    try {
      this.writeAtomic(body ? `${body}\n` : '');
      this.pending = [];
      this.stale = 0;
    } catch (err) {
      console.error('[store] 压缩文件失败：', err.message);
    }
  }

  writeAtomic(body) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, this.file);
  }

  stats() {
    let bytes = 0;
    try {
      bytes = fs.statSync(this.file).size;
    } catch {
      bytes = 0;
    }
    return { count: this.messages.length, bytes, stale: this.stale };
  }
}

module.exports = { MessageStore };
