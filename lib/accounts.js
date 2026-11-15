'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

const KEY_LEN = 32;

function digest(password, salt) {
  return crypto.scryptSync(String(password), salt, KEY_LEN).toString('hex');
}

class AccountStore {
  constructor(file) {
    this.file = file;
    this.users = [];
    this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.users = Array.isArray(data.users) ? data.users : [];
    } catch {
      this.users = [];
    }
    if (!this.users.length) {
      const salt = crypto.randomBytes(16).toString('hex');
      this.users = [
        {
          username: 'admin',
          salt,
          hash: digest('admin123', salt),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];
      this.persist();
      console.log('[accounts] 已创建初始账号 admin / admin123，请登录后在「系统设置」中修改密码');
    }
  }

  persist() {
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ users: this.users }, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[accounts] 账号保存失败：', err.message);
    }
  }

  count() {
    return this.users.length;
  }

  findByUsername(username) {
    const key = String(username || '').toLowerCase();
    return this.users.find((u) => u.username.toLowerCase() === key) || null;
  }

  verify(username, password) {
    const user = this.findByUsername(username);
    if (!user) return null;
    const candidate = Buffer.from(digest(password, user.salt), 'hex');
    const expected = Buffer.from(user.hash, 'hex');
    if (candidate.length !== expected.length) return null;
    return crypto.timingSafeEqual(candidate, expected) ? user : null;
  }

  create({ username, password }) {
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      username,
      salt,
      hash: digest(password, salt),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.users.push(user);
    this.persist();
    return user;
  }

  update(currentUsername, { username: nextName, password }) {
    const user = this.findByUsername(currentUsername);
    if (!user) return null;
    if (nextName) user.username = nextName;
    if (password) {
      user.salt = crypto.randomBytes(16).toString('hex');
      user.hash = digest(password, user.salt);
    }
    user.updatedAt = Date.now();
    this.persist();
    return user;
  }
}

module.exports = { AccountStore };
