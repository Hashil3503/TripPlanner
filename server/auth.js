/* auth.js - 비밀번호 해시(scrypt), 세션 토큰, 쿠키, 로그인 시도 제한 */
'use strict';
const crypto = require('node:crypto');

const SESSION_DAYS = 30;
const COOKIE_NAME = 'tp_session';
const SCRYPT_KEYLEN = 64;

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72;

// ---- 비밀번호 ----
function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** 'scrypt$<salt hex>$<hash hex>' */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (!salt.length || expected.length !== SCRYPT_KEYLEN) return false;
  const actual = await scrypt(password, salt);
  return crypto.timingSafeEqual(actual, expected);
}

// 존재하지 않는 아이디로 로그인해도 같은 시간이 걸리도록 쓰는 가짜 해시
let dummyHash = null;
async function verifyDummy(password) {
  if (!dummyHash) dummyHash = await hashPassword('dummy-password-for-timing');
  await verifyPassword(password, dummyHash);
  return false;
}

// ---- 세션 ----
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const sessionExpiry = () => Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const sessionCookie = (token) =>
  `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`;
const clearCookie = () => `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;

// ---- 시도 제한 (메모리) ----
function createLimiter(max, windowMs) {
  const hits = new Map(); // key -> { count, first }
  const fresh = (e) => e && Date.now() - e.first < windowMs;
  const timer = setInterval(() => {
    for (const [k, e] of hits) if (!fresh(e)) hits.delete(k);
  }, 60 * 1000);
  timer.unref();
  return {
    blocked(key) {
      const e = hits.get(key);
      return fresh(e) && e.count >= max;
    },
    fail(key) {
      const e = hits.get(key);
      if (fresh(e)) e.count++;
      else hits.set(key, { count: 1, first: Date.now() });
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

module.exports = {
  USERNAME_RE, PASSWORD_MIN, PASSWORD_MAX, COOKIE_NAME,
  hashPassword, verifyPassword, verifyDummy,
  sha256, newToken, sessionExpiry, parseCookies, sessionCookie, clearCookie,
  createLimiter,
};
