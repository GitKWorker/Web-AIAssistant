'use strict';

const crypto = require('node:crypto');

class SessionManager {
  constructor({ maxOnline = 20, ttlMs = 15000 } = {}) {
    this.maxOnline = maxOnline;
    this.ttlMs = ttlMs;
    this.sessions = new Map();
    this.timer = setInterval(() => this.sweep(), 5000);
    if (this.timer.unref) this.timer.unref();
  }

  sweep() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastSeen > this.ttlMs) this.sessions.delete(id);
    }
  }

  count() {
    this.sweep();
    return this.sessions.size;
  }

  create({ username, deviceName, ip }) {
    const deviceKey = `${username}#${deviceName}`;
    this.destroyByIdentity(deviceKey);
    const session = {
      sessionId: `s_${crypto.randomUUID().replace(/-/g, '')}`,
      deviceKey,
      username,
      deviceName,
      displayName: `${username} · ${deviceName}`,
      ip: ip || '',
      lastSeen: Date.now(),
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  findByIdentity(deviceKey) {
    this.sweep();
    for (const session of this.sessions.values()) {
      if (session.deviceKey === deviceKey) return session;
    }
    return null;
  }

  destroyByIdentity(deviceKey) {
    for (const [id, session] of this.sessions) {
      if (session.deviceKey === deviceKey) this.sessions.delete(id);
    }
  }

  destroyByUsername(username) {
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (session.username === username) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  touch(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (Date.now() - session.lastSeen > this.ttlMs) {
      this.sessions.delete(sessionId);
      return null;
    }
    session.lastSeen = Date.now();
    return session;
  }

  destroy(sessionId) {
    return this.sessions.delete(sessionId);
  }

  members() {
    this.sweep();
    return [...this.sessions.values()]
      .map((s) => ({
        displayName: s.displayName,
        username: s.username,
        deviceName: s.deviceName,
        lastSeen: s.lastSeen,
      }))
      .sort((a, b) => a.lastSeen - b.lastSeen);
  }
}

module.exports = { SessionManager };
