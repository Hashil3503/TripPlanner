/* server.js - 여행 플래너 로컬 서버 (Node 내장 모듈만 사용: http, sqlite, crypto, fs, path).
 * - public/ 정적 파일 제공 + JSON API (회원가입/로그인/여행 저장)
 * - 127.0.0.1:8000 에만 바인딩 (이 컴퓨터에서만 접속 가능) */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { open } = require('./server/db');
const auth = require('./server/auth');
const { serveStatic } = require('./server/static');
const { createTransit } = require('./server/transit');
const { parsePublicUrls, clientIpFrom } = require('./server/deploy');

const PORT = Number(process.env.TP_PORT) || 8000; // 카카오 키에 등록한 주소가 http://localhost:8000 이므로 기본값을 유지한다
const HOST = '127.0.0.1';
const PUBLIC_DIR = fs.realpathSync(path.join(__dirname, 'public'));
const DB_PATH = process.env.TP_DB_PATH || path.join(__dirname, 'data', 'tripplanner.db');

const BODY_LIMIT = 1024 * 1024; // 1 MB
const SETTINGS_LIMIT = 20 * 1024;
const MAX_TRIPS_PER_USER = 200;
const TRIP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// 외부 배포: TP_PUBLIC_URL(서비스 주소)을 허용 목록에 더하고, 리버스 프록시 뒤라면 TP_TRUST_PROXY=1 (server/deploy.js)
const PUBLIC_URLS = parsePublicUrls(process.env.TP_PUBLIC_URL);
const TRUST_PROXY = process.env.TP_TRUST_PROXY === '1';
const SECURE_COOKIE = PUBLIC_URLS.some((u) => u.https); // https로 서비스하면 쿠키를 https에서만 보낸다
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, ...PUBLIC_URLS.map((u) => u.host)]);
const ALLOWED_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, ...PUBLIC_URLS.map((u) => u.origin)]);

const GENERIC_LOGIN_ERROR = '아이디 또는 비밀번호가 올바르지 않습니다';

// 카카오 키는 환경변수로만 받는다 (저장소에 키 파일 없음).
// - JavaScript 키: 원래 브라우저에 공개되는 키 → /config.js 로 전달
// - REST 키: 서버 전용 비밀 → server/transit.js 가 직접 읽고 절대 브라우저로 보내지 않는다
const KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;
const envKey = (name) => {
  const v = String(process.env[name] || '').trim();
  return KEY_RE.test(v) ? v : '';
};
const KAKAO_JS_KEY = envKey('TP_KAKAO_JS_KEY');
// 브라우저로 나가는 설정. JS 키 외의 값을 여기에 넣지 말 것
const CLIENT_CONFIG_JS = `window.TP_CONFIG = ${JSON.stringify({ kakaoJsKey: KAKAO_JS_KEY })};
`;

let db;
try {
  db = open(DB_PATH);
} catch (e) {
  console.error(`데이터베이스를 열 수 없어요: ${e.message}`);
  process.exit(1);
}
const transit = createTransit({ db }); // 카카오 REST 키: 환경변수 TP_KAKAO_REST_KEY
db.purgeSessions();
transit.purge();
setInterval(() => {
  db.purgeSessions();
  transit.purge();
}, 60 * 60 * 1000).unref();

const loginLimiter = auth.createLimiter(10, 15 * 60 * 1000); // IP+아이디당 15분에 실패 10회
const signupLimiter = auth.createLimiter(20, 60 * 60 * 1000); // IP당 1시간에 가입 20회

// ---- 응답 헬퍼 ----
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    // 카카오 SDK는 도메인 검증에 Referer(origin)가 필요하므로 no-referrer는 쓰지 않는다
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
}

/** 브라우저용 설정 스크립트 (카카오 JavaScript 키만 포함). 키를 바꾸면 반영되도록 캐시 금지 */
function sendClientConfig(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, '허용되지 않는 메서드예요');
  res.writeHead(200, {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(CLIENT_CONFIG_JS),
  });
  res.end(req.method === 'HEAD' ? undefined : CLIENT_CONFIG_JS);
}

function sendJson(res, status, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    const tooBig = () => new HttpError(413, '요청 본문이 너무 커요 (1MB 이하)');
    if (Number(req.headers['content-length']) > BODY_LIMIT) return reject(tooBig());
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > BODY_LIMIT) {
        over = true; // 더 모으지 않고 나머지는 버린다 (응답을 보낸 뒤 연결을 닫는다)
        chunks.length = 0;
        reject(tooBig());
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new HttpError(400, '올바른 JSON이 아니에요');
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- 인증 ----
function currentUser(req) {
  const token = auth.parseCookies(req.headers.cookie)[auth.COOKIE_NAME];
  if (!token || token.length > 128) return null;
  return db.userForSession(auth.sha256(token)) || null;
}

function requireUser(req) {
  const u = currentUser(req);
  if (!u) throw new HttpError(401, '로그인이 필요해요');
  return u;
}

function parseSettings(json) {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return isObj(v) ? v : null;
  } catch (e) {
    return null;
  }
}

function startSession(userId) {
  const token = auth.newToken();
  db.createSession(auth.sha256(token), userId, auth.sessionExpiry());
  return { 'Set-Cookie': auth.sessionCookie(token, SECURE_COOKIE) };
}

const clientIp = (req) => clientIpFrom(req, TRUST_PROXY);

function checkCredentialsFormat(username, password) {
  if (typeof username !== 'string' || !auth.USERNAME_RE.test(username)) return '아이디는 3~20자의 영문, 숫자, 밑줄(_)만 사용할 수 있어요';
  if (typeof password !== 'string' || password.length < auth.PASSWORD_MIN || password.length > auth.PASSWORD_MAX) return `비밀번호는 ${auth.PASSWORD_MIN}~${auth.PASSWORD_MAX}자로 입력해 주세요`;
  return '';
}

async function handleSignup(req, res) {
  const ip = clientIp(req);
  if (signupLimiter.blocked(ip)) throw new HttpError(429, '가입 시도가 너무 많아요. 잠시 후 다시 시도해 주세요');
  const body = await readJson(req);
  const err = checkCredentialsFormat(body.username, body.password);
  if (err) throw new HttpError(400, err);
  if (db.findUser(body.username)) throw new HttpError(409, '이미 사용 중인 아이디예요');
  signupLimiter.fail(ip);
  const hash = await auth.hashPassword(body.password);
  let id;
  try {
    id = db.createUser(body.username, hash);
  } catch (e) {
    throw new HttpError(409, '이미 사용 중인 아이디예요'); // 동시 가입 경합
  }
  sendJson(res, 201, { username: body.username, settings: null }, startSession(id));
}

async function handleLogin(req, res) {
  const body = await readJson(req);
  const username = typeof body.username === 'string' ? body.username : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const key = `${clientIp(req)}|${username.toLowerCase().slice(0, 64)}`;
  if (loginLimiter.blocked(key)) throw new HttpError(429, '로그인 시도가 너무 많아요. 15분 뒤에 다시 시도해 주세요');
  const user = auth.USERNAME_RE.test(username) && password.length <= auth.PASSWORD_MAX * 2 ? db.findUser(username) : null;
  let ok = false;
  if (user) ok = await auth.verifyPassword(password, user.password_hash);
  else await auth.verifyDummy(password.slice(0, auth.PASSWORD_MAX));
  if (!ok) {
    loginLimiter.fail(key);
    throw new HttpError(401, GENERIC_LOGIN_ERROR);
  }
  loginLimiter.reset(key);
  sendJson(res, 200, { username: user.username, settings: parseSettings(user.settings_json) }, startSession(user.id));
}

function handleLogout(req, res) {
  const token = auth.parseCookies(req.headers.cookie)[auth.COOKIE_NAME];
  if (token && token.length <= 128) db.deleteSession(auth.sha256(token));
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie(SECURE_COOKIE) });
}

async function handlePassword(req, res) {
  const u = requireUser(req);
  const body = await readJson(req);
  const cur = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const next = body.newPassword;
  const key = `${clientIp(req)}|${u.username.toLowerCase()}`; // 로그인과 같은 제한기·키를 쓴다
  if (loginLimiter.blocked(key)) throw new HttpError(429, '시도가 너무 많아요. 15분 뒤에 다시 시도해 주세요');
  if (typeof next !== 'string' || next.length < auth.PASSWORD_MIN || next.length > auth.PASSWORD_MAX) throw new HttpError(400, `비밀번호는 ${auth.PASSWORD_MIN}~${auth.PASSWORD_MAX}자로 입력해 주세요`);
  const row = db.findUser(u.username);
  const ok = row && cur.length <= auth.PASSWORD_MAX * 2 && (await auth.verifyPassword(cur, row.password_hash));
  if (!ok) {
    loginLimiter.fail(key);
    throw new HttpError(401, '현재 비밀번호가 올바르지 않습니다');
  }
  loginLimiter.reset(key);
  db.setPassword(u.id, await auth.hashPassword(next));
  db.deleteOtherSessions(u.id, auth.sha256(auth.parseCookies(req.headers.cookie)[auth.COOKIE_NAME])); // 다른 기기는 로그아웃
  sendJson(res, 200, { ok: true });
}

function handleMe(req, res) {
  const u = requireUser(req);
  sendJson(res, 200, { username: u.username, settings: parseSettings(u.settings_json) });
}

// ---- 여행 / 설정 ----
function validateTrip(trip) {
  if (!isObj(trip)) return '여행 데이터가 올바르지 않아요';
  if (typeof trip.name !== 'string' || trip.name.length > 200) return '여행 이름이 올바르지 않아요';
  if (!Array.isArray(trip.days) || trip.days.length < 1 || trip.days.length > 60) return '일차 정보가 올바르지 않아요 (1~60일)';
  for (const d of trip.days) {
    if (!isObj(d) || !Array.isArray(d.items) || d.items.length > 500) return '일정 정보가 올바르지 않아요';
    for (const it of d.items) if (!isObj(it)) return '일정 항목이 올바르지 않아요';
  }
  return '';
}

function tripIdFrom(seg) {
  let id;
  try {
    id = decodeURIComponent(seg);
  } catch (e) {
    id = '';
  }
  if (!TRIP_ID_RE.test(id)) throw new HttpError(400, '여행 ID가 올바르지 않아요');
  return id;
}

function handleListTrips(req, res) {
  const u = requireUser(req);
  const trips = [];
  for (const row of db.listTrips(u.id)) {
    try {
      const t = JSON.parse(row.data_json);
      if (isObj(t)) trips.push(Object.assign(t, { id: row.id }));
    } catch (e) {
      /* 손상된 행은 건너뜀 */
    }
  }
  sendJson(res, 200, { trips });
}

async function handlePutTrip(req, res, idSeg) {
  const u = requireUser(req);
  const id = tripIdFrom(idSeg);
  const body = await readJson(req);
  const err = validateTrip(body.trip);
  if (err) throw new HttpError(400, err);
  if (!db.hasTrip(u.id, id) && db.countTrips(u.id) >= MAX_TRIPS_PER_USER) throw new HttpError(400, `여행은 최대 ${MAX_TRIPS_PER_USER}개까지 저장할 수 있어요`);
  const json = JSON.stringify(Object.assign({}, body.trip, { id }));
  if (json.length > BODY_LIMIT) throw new HttpError(413, '여행 데이터가 너무 커요');
  db.upsertTrip(u.id, id, json);
  sendJson(res, 200, { ok: true, id });
}

function handleDeleteTrip(req, res, idSeg) {
  const u = requireUser(req);
  const id = tripIdFrom(idSeg);
  db.deleteTrip(u.id, id);
  sendJson(res, 200, { ok: true });
}

async function handlePutSettings(req, res) {
  const u = requireUser(req);
  const body = await readJson(req);
  if (!isObj(body.settings)) throw new HttpError(400, '설정 데이터가 올바르지 않아요');
  const json = JSON.stringify(body.settings);
  if (json.length > SETTINGS_LIMIT) throw new HttpError(413, '설정 데이터가 너무 커요');
  db.setSettings(u.id, json);
  sendJson(res, 200, { ok: true });
}

// ---- 대중교통 (카카오 길찾기 프록시; 게스트도 사용 가능) ----
async function handleTransit(req, res) {
  const q = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
  const r = await transit.lookup(q, clientIp(req));
  if (r.cache) console.log(`[transit] ${r.cache} ${q.sx},${q.sy} -> ${q.ex},${q.ey}`);
  sendJson(res, r.status, r.body, r.cache ? { 'X-Transit-Cache': r.cache } : undefined);
}

// ---- 라우팅 ----
const isJsonType = (req) => String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() === 'application/json';

async function handleApi(req, res, pathname) {
  const method = req.method;
  const safe = method === 'GET' || method === 'HEAD';
  if (!safe) {
    // CSRF 방어: Origin이 있으면 우리 주소여야 하고, 상태 변경 요청은 JSON Content-Type 필수
    // (다른 사이트의 <form>/단순 fetch로는 application/json을 보낼 수 없고, 보내려면 CORS 사전 요청이 필요한데 허용하지 않는다)
    const origin = req.headers.origin;
    if (origin !== undefined && !ALLOWED_ORIGINS.has(origin)) throw new HttpError(403, '허용되지 않은 요청이에요');
    if (!isJsonType(req)) throw new HttpError(415, 'Content-Type은 application/json 이어야 해요');
  }

  const parts = pathname.split('/').filter(Boolean); // ['api', ...]
  const route = parts.slice(1);
  const allow = (...methods) => {
    if (!methods.includes(method)) throw new HttpError(405, '허용되지 않는 메서드예요');
  };

  if (route.length === 1) {
    switch (route[0]) {
      case 'signup': allow('POST'); return handleSignup(req, res);
      case 'login': allow('POST'); return handleLogin(req, res);
      case 'logout': allow('POST'); return handleLogout(req, res);
      case 'password': allow('PUT'); return handlePassword(req, res);
      case 'me': allow('GET'); return handleMe(req, res);
      case 'trips': allow('GET'); return handleListTrips(req, res);
      case 'settings': allow('PUT'); return handlePutSettings(req, res);
      case 'transit': allow('GET'); return handleTransit(req, res);
      default: break;
    }
  } else if (route.length === 2 && route[0] === 'trips') {
    allow('PUT', 'DELETE');
    return method === 'PUT' ? handlePutTrip(req, res, route[1]) : handleDeleteTrip(req, res, route[1]);
  }
  throw new HttpError(404, '찾을 수 없는 API예요');
}

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(securityHeaders())) res.setHeader(k, v);
  try {
    // DNS 리바인딩 방어: 우리 주소로 들어온 요청만 처리
    if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) throw new HttpError(403, '허용되지 않은 호스트예요');
    const pathname = String(req.url || '').split(/[?#]/)[0];
    if (pathname === '/api' || pathname.startsWith('/api/')) await handleApi(req, res, pathname);
    else if (pathname === '/config.js') sendClientConfig(req, res);
    else serveStatic(req, res, PUBLIC_DIR);
  } catch (e) {
    if (res.headersSent) return res.destroy();
    if (e instanceof HttpError) {
      if (e.status === 413) {
        res.on('finish', () => req.destroy());
        return sendJson(res, 413, { error: e.message }, { Connection: 'close' });
      }
      return sendJson(res, e.status, { error: e.message });
    }
    console.error(e);
    sendJson(res, 500, { error: '서버 오류가 발생했어요' });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`포트 ${PORT}이(가) 이미 사용 중이에요. 이미 실행 중인 여행 플래너가 있거나 다른 프로그램이 포트를 쓰고 있어요.`);
    console.error('실행 중인 서버를 종료한 뒤 다시 시도해 주세요.');
  } else {
    console.error(`서버를 시작할 수 없어요: ${e.message}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`여행 플래너 서버가 실행 중이에요: http://localhost:${PORT}`);
  if (PUBLIC_URLS.length) console.log(`서비스 주소(TP_PUBLIC_URL): ${PUBLIC_URLS.map((u) => u.origin).join(', ')}${TRUST_PROXY ? ' · 프록시 IP 신뢰' : ''}`);
  // 키 값은 출력하지 않고 설정 여부만 알린다
  console.log(`카카오 JavaScript 키(TP_KAKAO_JS_KEY): ${KAKAO_JS_KEY ? '설정됨' : '없음 - 지도를 표시할 수 없어요'}`);
  console.log(`카카오 REST API 키(TP_KAKAO_REST_KEY): ${transit.hasKey() ? '설정됨' : '없음 - 대중교통은 추정치로 계산돼요'}`);
  console.log('종료하려면 Ctrl+C 를 누르세요.');
});

function shutdown() {
  server.close(() => {
    try {
      db.close();
    } catch (e) {
      /* ignore */
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
