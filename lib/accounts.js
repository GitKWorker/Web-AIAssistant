'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

const KEY_LEN = 32;
const ROLES = ['admin', 'member'];

function digest(password, salt) {
  return crypto.scryptSync(String(password), salt, KEY_LEN).toString('hex');
}

function normalizeRole(role) {
  return role === 'admin' ? 'admin' : 'member';
}

function publicUser(user) {
  return {
    username: user.username,
    role: normalizeRole(user.role),
    createdAt: user.createdAt || 0,
    updatedAt: user.updatedAt || 0,
  };
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
          role: 'admin',
          salt,
          hash: digest('admin123', salt),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];
      this.persist();
      console.log('[accounts] 已创建初始账号 admin / admin123，请登录后在「系统设置」中修改密码');
      return;
    }
    this.migrateRoles();
  }

  // 老数据没有 role 字段：先全部标为 member，再保证至少有一个管理员
  migrateRoles() {
    let changed = false;
    for (const user of this.users) {
      const role = normalizeRole(user.role);
      if (user.role !== role) {
        user.role = role;
        changed = true;
      }
    }
    if (!this.users.some((user) => user.role === 'admin')) {
      const preferred = this.findByUsername('admin') || this.users[0];
      preferred.role = 'admin';
      changed = true;
      console.log(`[accounts] 已将账号 ${preferred.username} 提升为管理员（老数据迁移）`);
    }
    if (changed) this.persist();
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

  adminCount() {
    return this.users.filter((user) => normalizeRole(user.role) === 'admin').length;
  }

  list() {
    return this.users
      .map(publicUser)
      .sort((a, b) => {
        if (a.role !== b.role) return a.role === 'admin' ? -1 : 1;
        return (a.createdAt || 0) - (b.createdAt || 0);
      });
  }

  findByUsername(username) {
    const key = String(username || '').toLowerCase();
    return this.users.find((u) => u.username.toLowerCase() === key) || null;
  }

  isAdmin(username) {
    const user = this.findByUsername(username);
    return !!user && normalizeRole(user.role) === 'admin';
  }

  verify(username, password) {
    const user = this.findByUsername(username);
    if (!user) return null;
    const candidate = Buffer.from(digest(password, user.salt), 'hex');
    const expected = Buffer.from(user.hash, 'hex');
    if (candidate.length !== expected.length) return null;
    return crypto.timingSafeEqual(candidate, expected) ? user : null;
  }

  create({ username, password, role }) {
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      username,
      role: normalizeRole(role),
      salt,
      hash: digest(password, salt),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.users.push(user);
    this.persist();
    return user;
  }

  update(currentUsername, { username: nextName, password, role }) {
    const user = this.findByUsername(currentUsername);
    if (!user) return null;
    if (nextName) user.username = nextName;
    if (role) user.role = normalizeRole(role);
    if (password) {
      user.salt = crypto.randomBytes(16).toString('hex');
      user.hash = digest(password, user.salt);
    }
    user.updatedAt = Date.now();
    this.persist();
    return user;
  }

  remove(username) {
    const user = this.findByUsername(username);
    if (!user) return null;
    const index = this.users.indexOf(user);
    this.users.splice(index, 1);
    this.persist();
    return publicUser(user);
  }
}

module.exports = { AccountStore, ROLES };
