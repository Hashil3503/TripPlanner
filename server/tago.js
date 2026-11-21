/* tago.js - 국토교통부 TAGO 열차정보(TrainInfo) 프록시.
 * - 서비스 키는 서버에서만 사용하고 브라우저로 내보내지 않는다 (환경변수 TP_TAGO_KEY).
 * - 역 목록(30일, 카카오 REST 키 TP_KAKAO_REST_KEY 가 있으면 좌표 포함)과 열차 시간표·요금(성공 6시간, 결과 없음 1시간)을 작게 정규화해 SQLite(transit_cache)에 캐시한다.
 * - 업스트림 호출(캐시 미스)은 IP당 분당 30회로 제한한다. */
'use strict';
const auth = require('./auth');

const BASE = 'https://apis.data.go.kr/1613000/TrainInfo/';
const TIMEOUT_MS = 10 * 1000;
const TTL_STATIONS_MS = 30 * 24 * 60 * 60 * 1000;
const TTL_OK_MS = 6 * 60 * 60 * 1000;
const TTL_NONE_MS = 60 * 60 * 1000;
const ROWS = 1000;
const MAX_PAGES = 10;
const RATE_MAX = 30;
const RATE_WINDOW_MS = 60 * 1000;
const PREFIX = 'tago-v5|'; // v5: 역 좌표 대조 규칙 변경(시·도 대조, 느슨한 이름 일치) — 옛 역 목록 캐시를 버린다
const STATIONS_KEY = `${PREFIX}stations`;
const KAKAO_URL = 'https://dapi.kakao.com/v2/local/search/keyword.json';
const KAKAO_CONCURRENCY = 5;
const ID_RE = /^NAT[0-9A-Z]{5,9}$/;

const MSG = {
  noKey: '열차 조회를 쓰려면 서버에 공공데이터포털 TAGO 서비스 키(환경변수 TP_TAGO_KEY)를 설정해 주세요.',
  badParams: '조회 조건이 올바르지 않아요 (dep, arr: 역 ID, date: YYYYMMDD)',
  auth: 'TAGO 서비스 키가 올바르지 않거나 권한이 없어요. 키와 활용 신청 상태를 확인해 주세요.',
  quota: 'TAGO 열차 API 호출 한도를 초과했어요. 잠시 후 다시 시도해 주세요.',
  upstream: 'TAGO 열차 서비스에서 오류가 발생했어요. 잠시 후 다시 시도해 주세요.',
  timeout: 'TAGO 열차 서비스 응답이 지연되고 있어요. 잠시 후 다시 시도해 주세요.',
  network: 'TAGO 열차 서비스에 연결할 수 없어요. 네트워크를 확인해 주세요.',
  rate: '열차 조회 요청이 너무 많아요. 잠시 후 다시 시도해 주세요.',
};

class TagoError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** 실제 달력 날짜인 YYYYMMDD 인가 */
function validDate(s) {
  if (typeof s !== 'string' || !/^\d{8}$/.test(s)) return false;
  const y = +s.slice(0, 4);
  const m = +s.slice(4, 6);
  const d = +s.slice(6, 8);
  const t = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** items.item 은 여러 건이면 배열, 한 건이면 객체, 없으면 items 가 '' 로 온다 */
function itemsOf(j) {
  const items = j && j.response && j.response.body && j.response.body.items;
  if (!items || typeof items !== 'object') return [];
  const it = items.item;
  return (Array.isArray(it) ? it : it ? [it] : []).filter((x) => x && typeof x === 'object');
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' ? String(v).slice(0, max) : '');
/** 'YYYYMMDDHHMMSS' -> 'YYYYMMDDHHMM' (초 제거), 형식이 다르면 '' */
const hhmm = (v) => (/^\d{14}$/.test(str(v, 20)) ? str(v, 20).slice(0, 12) : '');

function normTrip(x) {
  const dep = hhmm(x.depplandtime);
  const arr = hhmm(x.arrplandtime);
  if (!dep || !arr) return null;
  const fare = str(x.adultcharge, 12).trim();
  const c = Number(fare);
  const no = str(x.trainno, 10).trim().replace(/^0+(?=\d)/, ''); // '00105' -> '105'
  return { no, type: str(x.traingradename, 30).trim(), dep, arr, charge: fare !== '' && Number.isInteger(c) && c >= 0 ? c : null };
}

function normTrips(rows) {
  const trips = rows.map(normTrip).filter(Boolean).sort((a, b) => (a.dep < b.dep ? -1 : a.dep > b.dep ? 1 : a.arr < b.arr ? -1 : a.arr > b.arr ? 1 : 0));
  return { status: trips.length ? 'OK' : 'NO_RESULTS', trips };
}

/** 역 이름 비교용: 공백·끝의 KTX/SRT/'역' 제거 */
const stationKey = (s) => s.replace(/\s+/g, '').replace(/(KTX|SRT)$/i, '').replace(/역$/, '');
/** 괄호는 내용만 남기고 붙인다. '판교역(경기)' 처럼 괄호 앞의 '역'도 뗀다 */
const joinedKey = (name) => stationKey(name.replace(/\s+/g, '').replace(/역(?=[(（])/, '').replace(/[()（）]/g, ''));
/** '김천(구미)' -> ['김천구미', '김천']: 괄호를 붙인 이름을 먼저, 괄호 부분을 뺀 이름을 그다음 */
function nameKeys(name) {
  const joined = joinedKey(name);
  const bare = stationKey(name.replace(/[(（][^)）]*[)）]/g, ''));
  return joined === bare ? [joined] : [joined, bare];
}

/** 카카오 검색어용: 괄호·가운뎃점 같은 특수문자를 공백으로 ('판교(경기)' -> '판교 경기') */
const searchName = (s) => s.replace(/[()（）·・[\]/,._]/g, ' ').replace(/\s+/g, ' ').trim();
/** 카카오에 남은 폐역·화물역 표기: 같은 조건이면 뒤로 (TAGO에 있는 역이면 위치는 같은 곳) */
const DEAD_RE = /폐역|화물역|신호장/;
/** 카카오 이름의 끝 노선 표기(' 1호선', ' 경춘선', ' 공항철도')와 폐역 표기(' (폐역)', '화물역' -> '역')를 뗀 비교용 이름 */
const docKey = (n) => joinedKey(String(n || '').replace(/\s*[(（]폐역[)）]/g, '').replace(/(화물|신호장)(?=역|$)/g, '').replace(/\s+\S*(선|철도)$/, ''));
/** 장소 분류 우선순위: 기차역 > 지하철·전철역 (낮을수록 우선, 철도역이 아니면 null) */
const tierOf = (c) => (/기차역/.test(c) ? 0 : /지하철,전철|전철역|지하철역/.test(c) ? 1 : null);

// 시·도 이름 -> 비교용 짧은 이름. TAGO는 '충청북도', 카카오 주소는 '충북'처럼 쓴다
const REGION_PREFIX = [['서울', '서울'], ['부산', '부산'], ['대구', '대구'], ['인천', '인천'], ['광주', '광주'], ['대전', '대전'], ['울산', '울산'], ['세종', '세종'], ['경기', '경기'], ['강원', '강원'],
  ['충청북', '충북'], ['충북', '충북'], ['충청남', '충남'], ['충남', '충남'], ['전라북', '전북'], ['전북', '전북'], ['전라남', '전남'], ['전남', '전남'], ['경상북', '경북'], ['경북', '경북'], ['경상남', '경남'], ['경남', '경남'], ['제주', '제주']];
function regionsOf(s) {
  const t = String(s || '');
  if (t.startsWith('전남광주')) return ['전남', '광주']; // 카카오 주소의 '전남광주통합특별시'
  const hit = REGION_PREFIX.find(([p]) => t.startsWith(p));
  return hit ? [hit[1]] : [];
}
/** TAGO 역의 시·도와 카카오 주소의 시·도가 같은가. 한쪽이라도 모르면 막지 않는다 */
function sameRegion(city, address) {
  const a = regionsOf(city);
  const b = regionsOf(String(address || '').split(' ')[0]);
  return !a.length || !b.length || a.some((x) => b.includes(x));
}

/** 카카오 키워드 검색 결과(documents) -> { lat, lon } | null. 철도역 분류이고 시·도가 같은 곳 중에서
 *  ① 이름이 같은 곳 ② 이름을 포함하는 곳(남춘천보다 춘천 먼저) ③ 둘 다 없으면 검색 순서대로 이름 앞 두 글자가 같은 첫 곳('여수EXPO' -> '여수엑스포역').
 *  ③은 다른 TAGO 역 이름인 장소는 건너뛴다(others: 모든 역의 nameKeys, '망상해변'이 '망상역'을 잡지 않고 그다음 '망상해수욕장역'으로).
 *  같은 순위면 운영 중인 기차역 > 지하철 > 폐역 표기. 못 찾으면 추측하지 않는다 */
function pickStation(docs, name, city, others) {
  const keys = nameKeys(name);
  const rail = (docs || []).filter((d) => d && tierOf(d.category_name || '') !== null && sameRegion(city, d.address_name) && Number.isFinite(parseFloat(d.y)) && Number.isFinite(parseFloat(d.x)));
  let best = null;
  let bestRank = Infinity;
  for (const d of rail) {
    const k = docKey(d.place_name);
    const match = keys.includes(k) ? 0 : keys.some((x) => k.includes(x)) ? 1 : null;
    if (match === null) continue;
    const rank = match * 10 + (DEAD_RE.test(d.place_name) ? 4 : 0) + tierOf(d.category_name) * 2; // 폐역 표기는 운영 중인 지하철역보다도 뒤
    if (rank < bestRank) { best = d; bestRank = rank; }
  }
  if (!best && keys[0].length >= 2) {
    const head = keys[0].slice(0, 2);
    best = rail.find((d) => { const k = docKey(d.place_name); return k.startsWith(head) && !(others && others.has(k)); }) || null;
  }
  return best ? { lat: parseFloat(best.y), lon: parseFloat(best.x) } : null;
}

/** TAGO 오류 코드/본문 -> TagoError. 알 수 없는 오류는 502 */
function codeError(code, text) {
  const c = String(code || '');
  if (c === '22' || c === '23' || /LIMITED_NUMBER_OF_SERVICE_REQUESTS/.test(text || '')) return new TagoError(429, MSG.quota); // 22: 하루 한도, 23: 초당 한도
  if (['30', '31', '32', '33'].includes(c) || /SERVICE_KEY|SERVICE_ACCESS_DENIED|UNREGISTERED/.test(text || '')) return new TagoError(502, MSG.auth);
  return new TagoError(502, MSG.upstream);
}

/**
 * opts: { db, env, fetchImpl, now }
 * stations(ip) / trips(query, ip) -> Promise<{ status, body, cache }>  (HTTP 응답 그대로 쓸 수 있는 형태)
 */
function createTago(opts) {
  const db = opts.db;
  const env = opts.env || process.env;
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const now = opts.now || Date.now;
  const limiter = auth.createLimiter(RATE_MAX, RATE_WINDOW_MS);
  const inflight = new Map(); // cache key -> Promise<result>

  // 환경변수는 프로세스 시작 시 고정되므로 키를 바꾸면 서버를 재시작해야 한다
  const key = typeof env.TP_TAGO_KEY === 'string' ? env.TP_TAGO_KEY.trim() : '';
  const kakaoKey = typeof env.TP_KAKAO_REST_KEY === 'string' ? env.TP_KAKAO_REST_KEY.trim() : '';

  function cacheGet(k) {
    const row = db.getTransit(k);
    if (!row) return null;
    let body;
    try {
      body = JSON.parse(row.json);
    } catch (e) {
      return null;
    }
    const ttl = k === STATIONS_KEY ? TTL_STATIONS_MS : body && body.status === 'NO_RESULTS' ? TTL_NONE_MS : TTL_OK_MS;
    return now() - row.created_at < ttl ? body : null;
  }

  /** 한 번 호출 -> { rows, total }. 오류는 TagoError */
  async function call(op, params) {
    const u = new URL(BASE + op);
    u.searchParams.set('serviceKey', key);
    u.searchParams.set('_type', 'json');
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    let text;
    try {
      res = await doFetch(u.toString(), { signal: ctrl.signal });
      text = await res.text();
    } catch (e) {
      throw new TagoError(e && e.name === 'AbortError' ? 504 : 502, e && e.name === 'AbortError' ? MSG.timeout : MSG.network);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) throw new TagoError(502, MSG.auth);
    if (res.status === 429) throw new TagoError(429, MSG.quota);
    let j;
    try {
      j = JSON.parse(text);
    } catch (e) {
      // 오류가 XML(OpenAPI_ServiceResponse)로 오는 경우
      const m = /<returnReasonCode>\s*(\d+)\s*<\/returnReasonCode>/.exec(text);
      throw codeError(m && m[1], text);
    }
    const header = j && j.response && j.response.header;
    if (!res.ok || !header) throw codeError(j && j.resultCode, '');
    const code = String(header.resultCode);
    if (code === '03') return { rows: [], total: 0 }; // NODATA_ERROR
    if (code !== '00') throw codeError(code, '');
    const total = Number(j.response.body && j.response.body.totalCount);
    return { rows: itemsOf(j), total: Number.isFinite(total) ? total : 0 };
  }

  /** 모든 페이지를 모아 반환 */
  async function callAll(op, params) {
    const all = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { rows, total } = await call(op, { ...params, numOfRows: ROWS, pageNo: page });
      all.push(...rows);
      if (!rows.length || all.length >= total) break;
    }
    return all;
  }

  async function fetchStations() {
    const cities = (await callAll('GetCtyCodeList', {})).filter((c) => c.citycode && c.cityname);
    const lists = await Promise.all(cities.map((c) => callAll('GetCtyAcctoTrainSttnList', { cityCode: c.citycode })));
    const seen = new Set();
    const stations = [];
    cities.forEach((c, i) => {
      for (const s of lists[i]) {
        const id = str(s.nodeid, 20);
        const name = str(s.nodename, 40).trim();
        if (!ID_RE.test(id) || !name || seen.has(id)) continue;
        seen.add(id);
        stations.push({ id, name, city: str(c.cityname, 20) });
      }
    });
    if (!stations.length) throw new TagoError(502, MSG.upstream);
    await attachCoords(stations);
    return { stations };
  }

  async function kakaoSearch(query, name, city, others) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await doFetch(`${KAKAO_URL}?query=${encodeURIComponent(query)}`, { headers: { Authorization: `KakaoAK ${kakaoKey}` }, signal: ctrl.signal });
      if (!res.ok) return null;
      return pickStation((JSON.parse(await res.text()) || {}).documents, name, city, others);
    } finally { clearTimeout(timer); }
  }

  /** 카카오 REST 키워드 검색으로 역마다 좌표를 붙인다(TAGO는 좌표가 없다). 키가 없거나 실패하면 그 역은 null */
  async function attachCoords(stations) {
    for (const s of stations) { s.lat = null; s.lon = null; }
    if (!kakaoKey) return;
    const others = new Set(stations.flatMap((s) => nameKeys(s.name)));
    let next = 0;
    const worker = async () => {
      while (next < stations.length) {
        const s = stations[next++];
        try {
          const q0 = searchName(s.name);
          for (const q of [`${q0}역`, `${q0} 기차역`]) { // 첫 검색에서 못 찾으면 한 번 더
            const found = await kakaoSearch(q, s.name, s.city, others);
            if (found) { s.lat = found.lat; s.lon = found.lon; break; }
          }
        } catch (e) { /* 이 역은 좌표 없음 */ }
      }
    };
    await Promise.all(Array.from({ length: KAKAO_CONCURRENCY }, worker));
  }

  /** 캐시 -> 진행 중 요청 공유 -> 호출 제한 -> 업스트림 호출 -> 캐시 저장 */
  async function cached(ck, ip, load) {
    if (!key) return { status: 503, body: { error: MSG.noKey } };
    const hit = cacheGet(ck);
    if (hit) return { status: 200, body: hit, cache: 'HIT' };
    if (inflight.has(ck)) return inflight.get(ck);
    if (limiter.blocked(ip)) return { status: 429, body: { error: MSG.rate } };
    limiter.fail(ip);
    const run = (async () => {
      try {
        const body = await load();
        db.putTransit(ck, JSON.stringify(body), now());
        return { status: 200, body, cache: 'MISS' };
      } catch (e) {
        if (e instanceof TagoError) return { status: e.status, body: { error: e.message } };
        return { status: 502, body: { error: MSG.upstream } }; // 원문 메시지는 내보내지 않는다
      }
    })().finally(() => inflight.delete(ck));
    inflight.set(ck, run);
    return run;
  }

  const stations = (ip) => cached(STATIONS_KEY, ip, fetchStations);

  async function trips(query, ip) {
    const q = query || {};
    if (!ID_RE.test(q.dep || '') || !ID_RE.test(q.arr || '') || !validDate(q.date)) return { status: 400, body: { error: MSG.badParams } };
    if (q.dep === q.arr) return { status: 200, body: { status: 'NO_RESULTS', trips: [] }, cache: 'SKIP' };
    const ck = `${PREFIX}trips|${q.dep}|${q.arr}|${q.date}`;
    return cached(ck, ip, async () => normTrips(await callAll('GetStrtpntAlocFndTrainInfo', { depPlaceId: q.dep, arrPlaceId: q.arr, depPlandTime: q.date })));
  }

  return {
    stations,
    trips,
    hasKey: () => Boolean(key),
    purge: () => db.purgeTago(now() - TTL_STATIONS_MS),
  };
}

module.exports = { createTago, normTrips, validDate, nameKeys, pickStation, MSG };
