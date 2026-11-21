/* planner.js - 일정 계산(구간, 도착/출발 시각 연쇄, 합계) + 표시용 포맷터. DOM을 다루지 않는 순수 로직. */
(function () {
  'use strict';
  const TP = (window.TP = window.TP || {});

  // 한 일차만 지도에 보일 때 구간(A→B, B→C…)마다 돌려 쓰는 색: 이웃한 구간끼리 확실히 구분되는 색상
  const LEG_COLORS = ['#e03131', '#1971c2', '#2f9e44', '#f08c00', '#9c36b5', '#0c8599', '#8d5524', '#e64980'];
  const DAY_COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#d6336c', '#0c8599', '#f08c00', '#5f3dc4'];
  const MODE_IDS = ['walk', 'bike', 'transit', 'taxi', 'car', 'train', 'bus'];
  const isHubMode = (m) => m === 'train' || m === 'bus'; // 열차·고속/시외버스: 편(legService)을 직접 입력하거나 조회해 시간을 정한다

  // ---- 포맷터 ----
  const pad = (n) => String(n).padStart(2, '0');
  function parseTime(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
    return m ? Number(m[1]) * 60 + Number(m[2]) : 540;
  }
  /** 자정 기준 분 -> 'HH:MM' (24시간 이후는 '익일 HH:MM') */
  function fmtTime(min) {
    const m = Math.round(min);
    const dayOffset = Math.floor(m / 1440);
    const r = ((m % 1440) + 1440) % 1440;
    const t = `${pad(Math.floor(r / 60))}:${pad(r % 60)}`;
    return dayOffset >= 1 ? `익일 ${t}` : t;
  }
  function fmtDuration(min) {
    const m = Math.round(min);
    if (m < 60) return `${m}분`;
    const h = Math.floor(m / 60);
    return m % 60 ? `${h}시간 ${m % 60}분` : `${h}시간`;
  }
  const fmtDist = (m) => (m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)}km`);
  const fmtWon = (n) => `${Math.round(n).toLocaleString('ko-KR')}원`;
  const TIGHT_TRANSFER_MIN = 10; // 역 도착 후 이 시간(분) 안에 출발하는 편은 빠듯하다고 알린다
  const tight = (anchor, wait, miss) => Boolean(anchor) && miss === 0 && wait <= TIGHT_TRANSFER_MIN;
  const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
  function dayDate(trip, i) {
    if (!trip.startDate) return null;
    const d = new Date(trip.startDate + 'T00:00:00');
    if (isNaN(d)) return null;
    d.setDate(d.getDate() + i);
    return d;
  }
  const fmtDate = (d) => (d ? `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEK[d.getDay()]})` : '');

  // ---- 구간 계산 ----
  /** 이동수단 결정: 사용자가 고른 값 > 자동(<= autoWalkKm 도보, 그 외 자가용 — 2026-11-21 사용자 결정으로 대중교통에서 바꿈) */
  function resolveMode(item, prev, settings) {
    if (item.modeIn && MODE_IDS.includes(item.modeIn)) return item.modeIn;
    return TP.routing.haversine(prev, item) <= settings.est.autoWalkKm * 1000 ? 'walk' : 'car';
  }

  /** 편 정보가 올바르면(dep·arr 0..1439 정수) 그대로, 아니면 null */
  // 버스 등급: TAGO 고속·시외 등급 목록(2026-10 실조회). 종류를 고르기 전에는 없음
  const BUS_GRADES = {
    express: ['일반', '고속', '우등', '프리미엄', '일반심야', '심야고속', '심야우등', '심야프리미엄'],
    intercity: ['일반', '우등', '프리미엄', '심야일반', '심야우등', '심야프리', '주말프리', '주말심프'],
  };
  const busGrades = (kind) => BUS_GRADES[kind] || [];
  const validService = (s) => (s && typeof s === 'object' && Number.isInteger(s.dep) && Number.isInteger(s.arr) && s.dep >= 0 && s.dep < 1440 && s.arr >= 0 && s.arr < 1440 ? s : null);
  /** 편 소요 시간(분): 도착이 출발보다 이르면 다음 날 도착 */
  const serviceMin = (s) => (s.arr >= s.dep ? s.arr - s.dep : s.arr + 1440 - s.dep);

  /** prev -> item 구간. depMin: prev 출발 시각(분). 캐시된 경로가 없으면 loading=true 로 임시 추정값을 쓴다.
   *  extra: { service, fare, serviceDefault, svcNotListed, lookup, trips, loading } - 열차 편/1인 요금을 item.legService 대신 조회 결과에서 받을 때(trainExtra) */
  function computeLeg(prev, item, settings, depMin, extra) {
    const mode = resolveMode(item, prev, settings);
    const hub = isHubMode(mode);
    const svc = hub ? validService((extra && extra.service) || item.legService) : null;
    const profile = TP.routing.profileFor(mode);
    // 열차·버스는 경로를 조회하지 않는다: 노선 경로를 알 수 없어 거리는 직선거리 x 우회계수, 시간은 편이 정한다(편이 없으면 0 = 시간 미정)
    const needRoute = !hub;
    let route = needRoute ? TP.routing.peek(prev, item, profile) : { distance: 0, duration: 0, geometry: [], estimated: false };
    const loading = (needRoute && !route) || Boolean(hub && extra && extra.loading);
    if (!route) route = TP.routing.estimateRoute(prev, item, mode === 'transit' ? 'car' : profile, settings);

    let seconds = route.duration;
    let distance = route.distance;
    if (hub) distance = TP.routing.haversine(prev, item) * settings.est.detour;
    let real = null; // 카카오 대중교통 실경로
    let fare = null;
    let fareMin = null;
    let fareMax = null;
    if (mode === 'transit') {
      const tr = route.transit;
      if (tr && tr.routes.length) {
        const n = tr.routes.length;
        const saved = Number.isInteger(item.transitIdx) && item.transitIdx >= 0 && item.transitIdx < n ? item.transitIdx : null;
        const idx = saved != null ? saved : tr.defaultIdx;
        const chosen = tr.routes[idx];
        const range = chosen.fare == null && TP.fare.rangeFare(chosen.fareMin, chosen.fareMax) != null ? { min: chosen.fareMin, max: chosen.fareMax } : null;
        real = { routes: tr.routes, idx, defaultIdx: tr.defaultIdx, route: chosen, landingURL: tr.landingURL, fareKnown: chosen.fare != null, fareRange: range };
        seconds = chosen.totalTime;
        distance = chosen.totalDistance;
        fare = chosen.fare;
        if (real.fareRange) { fareMin = real.fareRange.min; fareMax = real.fareRange.max; }
      }
      // 실경로를 못 받으면(경로 없음/키 없음/오류) 대체 경로(자동차)의 시간을 그대로 쓴다. 요금은 미정
    }
    // 사용자 직접 입력(구간의 도착 장소에 저장): 시간·요금 각각 있으면 자동 계산 대신 사용
    const ovMin = Number.isInteger(item.legMin) && item.legMin >= 0;
    const ovCost = Number.isInteger(item.legCost) && item.legCost >= 0;
    const durationMin = hub ? (svc ? serviceMin(svc) : 0) : ovMin ? item.legMin : Math.ceil(seconds / 60 - 1e-9);
    // 실경로를 못 받은 대중교통 구간은 요금 미정(직접 입력하면 반영). 실경로인데 카카오가 요금을 아예 안 준 경우도 미정
    const noFare = Boolean(real && !real.fareKnown && !real.fareRange);
    const unknownTransit = mode === 'transit' && !real;
    const cost = TP.fare.legCost({ mode, distanceM: distance, depMin, parking: item.parking, fare: hub ? (extra && extra.fare != null ? extra.fare : null) : fare, fareMin, fareMax, tollKm: route.tollKm, override: ovCost ? item.legCost : null, unknown: (unknownTransit || noFare) && !ovCost }, settings);
    return {
      from: prev,
      to: item,
      mode,
      profile,
      auto: !item.modeIn,
      distance,
      durationMin,
      depMin,
      cost, // cost.unknown: 요금 미정 (대중교통 실경로 없음 또는 카카오 요금 없음, 합계 제외)
      noRoute: mode === 'transit' && !real && !loading && route.fallbackReason === TP.routing.NO_ROUTE_REASON, // 카카오가 대중교통 경로 없음(NO_RESULTS)이라고 답함. false이고 transit이면 조회 실패
      noFare, // 대중교통 실경로이지만 카카오가 요금을 주지 않음
      override: { min: ovMin && !hub, cost: ovCost }, // 사용자 직접 입력 여부 (열차·버스는 편이 시간을 정하므로 시간 입력 없음)
      service: svc, // 열차·버스 편 { kind, type, grade, no, dep, arr } (없으면 null)
      noService: hub && !svc, // 열차·버스인데 편이 없음: 시간 0(시간 미정), 요금 미정
      serviceDefault: Boolean(hub && svc && extra && extra.serviceDefault), // 조회한 열차 중 가장 먼저 탈 수 있는 편을 기본으로 씀
      svcNotListed: Boolean(hub && svc && extra && extra.svcNotListed), // 저장된 편이 조회한 시간표에 없음
      apiFare: Boolean(hub && svc && extra && extra.fare != null && !ovCost), // 요금이 TAGO 일반 성인 요금
      lookup: (hub && extra && extra.lookup) || null, // 열차 조회 상태 { state, reason, place?, message? }
      trips: (hub && extra && extra.trips) || null, // 조회된 열차 목록(편 선택용)
      curve: hub, // 지도에 두 장소를 잇는 점선 곡선으로 그림
      geometry: hub ? [[prev.lat, prev.lon], [item.lat, item.lon]] : route.geometry,
      estimated: route.estimated, // 경로 조회 실패 -> 직선거리 기반 추정
      transit: mode === 'transit' && !real, // 대중교통 실경로 없음(경로 없음/조회 실패)
      transitReal: real, // 대중교통 실경로: { routes, idx, defaultIdx, route, landingURL, fareKnown, fareRange }
      fallbackReason: route.fallbackReason || '', // 대중교통 추정으로 대체된 이유
      // 대중교통 실경로 없음인데 두 장소가 가까움(직선 est.noRouteWalkKm 이하): 도보로 바꾸라는 안내용
      nearWalk: mode === 'transit' && !real && !loading && TP.routing.haversine(prev, item) <= settings.est.noRouteWalkKm * 1000,
      loading,
    };
  }

  // ---- 대중교통 실경로 표시용 ----
  const STEP_ICON = { SUBWAY: '🚇', BUS: '🚌', WALKING: '🚶' };
  const stepIcon = (type) => STEP_ICON[type] || '🚏';
  /** 탑승 구간 이름: 버스는 묶인 노선 번호 전부(요금 범위의 원인이라 모두 보여준다), 그 외 2개까지, 없으면 안내 문구 */
  function stepName(step) {
    const v = step.vehicles || [];
    if (!v.length) return step.guidance.split(' (')[0] || '이동';
    return (step.type === 'BUS' ? v : v.slice(0, 2)).join('·');
  }
  /** '🚇 5호선 → 🚌 7212' (도보 구간은 생략, 탑승 구간이 없으면 도보) */
  function routeSummary(route) {
    const rides = route.steps.filter((s) => s.type !== 'WALKING');
    return rides.length ? rides.map((s) => `${stepIcon(s.type)} ${stepName(s)}`).join(' → ') : '🚶 도보';
  }
  const ROUTE_TYPE_LABEL = { BUS: '버스', SUBWAY: '지하철', BUS_AND_SUBWAY: '버스+지하철' };
  const routeTypeLabel = (route) => ROUTE_TYPE_LABEL[route.type] || '대중교통';

  /** 열차 구간(prev -> item)의 편·요금을 시간표 조회 결과로 정한다. arrive: prev 도착 분, stay: 그 역에서 필요한 최소 체류(분), ymd: 그 날 'YYYYMMDD'.
   *  저장된 편은 절대 바꾸지 않고, 없으면 도착+체류 이후 첫 열차를 기본 편으로 쓴다. 날짜·조회 모듈이 없으면 null(직접 입력만) */
  function trainExtra(prev, item, arrive, stay, ymd) {
    if (!ymd || !TP.train) return null;
    const lk = TP.train.peek(prev, item, ymd);
    const stored = validService(item.legService);
    if (lk.state === 'loading') return { loading: true, service: stored, lookup: { state: 'loading' } };
    if (lk.state !== 'ok') return { service: stored, lookup: lk };
    const trips = lk.trips;
    const base = { trips, lookup: { state: 'ok' } };
    if (stored) {
      const m = trips.find((t) => t.dep === stored.dep && (stored.no ? t.no === stored.no : t.type === stored.type));
      return m ? { ...base, service: stored, fare: m.charge } : { ...base, service: stored, svcNotListed: true };
    }
    const t = trips.find((x) => x.dep >= arrive + stay);
    if (!t) return { ...base, lookup: { state: 'none', reason: 'none-left' } };
    return { ...base, service: { kind: 'train', type: t.type, grade: null, no: t.no, dep: t.dep, arr: t.arr }, fare: t.charge, serviceDefault: true };
  }

  /** item에서 next로 가는 구간이 편이 정해진 열차·버스면 출발 시각을 고정하는 닻 { dep, mode }, 아니면 null (shortcut: dep은 같은 날 시각으로만 본다).
   *  svc: 조회로 정한 기본 편(있으면 next.legService 대신 사용) */
  function anchorOf(item, next, settings, svc) {
    if (!next || !isHubMode(next.modeIn)) return null;
    const s = validService(svc || next.legService);
    if (!s || resolveMode(next, item, settings) !== next.modeIn) return null;
    return { dep: s.dep, mode: next.modeIn };
  }

  /** item -> next 구간이 열차·버스면 { anchor, extra }: 닻과 그 구간 계산에 넘길 조회 결과. arrive/stay는 item 도착 분·최소 체류 */
  // ---- 역·터미널: 열차·버스 구간은 역 -> 역 (결정 8) ----
  /** 장소가 'train'(기차역) | 'bus'(버스터미널) | null. shortcut: 버스는 이름 패턴만 본다 (TAGO 터미널 ID 매칭은 TP-018-2) */
  function hubOf(item) {
    if (!item) return null;
    if (item.hub) return item.hub;
    if (TP.train && TP.train.stationOf(item)) return 'train';
    return /터미널|정류장|정류소/.test(item.name || '') && !/공항/.test(item.name) ? 'bus' : null;
  }
  /** from -> to 구간을 mode(train|bus)로 하려면 어느 쪽이 역/터미널이 아닌지 */
  const hubMissing = (from, to, mode) => ({ dep: hubOf(from) !== mode, arr: hubOf(to) !== mode });

  /** items[idx-1] -> items[idx] 구간에 고른 역을 끼워 넣은 새 배열.
   *  picks = { dep?, arr? } ({name,lat,lon,category?}). 이웃과 같은 장소(≈10m)면 새로 넣지 않고 그 장소를 역으로 쓴다 */
  function planHubInsert(items, idx, mode, picks) {
    const from = items[idx - 1];
    const to = items[idx];
    const reset = { transitIdx: null, legMin: null, legCost: null, legService: null }; // 구간이 바뀌면 직접 입력·편은 무의미
    const station = (p, modeIn) => TP.store.newItem({ name: String(p.name || '').slice(0, 100), lat: p.lat, lon: p.lon, category: p.category && p.category !== 'etc' ? p.category : 'sight', stay: 0, hub: mode, modeIn });
    const dupDep = picks.dep && samePlace(picks.dep, from);
    const dupArr = picks.arr && samePlace(picks.arr, to);
    const out = items.slice(0, idx - 1);
    out.push(dupDep ? { ...from, hub: from.hub || mode } : from);
    if (picks.dep && !dupDep) out.push(station(picks.dep, null));
    if (picks.arr && !dupArr) {
      out.push(station(picks.arr, mode));
      out.push({ ...to, modeIn: null, ...reset }); // 도착역 뒤의 도시 구간은 자동 이동수단
    } else {
      out.push({ ...to, modeIn: mode, ...(dupArr ? { hub: to.hub || mode } : {}), ...reset });
    }
    return out.concat(items.slice(idx + 1));
  }

  function hubNext(item, next, settings, arrive, stay, ymd) {
    const extra = next && next.modeIn === 'train' && resolveMode(next, item, settings) === 'train' ? trainExtra(item, next, arrive, stay, ymd) : null;
    return { anchor: anchorOf(item, next, settings, extra && extra.service), extra };
  }

  const samePlace = (a, b) => Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lon - b.lon) < 1e-4; // 약 10m 이내

  /** 하루 일정: 각 장소의 도착/출발 시각과 구간, 합계.
   *  ymd: 이 날의 'YYYYMMDD'(열차 시간표 조회용, 없으면 조회 안 함). carry: 전날 마지막 장소의 체류가 자정을 넘기면 { item, until(이 날 0시 기준 분) } -> 그 장소를 맨 앞 행으로 이어 붙이고 체류가 끝나는 시각에 하루를 시작한다 */
  function buildDay(day, dayIndex, settings, carry, ymd) {
    const rows = [];
    let clock = parseTime(day.startTime);
    let prev = null;
    let anchoredDep = null; // 앞 장소에서 출발하는 열차·버스 편의 출발 시각
    let legExtra = null; // 앞 장소 -> 이번 장소 구간에 쓸 열차 조회 결과(앞 장소를 처리할 때 정해 둔다)
    const stats = {
      travelMin: 0, distance: 0, transport: 0, extra: 0, total: 0,
      byMode: { walk: 0, bike: 0, transit: 0, taxi: 0, car: 0, train: 0, bus: 0 },
      legCount: 0, failedLegs: 0, unknownCostLegs: 0, loadingLegs: 0, waitMin: 0, lateCount: 0, end: clock, late: false,
    };
    const people = Math.max(1, Math.round(settings.people || 1));
    // 다음 날 첫 장소가 이미 같은 장소(사용자가 직접 넣은 숙소 등)면 중복으로 붙이지 않는다
    if (carry && !(day.items[0] && samePlace(day.items[0], carry.item))) {
      clock = carry.until;
      prev = carry.item;
      const hn = hubNext(carry.item, day.items[0], settings, clock, 0, ymd);
      const anchor = hn.anchor;
      legExtra = hn.extra;
      const row = { item: carry.item, carry: true, est: 0, arrival: 0, departure: clock, leg: null, waitMin: 0, lateMin: 0, endLateMin: 0, anchor, svcWaitMin: 0, svcMissMin: 0, svcTight: false };
      if (anchor) {
        row.svcWaitMin = Math.max(0, anchor.dep - clock);
        row.svcMissMin = Math.max(0, clock - anchor.dep);
        row.svcTight = tight(anchor, row.svcWaitMin, row.svcMissMin);
        row.departure = Math.max(clock, anchor.dep);
        clock = row.departure;
        anchoredDep = anchor.dep;
      }
      row.late = clock >= 1440;
      rows.push(row);
    }

    for (let ii = 0; ii < day.items.length; ii++) {
      const item = day.items[ii];
      let leg = null;
      if (prev) {
        // 앞 장소가 열차·버스 출발 시각에 묶여 있으면 구간은 그 시각(dep)에 출발한다
        const depAt = anchoredDep != null ? anchoredDep : clock;
        leg = computeLeg(prev, item, settings, depAt, legExtra);
        clock = depAt + leg.durationMin;
        stats.travelMin += leg.durationMin;
        stats.distance += leg.distance;
        stats.transport += leg.cost.total;
        stats.byMode[leg.mode] += leg.cost.total;
        stats.legCount++;
        if (leg.cost.unknown && !leg.loading) stats.unknownCostLegs++;
        if (leg.loading) stats.loadingLegs++;
        else if (leg.estimated) stats.failedLegs++;
      }
      // est: 고정 시각을 무시한 도착 예정. 시작·종료·체류 중 두 개가 정해지면 나머지는 계산한다:
      // 목표 시작 = 고정 시작, 없으면 고정 종료 - 체류. 목표 시작까지 기다리고(여유), 이미 지났으면 늦음
      const est = clock;
      const timing = (useFixedEnd) => {
        let target = null;
        if (item.fixedStart) target = parseTime(item.fixedStart);
        else if (item.fixedEnd && useFixedEnd) target = Math.max(0, parseTime(item.fixedEnd) - item.stay);
        let start = est;
        let waitMin = 0;
        let lateMin = 0;
        if (target != null) {
          if (!prev) start = target; // 첫 장소는 목표 시작이 곧 하루의 시작
          else {
            start = Math.max(est, target);
            if (target > est) waitMin = target - est;
            else lateMin = est - target;
          }
        }
        return { start, waitMin, lateMin };
      };
      // 다음 구간이 편이 정해진 열차·버스면 종료 시각은 그 출발 시각에 고정(fixedEnd는 무시). 기본 편은 도착 시각이 필요하므로 fixedEnd를 뺀 도착으로 먼저 고른다
      const hn = hubNext(item, day.items[ii + 1], settings, timing(false).start, item.stay, ymd);
      const anchor = hn.anchor;
      const { start, waitMin, lateMin } = timing(!anchor);
      let endLateMin = 0;
      let svcWaitMin = 0; // 열차·버스를 기다리는 시간(대기)
      let svcMissMin = 0; // 편 출발 후에 도착한 시간(놓침)
      anchoredDep = anchor ? anchor.dep : null;
      legExtra = hn.extra;
      if (anchor) {
        // 종료 시각 = 편 출발 시각(고정). 그보다 늦게 도착하면 놓친 것이고, 이후 시각은 그 편 기준으로 계속 계산한다
        if (start > anchor.dep) {
          svcMissMin = start - anchor.dep;
          clock = start;
        } else {
          svcWaitMin = anchor.dep - start; // 역·터미널에서 편을 기다리는 시간 전체가 대기다(기본 편은 체류 시간 이후 출발로 골랐다)
          clock = anchor.dep;
        }
      } else if (item.fixedEnd) {
        const fe = parseTime(item.fixedEnd);
        clock = Math.max(fe, start);
        endLateMin = Math.max(0, start - fe);
      } else {
        clock = start + item.stay;
      }
      stats.waitMin += waitMin;
      if (lateMin > 0 || endLateMin > 0 || svcMissMin > 0) stats.lateCount++;
      stats.extra += item.cost * people;
      rows.push({ item, est, arrival: start, departure: clock, leg, waitMin, lateMin, endLateMin, anchor, svcWaitMin, svcMissMin, svcTight: tight(anchor, svcWaitMin, svcMissMin), late: clock >= 1440 || start >= 1440 });
      prev = item;
    }
    stats.end = clock;
    stats.late = clock >= 1440;
    stats.total = stats.transport + stats.extra;
    return { day, dayIndex, rows, stats };
  }

  const ymdOf = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

  /** 여행 전체 */
  function buildTrip(trip, settings) {
    const days = [];
    let carry = null;
    trip.days.forEach((d, i) => {
      const dd = dayDate(trip, i);
      const dm = buildDay(d, i, settings, carry, dd ? ymdOf(dd) : null);
      const last = dm.rows[dm.rows.length - 1];
      carry = last && last.departure > 1440 ? { item: last.item, until: last.departure - 1440 } : null;
      days.push(dm);
    });
    const people = Math.max(1, Math.round(settings.people || 1));
    const totals = {
      travelMin: 0, distance: 0, transport: 0, extra: 0, total: 0, people,
      byMode: { walk: 0, bike: 0, transit: 0, taxi: 0, car: 0, train: 0, bus: 0 },
      failedLegs: 0, loadingLegs: 0, unknownCostLegs: 0, items: 0,
    };
    for (const d of days) {
      const s = d.stats;
      totals.travelMin += s.travelMin;
      totals.distance += s.distance;
      totals.transport += s.transport;
      totals.extra += s.extra;
      totals.total += s.total;
      totals.failedLegs += s.failedLegs;
      totals.unknownCostLegs += s.unknownCostLegs;
      totals.loadingLegs += s.loadingLegs;
      totals.items += d.rows.filter((r) => !r.carry).length;
      for (const m of MODE_IDS) totals.byMode[m] += s.byMode[m];
    }
    totals.perPerson = totals.total / people;
    return { days, totals, people };
  }

  TP.fmt = { fmtTime, fmtDuration, fmtDist, fmtWon, fmtDate, parseTime, dayDate };
  /** 구간 색: 일차 전체 표시 중이면 일차 색, 한 일차만 보일 땐 구간 순서(0부터)대로 팔레트를 돌려 쓴다 */
  function legColor(dayColor, legIndex, showAll) {
    return showAll ? dayColor : LEG_COLORS[legIndex % LEG_COLORS.length];
  }

  TP.planner = { TIGHT_TRANSFER_MIN, busGrades, hubOf, hubMissing, planHubInsert, trainExtra, isHubMode, validService, serviceMin, anchorOf, DAY_COLORS, LEG_COLORS, legColor, MODE_IDS, resolveMode, computeLeg, buildDay, buildTrip, stepIcon, stepName, routeSummary, routeTypeLabel };
})();
