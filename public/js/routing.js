/* routing.js - OSRM(FOSSGIS) 경로 조회 + 카카오 대중교통(서버 /api/transit) + 캐시 + 실패 시 직선거리 기반 추정 */
(function () {
  'use strict';
  const TP = (window.TP = window.TP || {});

  const ENDPOINTS = {
    car: 'https://routing.openstreetmap.de/routed-car/route/v1/driving/',
    foot: 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/',
    bike: 'https://routing.openstreetmap.de/routed-bike/route/v1/bike/',
  };
  const CACHE_KEY = 'tripplanner.routecache.v2'; // v2: 대중교통 실경로 추가 (v1의 도보/자전거/자동차 항목만 이어받는다)
  const OLD_CACHE_KEY = 'tripplanner.routecache.v1';
  const CACHE_MAX = 400;
  const CACHE_BUDGET = 2500000; // localStorage 저장 문자 수 상한 (대중교통 경로점이 커서 오래된 것부터 버린다)
  const FAIL_TTL_MS = 60 * 1000; // 실패한 구간은 1분간 재요청하지 않음
  const MAX_CONCURRENT = 2;
  const TIMEOUT_MS = 12000;
  const MAX_POINTS = 250; // 저장/그리기용 경로 점 수 상한
  const TRANSIT_URL = '/api/transit';
  const TRANSIT_TIMEOUT_MS = 15000;
  const NO_ROUTE_REASON = '대중교통 경로 없음(도시 간 이동·너무 가까운 거리 등)';

  // 이동수단 -> 프로필. 대중교통은 카카오(서버) 조회, 택시/자가용은 OSRM 자동차 경로. 대중교통 조회에 실패하면 자동차 경로로 추정한다.
  const profileFor = (mode) => (mode === 'walk' ? 'foot' : mode === 'bike' ? 'bike' : mode === 'transit' ? 'transit' : 'car');

  function haversine(a, b) {
    const R = 6371000;
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLon = (b.lon - a.lon) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  const key = (a, b, profile) => `${profile}|${a.lat.toFixed(5)},${a.lon.toFixed(5)}|${b.lat.toFixed(5)},${b.lon.toFixed(5)}`;

  function decimate(coords) {
    if (coords.length <= MAX_POINTS) return coords;
    const out = [];
    const step = (coords.length - 1) / (MAX_POINTS - 1);
    for (let i = 0; i < MAX_POINTS; i++) out.push(coords[Math.round(i * step)]);
    return out;
  }

  // ---- 대중교통 응답 검증/정리 ----
  const isPt = (p) => Array.isArray(p) && p.length === 2 && isFinite(p[0]) && isFinite(p[1]);
  const nonNeg = (v) => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0);

  /** 서버 응답/저장값의 경로 목록을 검증·정리 (잘못된 항목은 버림, 최대 5개) */
  function cleanRoutes(list) {
    const out = [];
    for (const r of Array.isArray(list) ? list : []) {
      if (!r || typeof r !== 'object' || !Array.isArray(r.steps)) continue;
      out.push({
        type: String(r.type || 'UNKNOWN').slice(0, 30),
        totalDistance: nonNeg(r.totalDistance),
        totalTime: nonNeg(r.totalTime),
        transfers: Math.round(nonNeg(r.transfers)),
        fare: typeof r.fare === 'number' && isFinite(r.fare) && r.fare >= 0 ? Math.round(r.fare) : null,
        steps: r.steps.filter((s) => s && typeof s === 'object').map((s) => ({
          type: String(s.type || 'UNKNOWN').slice(0, 30),
          guidance: String(s.guidance || '').slice(0, 200),
          distance: nonNeg(s.distance),
          time: nonNeg(s.time),
          vehicles: (Array.isArray(s.vehicles) ? s.vehicles : []).filter((v) => typeof v === 'string').slice(0, 20),
          stopCount: Math.round(nonNeg(s.stopCount)),
          firstStop: String(s.firstStop || '').slice(0, 60),
          lastStop: String(s.lastStop || '').slice(0, 60),
          path: (Array.isArray(s.path) ? s.path : []).filter(isPt),
        })),
      });
      if (out.length >= 5) break;
    }
    return out;
  }

  const safeLanding = (u) => (typeof u === 'string' && u.startsWith('https://map.kakao.com/') ? u : null);

  /** 가장 빠른 경로의 인덱스 */
  function fastestIdx(routes) {
    let best = 0;
    for (let i = 1; i < routes.length; i++) if (routes[i].totalTime < routes[best].totalTime) best = i;
    return best;
  }

  /** 카카오 대중교통 결과 -> 캐시 항목 (경로가 없으면 null).
   *  transit: { landingURL, routes, defaultIdx } / distance·duration·geometry는 가장 빠른 경로 값 */
  function transitEntry(landingURL, routes) {
    routes = cleanRoutes(routes);
    if (!routes.length) return null;
    const defaultIdx = fastestIdx(routes);
    const r = routes[defaultIdx];
    const pts = [];
    for (const s of r.steps) for (const p of s.path) pts.push(p);
    return {
      distance: r.totalDistance,
      duration: r.totalTime,
      geometry: decimate(pts),
      estimated: false,
      transit: { landingURL: safeLanding(landingURL), routes, defaultIdx },
    };
  }

  // ---- 캐시 (메모리 + localStorage) ----
  const memory = new Map(); // key -> { distance, duration, geometry, estimated:false, transit? }
  const failed = new Map(); // key -> { t: 실패 시각, reason, permanent } (permanent: 경로 없음 - 세션 동안 재조회 안 함)
  const pending = new Map(); // key -> Promise
  let persistTimer = null;

  try {
    const readCache = (k) => JSON.parse(localStorage.getItem(k) || '{}');
    let old = {};
    try {
      old = readCache(OLD_CACHE_KEY); // v1에는 도보/자전거/자동차 경로만 있다 (대중교통 추정은 저장하지 않았다)
    } catch (e) {
      /* ignore */
    }
    const saved = Object.assign({}, old, readCache(CACHE_KEY));
    for (const [k, v] of Object.entries(saved)) {
      if (!v || typeof v !== 'object') continue;
      if (k.startsWith('transit|')) {
        const e = v.x && transitEntry(v.x.u, v.x.r);
        if (e) memory.set(k, e);
      } else if (isFinite(v.d) && isFinite(v.t) && Array.isArray(v.g)) {
        memory.set(k, { distance: v.d, duration: v.t, geometry: v.g, estimated: false });
      }
    }
    localStorage.removeItem(OLD_CACHE_KEY);
  } catch (e) {
    /* 캐시 없이 진행 */
  }

  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      // 오래된 항목부터 제거 (Map은 삽입 순서 유지)
      while (memory.size > CACHE_MAX) memory.delete(memory.keys().next().value);
      const parts = [];
      let total = 2;
      for (const [k, v] of memory) {
        const val = JSON.stringify(v.transit ? { x: { u: v.transit.landingURL, r: v.transit.routes } } : { d: v.distance, t: v.duration, g: v.geometry });
        parts.push([k, val]);
        total += k.length + val.length + 4;
      }
      // 저장 용량 상한을 넘으면 오래된 항목부터 버린다 (메모리 캐시에는 남는다)
      let from = 0;
      while (total > CACHE_BUDGET && from < parts.length) {
        total -= parts[from][0].length + parts[from][1].length + 4;
        from++;
      }
      try {
        const body = parts.slice(from).map(([k, val]) => JSON.stringify(k) + ':' + val).join(',');
        localStorage.setItem(CACHE_KEY, '{' + body + '}');
      } catch (e) {
        // 용량 초과: 캐시를 비우고 다음 기회에 다시 채움
        try { localStorage.removeItem(CACHE_KEY); } catch (e2) { /* ignore */ }
      }
    }, 500);
  }

  /** 직선거리 x 우회계수로 추정한 구간 정보 */
  function estimateRoute(a, b, profile, settings) {
    const est = (settings || TP.store.state.settings).est;
    const distance = haversine(a, b) * est.detour;
    const speed = profile === 'foot' ? est.walk : profile === 'bike' ? est.bike : est.car; // km/h
    return { distance, duration: (distance / 1000 / speed) * 3600, geometry: [[a.lat, a.lon], [b.lat, b.lon]], estimated: true };
  }

  const isFresh = (f) => !!f && (f.permanent || Date.now() - f.t < FAIL_TTL_MS);

  /** 대중교통 조회 실패 시 대체 경로: 자동차 도로 경로(없으면 직선거리)로 추정. reason은 화면에 표시된다. */
  function transitFallback(a, b, reason) {
    const base = memory.get(key(a, b, 'car')) || estimateRoute(a, b, 'car');
    return { distance: base.distance, duration: base.duration, geometry: base.geometry, estimated: base.estimated, fallbackReason: reason };
  }

  /** 캐시된 결과 (성공 캐시 -> 최근 실패 시 추정값 -> null) */
  function peek(a, b, profile) {
    const k = key(a, b, profile);
    if (memory.has(k)) return memory.get(k);
    const f = failed.get(k);
    if (profile === 'transit') {
      if (!isFresh(f)) return null;
      // 대체용 자동차 경로가 아직 오는 중이면 조금 더 기다린다 (loading)
      const ck = key(a, b, 'car');
      if (!memory.has(ck) && !isFresh(failed.get(ck))) return null;
      return transitFallback(a, b, f.reason);
    }
    if (isFresh(f)) return estimateRoute(a, b, profile);
    return null;
  }

  // ---- 요청 큐 (동시 2개, 우선순위 낮은 숫자 먼저) ----
  const queue = [];
  let active = 0;
  function pump() {
    while (active < MAX_CONCURRENT && queue.length) {
      queue.sort((x, y) => x.priority - y.priority);
      const job = queue.shift();
      active++;
      job.run().then(job.resolve, job.reject).finally(() => {
        active--;
        pump();
      });
    }
  }
  const enqueue = (run, priority) => new Promise((resolve, reject) => { queue.push({ run, resolve, reject, priority }); pump(); });

  async function fetchRoute(a, b, profile) {
    const url = `${ENDPOINTS[profile]}${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      if (j.code !== 'Ok' || !j.routes || !j.routes[0]) throw new Error(j.code || 'no route');
      const r = j.routes[0];
      const coords = ((r.geometry && r.geometry.coordinates) || []).map((c) => [c[1], c[0]]); // [lon,lat] -> [lat,lon]
      return { distance: r.distance, duration: r.duration, geometry: decimate(coords.length ? coords : [[a.lat, a.lon], [b.lat, b.lon]]), estimated: false };
    } finally {
      clearTimeout(timer);
    }
  }

  class TransitFail extends Error {
    constructor(reason, permanent) {
      super(reason);
      this.reason = reason;
      this.permanent = !!permanent;
    }
  }

  /** 서버(/api/transit)에서 카카오 대중교통 경로 조회. 실패하면 TransitFail */
  async function fetchTransit(a, b) {
    const qs = `sx=${a.lon.toFixed(5)}&sy=${a.lat.toFixed(5)}&ex=${b.lon.toFixed(5)}&ey=${b.lat.toFixed(5)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TRANSIT_TIMEOUT_MS);
    try {
      let res;
      try {
        res = await fetch(`${TRANSIT_URL}?${qs}`, { signal: ctrl.signal });
      } catch (e) {
        throw new TransitFail('대중교통 정보를 불러오지 못했어요 (서버 연결 실패)');
      }
      let j = null;
      try {
        j = await res.json();
      } catch (e) {
        /* 본문 없음 */
      }
      if (!res.ok) throw new TransitFail((j && typeof j.error === 'string' && j.error) || `대중교통 정보를 불러오지 못했어요 (HTTP ${res.status})`);
      if (j && j.status === 'NO_RESULTS') throw new TransitFail(NO_ROUTE_REASON, true);
      const entry = j && j.status === 'OK' ? transitEntry(j.landingURL, j.routes) : null;
      if (!entry) throw new TransitFail('대중교통 응답을 해석하지 못했어요');
      return entry;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 대중교통 조회: 실패(경로 없음/키 없음/오류)하면 자동차 경로 기반 추정으로 대체. 항상 resolve */
  function getTransit(a, b, priority) {
    const k = key(a, b, 'transit');
    if (memory.has(k)) return Promise.resolve(memory.get(k));
    if (pending.has(k)) return pending.get(k);
    const f = failed.get(k);
    const p = (async () => {
      let reason;
      if (isFresh(f)) {
        reason = f.reason; // 최근 실패한 구간은 다시 묻지 않고 바로 추정
      } else {
        try {
          const r = await enqueue(() => fetchTransit(a, b), priority || 0);
          memory.set(k, r);
          failed.delete(k);
          persist();
          return r;
        } catch (e) {
          reason = e instanceof TransitFail ? e.reason : '대중교통 정보를 불러오지 못했어요';
          failed.set(k, { t: Date.now(), reason, permanent: e instanceof TransitFail && e.permanent });
        }
      }
      await get(a, b, 'car', priority); // 대체 추정에 쓸 도로 경로 (큐 밖에서 호출해 교착을 피한다)
      return transitFallback(a, b, reason);
    })().finally(() => pending.delete(k));
    pending.set(k, p);
    return p;
  }

  /** 경로 조회. 항상 resolve (실패 시 추정값, estimated:true) */
  function get(a, b, profile, priority) {
    if (profile === 'transit') return getTransit(a, b, priority);
    const k = key(a, b, profile);
    if (memory.has(k)) return Promise.resolve(memory.get(k));
    if (pending.has(k)) return pending.get(k);
    const p = enqueue(async () => {
      try {
        const r = await fetchRoute(a, b, profile);
        memory.set(k, r);
        failed.delete(k);
        persist();
        return r;
      } catch (e) {
        failed.set(k, { t: Date.now() });
        return estimateRoute(a, b, profile);
      }
    }, priority || 0).finally(() => pending.delete(k));
    pending.set(k, p);
    return p;
  }

  const isPending = (a, b, profile) => pending.has(key(a, b, profile));
  const clearFailures = () => failed.clear();

  TP.routing = { profileFor, haversine, key, peek, get, isPending, estimateRoute, clearFailures, NO_ROUTE_REASON };
})();
