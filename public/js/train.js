/* train.js - 열차 시간표 자동 조회(TAGO, 서버 프록시 경유): 역 목록·장소→역 매칭·구간별 열차 목록 캐시. */
(function () {
  'use strict';
  const TP = (window.TP = window.TP || {});

  const LOOKUP_DAYS = 28; // 열차 조회 기간(오늘 ~ 오늘+LOOKUP_DAYS일). 조회 기간은 여기에서만 정한다
  const FAIL_TTL_MS = 60 * 1000; // 실패는 1분간 재요청하지 않음
  const TIMEOUT_MS = 15000;

  const pad = (n) => String(n).padStart(2, '0');
  const ymdOf = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  /** 조회 가능한 마지막 날짜 (표시용) */
  function lastLookupDate(now) {
    const d = new Date(now || Date.now());
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + LOOKUP_DAYS);
    return d;
  }
  /** 'YYYYMMDD'가 오늘 ~ 오늘+LOOKUP_DAYS 안인지 */
  function inWindow(ymd, now) {
    const t = new Date(now || Date.now());
    return /^\d{8}$/.test(ymd || '') && ymd >= ymdOf(t) && ymd <= ymdOf(lastLookupDate(t));
  }

  const stripTail = (n) => n.replace(/(KTX|SRT)$/i, '').replace(/역$/, '');
  /** 장소 이름 -> 역 이름 비교용: 공백·괄호 부분·끝의 KTX/SRT/'역' 제거 */
  const normName = (s) => stripTail(String(s || '').replace(/\s+/g, '').replace(/[(（][^)）]*[)）]/g, ''));
  /** 괄호를 붙인 형태('김천(구미)역' -> '김천구미'). '판교역(경기)' 처럼 괄호 앞의 '역'도 뗀다 (서버 tago.js 와 같은 규칙) */
  const joinedName = (s) => stripTail(String(s || '').replace(/\s+/g, '').replace(/역(?=[(（])/, '').replace(/[()（）]/g, ''));
  /** 역 목록에서 이름이 같은 역: 괄호를 붙인 이름을 먼저, 없으면 괄호를 뺀 이름 (shortcut: 같은 이름이 여럿이면 첫 번째) */
  function matchStation(stations, name) {
    const joined = joinedName(name);
    const bare = normName(name);
    if (!joined) return null;
    const list = stations || [];
    return list.find((s) => joinedName(s.name) === joined) || list.find((s) => normName(s.name) === bare) || null;
  }
  const hasPos = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon);
  const dist = (a, b) => TP.routing.haversine({ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon });
  const NEAR_M = 500; // 장소가 이 거리 안에 있는 역이면 같은 역으로 본다
  /** 좌표가 있는 역 중 장소에서 radiusM 안의 것 -> [{ station, distance }] 가까운 순 */
  function stationsWithin(place, radiusM) {
    if (!stations || !hasPos(place)) return [];
    return stations
      .filter(hasPos)
      .map((st) => ({ station: st, distance: dist(place, st) }))
      .filter((c) => c.distance <= radiusM)
      .sort((a, b) => a.distance - b.distance);
  }
  /** 'YYYYMMDDHHMM' -> 그 날 자정 기준 분 (다음 날 도착이면 1440 미만으로 접혀 arr < dep 이 된다) */
  const timeToMin = (s) => Number(String(s).slice(8, 10)) * 60 + Number(String(s).slice(10, 12));

  // ---- 조회 ----
  let stations = null; // 불러온 역 목록
  let stationFail = null; // { t, message }
  let stationPromise = null;
  const memory = new Map(); // `${depId}|${arrId}|${ymd}` -> { trips } (trips 비어 있으면 조회 결과 없음)
  const failed = new Map(); // key -> { t, message }
  const pending = new Map(); // key -> Promise

  async function getJson(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      let res;
      try {
        res = await fetch(url, { signal: ctrl.signal });
      } catch (e) {
        throw new Error('서버 연결 실패');
      }
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error((j && typeof j.error === 'string' && j.error) || `HTTP ${res.status}`);
      return j || {};
    } finally {
      clearTimeout(timer);
    }
  }

  function loadStations() {
    if (stations) return Promise.resolve();
    if (stationFail && Date.now() - stationFail.t < FAIL_TTL_MS) return Promise.resolve();
    if (!stationPromise) {
      stationPromise = getJson('/api/train/stations')
        .then((j) => {
          stations = Array.isArray(j.stations) ? j.stations : [];
          stationFail = null;
        })
        .catch((e) => { stationFail = { t: Date.now(), message: e.message }; })
        .finally(() => { stationPromise = null; });
    }
    return stationPromise;
  }

  /** 장소 -> TAGO 역: 좌표가 500m 안인 가장 가까운 역을 먼저, 없으면 이름으로 */
  function stationOf(place) {
    if (!stations || !place) return null;
    if (place.station) return place.station;
    const near = stationsWithin(place, NEAR_M)[0];
    return near ? near.station : matchStation(stations, place.name);
  }
  const tripKey = (a, b, ymd) => `${a.id}|${b.id}|${ymd}`;
  /** 화면의 조회 중 표시용 키: 역 목록 없이도 만들 수 있다 */
  const key = (from, to, ymd) => `train|${normName(from.name)}|${normName(to.name)}|${ymd}`;

  /** 캐시된 결과 (동기): { state:'loading' } | { state:'ok', trips } | { state:'none', reason, place?, message? } */
  function peek(from, to, ymd) {
    if (!inWindow(ymd)) return { state: 'none', reason: 'period' };
    if (!stations) {
      if (stationFail && Date.now() - stationFail.t < FAIL_TTL_MS) return { state: 'none', reason: 'error', message: stationFail.message };
      return { state: 'loading' };
    }
    const a = stationOf(from);
    const b = stationOf(to);
    if (!a || !b) return { state: 'none', reason: 'station', place: (!a ? from : to).name };
    const k = tripKey(a, b, ymd);
    const hit = memory.get(k);
    if (hit) return hit.trips.length ? { state: 'ok', trips: hit.trips } : { state: 'none', reason: 'noresult' };
    const f = failed.get(k);
    if (f && Date.now() - f.t < FAIL_TTL_MS) return { state: 'none', reason: 'error', message: f.message };
    return { state: 'loading' };
  }

  /** 역 목록 -> 구간 열차 조회. 항상 resolve (결과는 peek로 읽는다) */
  async function get(from, to, ymd) {
    if (!inWindow(ymd)) return;
    await loadStations();
    const a = stationOf(from);
    const b = stationOf(to);
    if (!a || !b) return;
    const k = tripKey(a, b, ymd);
    if (memory.has(k)) return;
    const f = failed.get(k);
    if (f && Date.now() - f.t < FAIL_TTL_MS) return;
    if (!pending.has(k)) {
      const p = getJson(`/api/train/trips?dep=${encodeURIComponent(a.id)}&arr=${encodeURIComponent(b.id)}&date=${ymd}`)
        .then((j) => {
          const trips = (Array.isArray(j.trips) ? j.trips : []).map((t) => ({
            no: String(t.no || ''), type: String(t.type || ''), dep: timeToMin(t.dep), arr: timeToMin(t.arr),
            charge: Number.isInteger(t.charge) && t.charge >= 0 ? t.charge : null,
          }));
          memory.set(k, { trips });
          failed.delete(k);
        })
        .catch((e) => { failed.set(k, { t: Date.now(), message: e.message }); })
        .finally(() => pending.delete(k));
      pending.set(k, p);
    }
    await pending.get(k);
  }

  const RECOMMEND_M = 20000;
  /** 장소에서 20km 안의 TAGO 역(좌표가 있는 것) -> 가까운 순 [{ name:'<역>역', lat, lon, hub:'train', distance, station }] (역 목록을 먼저 load 해야 한다) */
  function nearStations(place) {
    return stationsWithin(place, RECOMMEND_M).map(({ station, distance }) => ({
      name: /역$/.test(station.name) ? station.name : `${station.name}역`, lat: station.lat, lon: station.lon, hub: 'train', distance, station,
    }));
  }

  /** 이름 검색: 좌표가 있는 TAGO 역 중 이름에 검색어가 들어간('부산역'·'부산' 모두 부산, '김천구미'·'김천' 모두 김천(구미)) 것 -> nearStations 와 같은 모양, 장소에서 가까운 순 (역 목록을 먼저 load) */
  function searchStations(place, query, limit) {
    const nq = normName(query);
    const jq = joinedName(query);
    if (!stations || !nq) return [];
    return stations
      .filter((st) => hasPos(st) && (normName(st.name).includes(nq) || joinedName(st.name).includes(jq)))
      .map((station) => ({
        name: /역$/.test(station.name) ? station.name : `${station.name}역`, lat: station.lat, lon: station.lon, hub: 'train',
        distance: hasPos(place) ? dist(place, station) : null, station,
      }))
      .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))
      .slice(0, limit || 8);
  }

  /** 후보와 같은 순서의 열차 수(숫자, 또는 조회 실패면 { error: 안내 문구 }) -> 열차가 1편 이상이거나 조회에 실패한 후보, 순서 그대로 [{ ...cand, count }].
   *  조회 실패는 '열차 없음'이 아니므로 빼지 않는다(화면에 '열차 확인 못 함'과 원인을 보여 준다) */
  const withTrains = (cands, counts) => cands.map((c, i) => ({ ...c, count: counts[i] })).filter((c) => c.count > 0 || (c.count && c.count.error));

  /** 두 장소 사이 열차 수. 조회 실패면 { error: 서버가 준 안내 문구 }. side: 'dep'이면 후보 -> 고정역, 'arr'이면 고정역 -> 후보 */
  async function countTrips(cand, fixed, side, ymd) {
    const [a, b] = side === 'dep' ? [cand, fixed] : [fixed, cand];
    await get(a, b, ymd);
    const r = peek(a, b, ymd);
    if (r.state === 'ok') return r.trips.length;
    if (r.reason === 'noresult') return 0;
    return { error: r.message || '열차 조회에 실패했어요. 잠시 후 다시 시도해 주세요.' };
  }

  /** 후보마다 열차 수를 limit개씩 동시에 조회 -> counts 배열 (후보 순서) */
  async function countAll(cands, fixed, side, ymd, limit) {
    const counts = new Array(cands.length).fill(null);
    let next = 0;
    const worker = async () => { while (next < cands.length) { const i = next++; counts[i] = await countTrips(cands[i], fixed, side, ymd); } };
    await Promise.all(Array.from({ length: Math.min(limit || 3, cands.length) }, worker));
    return counts;
  }

  TP.train = { LOOKUP_DAYS, nearStations, searchStations, withTrains, countAll, load: loadStations, stationOf, lastLookupDate, inWindow, normName, matchStation, timeToMin, peek, get, key, ymdOf };
})();
