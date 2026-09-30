/* transit.js - 카카오맵 대중교통 길찾기(REST) 프록시.
 * - REST 키는 서버에서만 사용하고 브라우저로 내보내지 않는다 (환경변수 TP_KAKAO_REST_KEY).
 * - 응답을 작은 형태로 정규화하고, SQLite(transit_cache)에 캐시한다 (성공 7일, 경로 없음 1일).
 * - 카카오 호출 횟수(캐시 미스)는 IP당 분당 60회로 제한한다. */
'use strict';
const auth = require('./auth');

const KAKAO_URL = 'https://dapi.kakao.com/v2/routing/publictraffic';
const LANDING_PREFIX = 'https://map.kakao.com/';
const TIMEOUT_MS = 10 * 1000;
const TTL_OK_MS = 7 * 24 * 60 * 60 * 1000;
const TTL_NONE_MS = 24 * 60 * 60 * 1000;
const MAX_ROUTES = 5;
const RATE_MAX = 60;
const RATE_WINDOW_MS = 60 * 1000;

const MSG = {
  noKey: '대중교통 실시간 조회를 쓰려면 서버에 카카오 REST API 키(환경변수 TP_KAKAO_REST_KEY)를 설정해 주세요. 지금은 추정값을 사용해요.',
  badParams: '좌표 값이 올바르지 않아요 (sx, sy, ex, ey: 경도/위도 숫자)',
  auth: '카카오 REST API 키가 올바르지 않거나 권한이 없어요. 키와 카카오맵 사용 설정을 확인해 주세요.',
  quota: '카카오 대중교통 API 호출 한도를 초과했어요. 잠시 후 다시 시도해 주세요.',
  upstream: '카카오 대중교통 서비스에서 오류가 발생했어요. 잠시 후 다시 시도해 주세요.',
  timeout: '카카오 대중교통 서비스 응답이 지연되고 있어요. 잠시 후 다시 시도해 주세요.',
  network: '카카오 대중교통 서비스에 연결할 수 없어요. 네트워크를 확인해 주세요.',
  rate: '대중교통 조회 요청이 너무 많아요. 잠시 후 다시 시도해 주세요.',
};

const round5 = (n) => Math.round(n * 1e5) / 1e5;
const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const nonNeg = (v) => (isFiniteNum(v) && v >= 0 ? v : 0);

/** 쿼리 문자열 파라미터 -> 유한한 숫자 (빈 문자열/누락은 NaN) */
function parseCoord(v, limit) {
  if (typeof v !== 'string' || !/^-?\d+(\.\d+)?$/.test(v.trim())) return NaN;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : NaN;
}

/** { sx, sy, ex, ey }(문자열) -> { sx, sy, ex, ey }(숫자, 소수 5자리) 또는 null */
function parseParams(q) {
  const sx = parseCoord(q.sx, 180);
  const sy = parseCoord(q.sy, 90);
  const ex = parseCoord(q.ex, 180);
  const ey = parseCoord(q.ey, 90);
  if ([sx, sy, ex, ey].some(Number.isNaN)) return null;
  return { sx: round5(sx), sy: round5(sy), ex: round5(ex), ey: round5(ey) };
}

// ---- 정규화 ----
function normPath(points) {
  const out = [];
  if (!Array.isArray(points)) return out;
  let last = null;
  for (const p of points) {
    if (!Array.isArray(p) || !isFiniteNum(p[0]) || !isFiniteNum(p[1])) continue;
    const lat = round5(p[1]);
    const lon = round5(p[0]);
    if (last && last[0] === lat && last[1] === lon) continue; // 연속 중복 제거
    last = [lat, lon];
    out.push(last);
  }
  return out;
}

function normStep(s) {
  const p = (s && s.properties) || {};
  const stops = Array.isArray(p.stops) ? p.stops : [];
  const names = [];
  for (const v of Array.isArray(p.vehicles) ? p.vehicles : []) {
    const n = str(v && v.name, 40);
    if (n && !names.includes(n)) names.push(n);
  }
  return {
    type: str(p.type, 30).toUpperCase() || 'UNKNOWN',
    guidance: str(p.guidance, 200),
    distance: Math.round(nonNeg(p.distance)),
    time: Math.round(nonNeg(p.time)),
    vehicles: names.slice(0, 20),
    stopCount: Math.max(0, stops.length - 1),
    firstStop: str(stops[0] && stops[0].name, 60),
    lastStop: str(stops.length > 1 ? stops[stops.length - 1].name : '', 60),
    path: normPath(s && s.path && s.path.points),
  };
}

function normRoute(r) {
  const p = (r && r.properties) || {};
  const f = (p.fare && typeof p.fare === 'object' ? p.fare : {});
  let fare = isFiniteNum(f.value) && f.value >= 0 ? Math.round(f.value) : null;
  let fareMin = null;
  let fareMax = null;
  // 요금이 { min, max } 범위로 오는 경우 (공항/광역 버스 등). 단일 값이 있으면 범위는 무시
  if (fare == null && isFiniteNum(f.min) && isFiniteNum(f.max) && f.min >= 0 && f.max >= 0) {
    fareMin = Math.round(Math.min(f.min, f.max));
    fareMax = Math.round(Math.max(f.min, f.max));
    if (fareMin === fareMax) {
      fare = fareMin;
      fareMin = fareMax = null;
    }
  }
  return {
    type: str(p.type, 30).toUpperCase() || 'UNKNOWN',
    totalDistance: Math.round(nonNeg(p.totalDistance)),
    totalTime: Math.round(nonNeg(p.totalTime)),
    transfers: Math.round(nonNeg(p.transfers)),
    fare, // 단일 요금 (범위로만 오면 null)
    fareMin,
    fareMax,
    steps: (Array.isArray(r && r.steps) ? r.steps : []).map(normStep),
  };
}

/** 후보(수십 개)에서 최대 MAX_ROUTES개: 유형(버스/지하철/복합)별 최단 시간 경로를 먼저 담고, 남는 자리는 빠른 순으로 채운 뒤 소요 시간순 정렬 */
function pickRoutes(routes) {
  const sorted = routes.slice().sort((a, b) => a.totalTime - b.totalTime);
  const chosen = [];
  const seen = new Set();
  for (const r of sorted) {
    if (chosen.length >= MAX_ROUTES) break;
    if (!seen.has(r.type)) {
      seen.add(r.type);
      chosen.push(r);
    }
  }
  for (const r of sorted) {
    if (chosen.length >= MAX_ROUTES) break;
    if (!chosen.includes(r)) chosen.push(r);
  }
  return chosen.sort((a, b) => a.totalTime - b.totalTime);
}

/** 카카오 응답 -> { status, landingURL, routes }. 알 수 없는 형태면 null */
function normalize(j) {
  if (!j || typeof j !== 'object') return null;
  const landing = j.properties && typeof j.properties.landingURL === 'string' && j.properties.landingURL.startsWith(LANDING_PREFIX) ? j.properties.landingURL.slice(0, 1000) : null;
  if (j.status === 'NO_RESULTS') return { status: 'NO_RESULTS', landingURL: landing, routes: [] };
  if (j.status !== 'OK' || !Array.isArray(j.routes)) return null;
  const routes = pickRoutes(j.routes.map(normRoute).filter((r) => r.steps.length > 0 || r.totalTime > 0));
  if (!routes.length) return { status: 'NO_RESULTS', landingURL: landing, routes: [] };
  return { status: 'OK', landingURL: landing, routes };
}

class TransitError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * opts: { db, env, fetchImpl, now }
 * lookup(query, ip) -> Promise<{ status, body, cache }>  (HTTP 응답 그대로 쓸 수 있는 형태)
 */
function createTransit(opts) {
  const db = opts.db;
  const env = opts.env || process.env;
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const now = opts.now || Date.now;
  const limiter = auth.createLimiter(RATE_MAX, RATE_WINDOW_MS);
  const inflight = new Map(); // cache key -> Promise<result>

  // 환경변수는 프로세스 시작 시 고정되므로 키를 바꾸면 서버를 재시작해야 한다
  const restKey = typeof env.TP_KAKAO_REST_KEY === 'string' ? env.TP_KAKAO_REST_KEY.trim() : '';
  const getKey = () => restKey;

  function cacheGet(k) {
    const row = db.getTransit(k);
    if (!row) return null;
    let body;
    try {
      body = JSON.parse(row.json);
    } catch (e) {
      return null;
    }
    const ttl = body && body.status === 'NO_RESULTS' ? TTL_NONE_MS : TTL_OK_MS;
    return now() - row.created_at < ttl ? body : null;
  }

  async function callKakao(p, key) {
    const url = `${KAKAO_URL}?start_x=${p.sx}&start_y=${p.sy}&end_x=${p.ex}&end_y=${p.ey}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await doFetch(url, { headers: { Authorization: `KakaoAK ${key}` }, signal: ctrl.signal });
    } catch (e) {
      throw new TransitError(e && e.name === 'AbortError' ? 504 : 502, e && e.name === 'AbortError' ? MSG.timeout : MSG.network);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) throw new TransitError(502, MSG.auth);
    if (res.status === 429) throw new TransitError(429, MSG.quota);
    if (!res.ok) throw new TransitError(502, MSG.upstream);
    let j;
    try {
      j = await res.json();
    } catch (e) {
      throw new TransitError(502, MSG.upstream);
    }
    const out = normalize(j);
    if (!out) throw new TransitError(502, MSG.upstream);
    return out;
  }

  async function lookup(query, ip) {
    const p = parseParams(query || {});
    if (!p) return { status: 400, body: { error: MSG.badParams } };
    const key = getKey();
    if (!key) return { status: 503, body: { error: MSG.noKey } };

    if (p.sx === p.ex && p.sy === p.ey) return { status: 200, body: { status: 'NO_RESULTS', landingURL: null, routes: [] }, cache: 'SKIP' };

    // v2|: 요금 범위(fareMin/fareMax) 추가 전에 캐시된 응답은 키가 달라 무시되고, TTL로 정리된다
    const ck = `v2|${p.sx.toFixed(5)},${p.sy.toFixed(5)}|${p.ex.toFixed(5)},${p.ey.toFixed(5)}`;
    const hit = cacheGet(ck);
    if (hit) return { status: 200, body: hit, cache: 'HIT' };

    // 같은 구간을 동시에 요청하면 카카오는 한 번만 호출한다
    if (inflight.has(ck)) return inflight.get(ck);
    if (limiter.blocked(ip)) return { status: 429, body: { error: MSG.rate } };
    limiter.fail(ip);

    const run = (async () => {
      try {
        const body = await callKakao(p, key);
        db.putTransit(ck, JSON.stringify(body), now());
        return { status: 200, body, cache: 'MISS' };
      } catch (e) {
        if (e instanceof TransitError) return { status: e.status, body: { error: e.message } };
        return { status: 502, body: { error: MSG.upstream } }; // 원문 메시지는 내보내지 않는다
      }
    })().finally(() => inflight.delete(ck));
    inflight.set(ck, run);
    return run;
  }

  return { lookup, hasKey: () => Boolean(restKey), purge: () => db.purgeTransit(now() - TTL_OK_MS) };
}

module.exports = { createTransit, normalize, parseParams, MSG };
