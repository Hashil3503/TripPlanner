/* db.js - SQLite(node:sqlite) 연결, 스키마, 준비된 쿼리. 모든 여행 쿼리는 user_id로 범위를 제한한다. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function open(dbPath) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch (e) {
    throw new Error('이 Node.js에는 node:sqlite가 없어요. Node.js 22.13 이상(권장 24)을 설치해 주세요.');
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      settings_json TEXT,
      created_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    -- 여행 ID는 클라이언트가 만든 값을 그대로 쓰므로, 사용자 간 충돌/덮어쓰기를 막기 위해 (user_id, id)를 기본키로 둔다.
    CREATE TABLE IF NOT EXISTS trips (
      id         TEXT NOT NULL,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      data_json  TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_trips_user ON trips(user_id);
    -- 카카오 대중교통 길찾기 응답 캐시 (key: 좌표 5자리 반올림 조합, json: 정규화된 응답)
    CREATE TABLE IF NOT EXISTS transit_cache (
      key        TEXT PRIMARY KEY,
      json       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  // 마이그레이션: 낙관적 잠금용 여행별 리비전(rev). 이미 배포된 DB에는 컬럼이 없으므로 추가한다.
  if (!db.prepare('PRAGMA table_info(trips)').all().some((c) => c.name === 'rev')) {
    db.exec('ALTER TABLE trips ADD COLUMN rev INTEGER NOT NULL DEFAULT 1');
  }

  const q = {
    userByName: db.prepare('SELECT id, username, password_hash, settings_json FROM users WHERE username = ?'),
    insertUser: db.prepare('INSERT INTO users (username, password_hash, settings_json, created_at) VALUES (?, ?, NULL, ?)'),
    userBySession: db.prepare(
      'SELECT u.id AS id, u.username AS username, u.settings_json AS settings_json FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?'
    ),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'), // 세션/여행은 ON DELETE CASCADE로 함께 지워진다
    deleteExpired: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    listTrips: db.prepare('SELECT id, data_json, rev FROM trips WHERE user_id = ? ORDER BY rowid'),
    getTrip: db.prepare('SELECT id, data_json, rev FROM trips WHERE user_id = ? AND id = ?'),
    insertTrip: db.prepare('INSERT INTO trips (id, user_id, data_json, updated_at, rev) VALUES (?, ?, ?, ?, 1)'),
    updateTrip: db.prepare('UPDATE trips SET data_json = ?, updated_at = ?, rev = rev + 1 WHERE user_id = ? AND id = ?'),
    countTrips: db.prepare('SELECT COUNT(*) AS n FROM trips WHERE user_id = ?'),
    deleteTrip: db.prepare('DELETE FROM trips WHERE user_id = ? AND id = ?'),
    setSettings: db.prepare('UPDATE users SET settings_json = ? WHERE id = ?'),
    getTransit: db.prepare('SELECT json, created_at FROM transit_cache WHERE key = ?'),
    putTransit: db.prepare('INSERT OR REPLACE INTO transit_cache (key, json, created_at) VALUES (?, ?, ?)'),
    purgeTransit: db.prepare('DELETE FROM transit_cache WHERE created_at < ?'),
  };

  return {
    raw: db,
    close: () => db.close(),
    findUser: (username) => q.userByName.get(username),
    createUser: (username, hash) => Number(q.insertUser.run(username, hash, Date.now()).lastInsertRowid),
    createSession: (tokenHash, userId, expiresAt) => q.insertSession.run(tokenHash, userId, expiresAt),
    userForSession: (tokenHash) => q.userBySession.get(tokenHash, Date.now()),
    deleteSession: (tokenHash) => q.deleteSession.run(tokenHash),
    setPassword: (userId, hash) => q.setPassword.run(hash, userId),
    deleteOtherSessions: (userId, keepTokenHash) => q.deleteOtherSessions.run(userId, keepTokenHash),
    deleteUserSessions: (userId) => q.deleteUserSessions.run(userId),
    deleteUser: (userId) => q.deleteUser.run(userId),
    purgeSessions: () => q.deleteExpired.run(Date.now()),
    listTrips: (userId) => q.listTrips.all(userId),
    countTrips: (userId) => q.countTrips.get(userId).n,
    getTrip: (userId, id) => q.getTrip.get(userId, id),
    insertTrip: (userId, id, json) => q.insertTrip.run(id, userId, json, Date.now()),
    updateTrip: (userId, id, json) => q.updateTrip.run(json, Date.now(), userId, id),
    deleteTrip: (userId, id) => q.deleteTrip.run(userId, id).changes,
    setSettings: (userId, json) => q.setSettings.run(json, userId),
    getTransit: (key) => q.getTransit.get(key),
    putTransit: (key, json, at) => q.putTransit.run(key, json, at),
    purgeTransit: (before) => q.purgeTransit.run(before),
  };
}

module.exports = { open };
