/* bus.js - 국토교통부 TAGO 고속·시외버스(ExpBusInfo/SuburbsBusInfo) 프록시.
 * - 서비스 키는 서버에서만 사용하고 브라우저로 내보내지 않는다 (열차와 같은 환경변수 TP_TAGO_KEY).
 * - 터미널 목록·(출발,도착) 짝·후보 힌트는 30일, 시간표는 결과 있음 24시간·결과 없음 1시간 캐시한다.
 * - 장소(카카오 장소 이름 + 좌표)로 TAGO 터미널 후보를 점수로 골라 실제 시간표가 있는 짝을 찾는다.
 * - TAGO 호출은 열차와 하나의 큐(server.js 의 createQueue(350))를 공유한다. */
'use strict';
const auth = require('./auth');
const tago = require('./tago');

const EXPRESS_BASE = 'https://apis.data.go.kr/1613000/ExpBusInfo/';
const INTERCITY_BASE = 'https://apis.data.go.kr/1613000/SuburbsBusInfo/';
const ROWS = 1000; // 터미널 목록·시간표 모두 한 쪽에 1000건
const TTL_TERMS_MS = 30 * 24 * 60 * 60 * 1000;
const TTL_OK_MS = 24 * 60 * 60 * 1000;
const TTL_NONE_MS = 60 * 60 * 1000;
const RATE_MAX = 30;
const RATE_WINDOW_MS = 60 * 1000;
const NAME_MAX = 60;
const MAX_CANDIDATES = 3; // 이름 후보 수 (이름 하나에 여러 id 가 있을 수 있다)
const MAX_TIMETABLE_REQ = 20; // 한 종류를 찾을 때 실제로 보내는 시간표 요청 상한
const MAX_HINTS = 5;
const PREFIX = 'tago-v5|bus|';

// 실제 터미널이 아닌 시스템성 이름 (고속버스 목록에 섞여 온다)
const SYSTEM_RE = /통합단말|모바일|수수료|라쿠카라차|구간$|공항왕복/;
// 이름 비교에서 지우는 일반 단어 (긴 것부터)
const GENERIC_RE = /고속버스|시외버스|버스|고속|시외|종합|공용|여객|터미널|간이|정류장|정류소|환승센터|환승|휴게소|상행|하행|승차|하차/g;
const SEPARATOR_RE = /[\s()（）\[\]·・/,._]/g;

// lookupDays: TAGO가 시간표를 주는 기간(오늘부터 며칠 뒤까지, 2026-10-31·11-21 관찰). 그보다 먼 날짜는 후보를 끝까지 헛되이 시도하게 되므로 부르지 않는다
const KINDS = [
  { id: 'express', key: 'exp', base: EXPRESS_BASE, termsOp: 'GetExpBusTrminlList', tripsOp: 'GetStrtpntAlocFndExpbusInfo', system: true, lookupDays: 2 },
  { id: 'intercity', key: 'sub', base: INTERCITY_BASE, termsOp: 'GetSuberbsBusTrminlList', tripsOp: 'GetStrtpntAlocFndSuberbsBusInfo', system: false, lookupDays: 1 },
];

/** 한국 시각 기준 오늘 + days 일의 'YYYYMMDD' */
function kstYmd(nowMs, days) {
  const d = new Date(nowMs + 9 * 3600 * 1000 + days * 86400 * 1000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}
/** 이 종류를 그 날짜로 조회할 수 있는가 (지난 날짜는 TAGO가 주므로 막지 않는다) */
const inWindow = (kind, date, nowMs) => date <= kstYmd(nowMs, kind.lookupDays);

const MSG = {
  noKey: '버스 조회를 쓰려면 서버에 공공데이터포털 TAGO 서비스 키(환경변수 TP_TAGO_KEY)를 설정해 주세요.',
  badParams: '조회 조건이 올바르지 않아요 (depName, arrName, depLat, depLon, arrLat, arrLon, date: YYYYMMDD)',
  auth: 'TAGO 서비스 키가 올바르지 않거나 권한이 없어요. 키와 활용 신청 상태를 확인해 주세요.',
  quota: 'TAGO 버스 API 호출 한도를 초과했어요. 잠시 후 다시 시도해 주세요.',
  upstream: 'TAGO 버스 서비스에서 오류가 발생했어요. 잠시 후 다시 시도해 주세요.',
  timeout: 'TAGO 버스 서비스 응답이 지연되고 있어요. 잠시 후 다시 시도해 주세요.',
  network: 'TAGO 버스 서비스에 연결할 수 없어요. 네트워크를 확인해 주세요.',
  rate: '버스 조회 요청이 너무 많아요. 잠시 후 다시 시도해 주세요.',
};

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' ? String(v).slice(0, max) : '');
/** 'YYYYMMDDHHMM' 또는 초까지 있는 'YYYYMMDDHHMMSS' -> 'YYYYMMDDHHMM', 형식이 다르면 '' */
const hhmm = (v) => (/^\d{12}(?:\d{2})?$/.test(str(v, 20).trim()) ? str(v, 20).trim().slice(0, 12) : '');

/** TAGO 버스 시간표 한 건 -> { kind, grade, dep, arr, charge } | null */
function normTrip(kind, x) {
  const dep = hhmm(x.depPlandTime);
  const arr = hhmm(x.arrPlandTime);
  if (!dep || !arr) return null;
  const fare = str(x.charge, 20).trim();
  const c = Number(fare);
  return { kind, grade: str(x.gradeNm, 30).trim(), dep, arr, charge: fare !== '' && Number.isInteger(c) && c >= 0 ? c : null };
}

const cmpTrip = (a, b) => (a.dep < b.dep ? -1 : a.dep > b.dep ? 1 : a.arr < b.arr ? -1 : a.arr > b.arr ? 1 : 0);

/** 이름 비교용 핵심어: 공백·괄호·구분자와 일반 단어(고속버스/터미널 등)를 지운다 */
const normCore = (s) => String(s || '').replace(SEPARATOR_RE, '').replace(GENERIC_RE, '');

/** 핵심어의 2글자 조각 (1글자 핵심어는 그 자체를 한 조각으로 센다) */
function gramsOf(core) {
  if (!core) return [];
  if (core.length < 2) return [core];
  const out = [];
  for (let i = 0; i + 2 <= core.length; i++) out.push(core.slice(i, i + 2));
  return out;
}

/** TAGO 터미널 이름이 장소 이름과 얼마나 닮았는가: 0..1 */
function scoreName(tagoName, placeName) {
  const grams = gramsOf(normCore(tagoName));
  if (!grams.length) return 0;
  const place = normCore(placeName);
  return grams.filter((g) => place.includes(g)).length / grams.length;
}

/** 점수 0.5 이상인 이름 상위 3개 -> 그 이름들의 모든 터미널 id (점수 높은 순, 점수가 같으면 핵심어가 긴 이름 먼저) */
function candidatesOf(terminals, placeName) {
  const byName = new Map(); // name -> { name, core, score, ids }
  for (const t of terminals) {
    let e = byName.get(t.name);
    if (!e) {
      const core = normCore(t.name);
      e = { name: t.name, core, score: scoreName(t.name, placeName), ids: [] };
      byName.set(t.name, e);
    }
    e.ids.push(t.id);
  }
  const picked = [...byName.values()]
    .filter((e) => e.score >= 0.5)
    .sort((a, b) => b.score - a.score || b.core.length - a.core.length)
    .slice(0, MAX_CANDIDATES);
  const seen = new Set();
  const out = [];
  for (const e of picked) {
    for (const id of e.ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: e.name });
    }
  }
  return out;
}

const placeKey = (p) => `${String(p.name).trim()}@${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;

/** 쿼리의 한쪽 장소를 검증한다 (이름 60자 이하, 좌표는 한국 근처) */
function placeOf(q, prefix) {
  const raw = q[`${prefix}Name`];
  const name = typeof raw === 'string' ? raw.trim() : '';
  const lat = Number(q[`${prefix}Lat`]);
  const lon = Number(q[`${prefix}Lon`]);
  const ok = name.length > 0 && name.length <= NAME_MAX
    && Number.isFinite(lat) && Number.isFinite(lon) && lat >= 33 && lat <= 39 && lon >= 124 && lon <= 132;
  return { name, lat, lon, ok };
}

const emptyBody = () => ({ status: 'NO_RESULTS', trips: [], terminals: { express: null, intercity: null }, errors: [], outOfWindow: [] });

/**
 * opts: { db, env, fetchImpl, now, queue, retryWaitMs, minIntervalMs }
 * trips(query, ip) -> Promise<{ status, body, cache }>  (HTTP 응답 그대로 쓸 수 있는 형태)
 */
function createBus(opts) {
  const db = opts.db;
  const env = opts.env || process.env;
  const now = opts.now || Date.now;
  const limiter = auth.createLimiter(RATE_MAX, RATE_WINDOW_MS);
  const inflight = new Map(); // 쿼리 키 -> Promise<result>
  const client = tago.makeClient({ env, fetchImpl: opts.fetchImpl, queue: opts.queue, retryWaitMs: opts.retryWaitMs, msg: MSG, toError: tago.makeCodeError(MSG) });
  const key = client.key;

  /** created_at 기준 TTL 이 지나지 않은 캐시 본문 (없으면 null) */
  function readCache(k, ttl) {
    const row = db.getTransit(k);
    if (!row || now() - row.created_at >= ttl) return null;
    try {
      return JSON.parse(row.json);
    } catch (e) {
      return null;
    }
  }
  const putCache = (k, body) => db.putTransit(k, JSON.stringify(body), now());
  const termsKey = (kind) => `${PREFIX}terms|${kind.key}`;
  const pairKey = (kind, dep, arr) => `${PREFIX}pair|${kind.id}|${placeKey(dep)}|${placeKey(arr)}`;
  const hintKey = (kind, pk) => `${PREFIX}hint|${kind.id}|${pk}`;
  const tripsKey = (kind, a, b, date) => `${PREFIX}trips|${kind.id}|${a}|${b}|${date}`;

  /** 터미널 목록 (30일 캐시). 고속은 시스템성 이름을 뺀다 */
  async function terminals(kind) {
    const hit = readCache(termsKey(kind), TTL_TERMS_MS);
    if (hit && Array.isArray(hit.terminals)) return hit.terminals;
    const rows = await client.callAll(kind.termsOp, {}, kind.base); // numOfRows/pageNo 는 callAll 이 붙인다
    const seen = new Set();
    const list = [];
    for (const x of rows) {
      const id = str(x.terminalId, 20).trim();
      const name = str(x.terminalNm, NAME_MAX).trim();
      if (!id || !name || seen.has(id)) continue;
      if (kind.system && SYSTEM_RE.test(name)) continue;
      seen.add(id);
      const city = str(x.cityName, 30).trim();
      list.push(city ? { id, name, city } : { id, name });
    }
    if (!list.length) throw new tago.TagoError(502, MSG.upstream);
    const body = { terminals: list };
    putCache(termsKey(kind), body);
    return list;
  }

  /** 캐시된 시간표 (결과 있음 24시간, 없음 1시간). 없으면 null */
  function readTrips(kind, a, b, date) {
    const row = db.getTransit(tripsKey(kind, a, b, date));
    if (!row) return null;
    let body;
    try {
      body = JSON.parse(row.json);
    } catch (e) {
      return null;
    }
    if (!body || !Array.isArray(body.trips)) return null;
    return now() - row.created_at < (body.trips.length ? TTL_OK_MS : TTL_NONE_MS) ? body : null;
  }

  /** 시간표 조회 (캐시 우선). 실제 요청은 budget 을 하나씩 쓰고, 다 쓰면 null(모르는 상태)을 돌려준다. 오류는 TagoError */
  async function tripsFor(kind, a, b, date, budget) {
    const hit = readTrips(kind, a, b, date);
    if (hit) return hit;
    if (budget.left <= 0) return null;
    budget.left--;
    // callAll 이 numOfRows=1000·pageNo 를 붙이고 모든 쪽을 모은다 (빠뜨리면 TAGO 기본 10건만 온다)
    const rows = await client.callAll(kind.tripsOp, { depTerminalId: a, arrTerminalId: b, depPlandTime: date }, kind.base);
    const body = { trips: rows.map((x) => normTrip(kind.id, x)).filter(Boolean).sort(cmpTrip) };
    putCache(tripsKey(kind, a, b, date), body); // 오류는 위에서 throw 되므로 캐시되지 않는다
    return body;
  }

  function readHints(kind, pk) {
    const hit = readCache(hintKey(kind, pk), TTL_TERMS_MS);
    return hit && Array.isArray(hit.ids) ? hit.ids.filter((x) => typeof x === 'string').slice(0, MAX_HINTS) : [];
  }
  /** 성공한 id 를 힌트 맨 앞에 둔다 (최근 것 먼저, 최대 5개) */
  function saveHint(kind, pk, id) {
    const ids = readHints(kind, pk).filter((x) => x !== id);
    putCache(hintKey(kind, pk), { ids: [id, ...ids].slice(0, MAX_HINTS) });
  }

  /** 힌트에 있는 id 를 후보 목록 앞으로 (힌트 순서 유지) */
  function hintFirst(list, hints) {
    const left = new Map(list.map((x) => [x.id, x]));
    const out = [];
    for (const id of hints) {
      const x = left.get(id);
      if (!x) continue;
      out.push(x);
      left.delete(id);
    }
    for (const x of list) if (left.has(x.id)) out.push(x);
    return out;
  }

  /** 이 종류를 업스트림 호출 없이 답할 수 있는가 (터미널 목록 + 짝 + 시간표 캐시, 또는 캐시된 결과 없음) */
  function fullyCached(kind, dep, arr, date) {
    const terms = readCache(termsKey(kind), TTL_TERMS_MS);
    if (!terms || !Array.isArray(terms.terminals)) return false;
    if (!candidatesOf(terms.terminals, dep.name).length || !candidatesOf(terms.terminals, arr.name).length) return true;
    const pair = readCache(pairKey(kind, dep, arr), TTL_TERMS_MS);
    if (!pair || pair.a === pair.b) return false;
    const hit = readTrips(kind, pair.a, pair.b, date);
    return Boolean(hit && hit.trips.length); // 빈 시간표는 후보를 다시 찾으므로 캐시 적중이 아니다
  }

  /** 한 종류(고속/시외)를 찾는다. 오류는 TagoError 로 던진다 */
  async function resolveKind(kind, dep, arr, date) {
    const terms = await terminals(kind);
    const names = new Map(terms.map((t) => [t.id, t.name]));
    const depPk = placeKey(dep);
    const arrPk = placeKey(arr);
    const pk = pairKey(kind, dep, arr);
    const budget = { left: MAX_TIMETABLE_REQ };
    const done = (tripRows, depName, arrName) => ({ trips: tripRows, terminals: { dep: depName, arr: arrName } });

    // 1) 저장된 짝이 있으면 먼저 확인한다 (결과 없음이면 지우고 후보를 다시 찾는다)
    const pair = readCache(pk, TTL_TERMS_MS);
    if (pair && typeof pair.a === 'string' && typeof pair.b === 'string' && pair.a !== pair.b && names.has(pair.a) && names.has(pair.b)) {
      const hit = await tripsFor(kind, pair.a, pair.b, date, budget);
      if (hit && hit.trips.length) {
        saveHint(kind, depPk, pair.a);
        saveHint(kind, arrPk, pair.b);
        return done(hit.trips, names.get(pair.a), names.get(pair.b));
      }
      if (hit) db.deleteTransit(pk);
    }

    // 2) 이름 후보
    const depC = candidatesOf(terms, dep.name);
    const arrC = candidatesOf(terms, arr.name);
    if (!depC.length || !arrC.length) return { trips: [], terminals: null };

    // 3) 힌트가 있는 id 를 앞에 두고, (힌트, 순서) 점수로 시도 순서를 정한다
    const depHints = readHints(kind, depPk);
    const arrHints = readHints(kind, arrPk);
    const depList = hintFirst(depC, depHints);
    const arrList = hintFirst(arrC, arrHints);
    const pairs = [];
    depList.forEach((a, i) => arrList.forEach((b, j) => {
      if (a.id === b.id) return;
      const s = (depHints.includes(a.id) ? 0 : 1) + (arrHints.includes(b.id) ? 0 : 1);
      pairs.push({ a, b, s, pos: i + j });
    }));
    pairs.sort((x, y) => x.s - y.s || x.pos - y.pos);

    // 4) 시간표가 있는 첫 짝에서 멈춘다 (오류는 0건으로 보지 않고 그대로 알린다)
    for (const p of pairs) {
      const hit = await tripsFor(kind, p.a.id, p.b.id, date, budget);
      if (!hit) break; // 요청 상한 소진
      if (!hit.trips.length) continue;
      putCache(pk, { a: p.a.id, b: p.b.id });
      saveHint(kind, depPk, p.a.id);
      saveHint(kind, arrPk, p.b.id);
      return done(hit.trips, p.a.name, p.b.name);
    }
    return { trips: [], terminals: null };
  }

  async function trips(query, ip) {
    const q = query || {};
    const dep = placeOf(q, 'dep');
    const arr = placeOf(q, 'arr');
    if (!dep.ok || !arr.ok || !tago.validDate(q.date)) return { status: 400, body: { error: MSG.badParams } };
    if (!key) return { status: 503, body: { error: MSG.noKey } };
    if (placeKey(dep) === placeKey(arr)) return { status: 200, body: emptyBody(), cache: 'SKIP' };

    const kinds = KINDS.filter((k) => inWindow(k, q.date, now()));
    const outOfWindow = KINDS.filter((k) => !kinds.includes(k)).map((k) => k.id); // 조회 기간 밖이라 부르지 않은 종류
    if (!kinds.length) return { status: 200, body: { ...emptyBody(), outOfWindow }, cache: 'SKIP' };

    const ck = `${PREFIX}trips|${placeKey(dep)}|${placeKey(arr)}|${q.date}`;
    if (inflight.has(ck)) return inflight.get(ck); // 같은 요청은 하나로 합친다
    const full = kinds.every((k) => fullyCached(k, dep, arr, q.date));
    if (!full) {
      if (limiter.blocked(ip)) return { status: 429, body: { error: MSG.rate } };
      limiter.fail(ip);
    }

    const run = (async () => {
      const found = [];
      const terminalsOut = { express: null, intercity: null };
      const errors = [];
      let okKinds = 0;
      let firstFail = null;
      for (const kind of kinds) {
        try {
          const r = await resolveKind(kind, dep, arr, q.date);
          okKinds++;
          if (r.trips.length) {
            terminalsOut[kind.id] = r.terminals;
            found.push(...r.trips);
          }
        } catch (e) {
          const known = e instanceof tago.TagoError;
          // 원문 메시지는 내보내지 않는다 (알 수 없는 오류는 502)
          if (!firstFail) firstFail = { status: known ? e.status : 502, message: known ? e.message : MSG.upstream };
          errors.push(known ? e.message : MSG.upstream);
        }
      }
      if (!okKinds) return { status: firstFail.status, body: { error: firstFail.message } };
      found.sort(cmpTrip);
      return {
        status: 200,
        body: { status: found.length ? 'OK' : 'NO_RESULTS', trips: found, terminals: terminalsOut, errors, outOfWindow },
        cache: full ? 'HIT' : 'MISS',
      };
    })().finally(() => inflight.delete(ck));
    inflight.set(ck, run);
    return run;
  }

  return {
    trips,
    hasKey: () => Boolean(key),
    // tago.purge 와 같은 30일 지움: 24시간/1시간 TTL 판정은 읽을 때 하므로 영향이 없다
    purge: () => db.purgeTago(now() - TTL_TERMS_MS),
  };
}

module.exports = { createBus, normTrip, scoreName, candidatesOf, placeKey, kstYmd, MSG };
