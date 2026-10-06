/* planner.js - 일정 계산(구간, 도착/출발 시각 연쇄, 합계) + 표시용 포맷터. DOM을 다루지 않는 순수 로직. */
(function () {
  'use strict';
  const TP = (window.TP = window.TP || {});

  const DAY_COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#d6336c', '#0c8599', '#f08c00', '#5f3dc4'];
  const MODE_IDS = ['walk', 'bike', 'transit', 'taxi', 'car'];

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
  /** 이동수단 결정: 사용자가 고른 값 > 자동(<= autoWalkKm 도보, 그 외 대중교통) */
  function resolveMode(item, prev, settings) {
    if (item.modeIn && MODE_IDS.includes(item.modeIn)) return item.modeIn;
    return TP.routing.haversine(prev, item) <= settings.est.autoWalkKm * 1000 ? 'walk' : 'transit';
  }

  /** prev -> item 구간. depMin: prev 출발 시각(분). 캐시된 경로가 없으면 loading=true 로 임시 추정값을 쓴다. */
  function computeLeg(prev, item, settings, depMin) {
    const mode = resolveMode(item, prev, settings);
    const profile = TP.routing.profileFor(mode);
    let route = TP.routing.peek(prev, item, profile);
    const loading = !route;
    if (!route) route = TP.routing.estimateRoute(prev, item, profile, settings);

    let seconds = route.duration;
    let distance = route.distance;
    let real = null; // 카카오 대중교통 실경로
    let fare = null;
    let fareMin = null;
    let fareMax = null;
    let interCity = false; // 대중교통 실경로 없이 도시 간 거리 -> 시간은 자동차 기준, 요금 미정
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
      } else {
        // 실경로를 못 받으면(경로 없음/키 없음/오류) 자동차 도로거리로 추정
        interCity = !loading && route.distance / 1000 > settings.est.interCityKm;
        // 도시 간 거리는 시내 평균 속도 공식이 맞지 않아 자동차 소요시간을 쓰고, 요금은 미정으로 둔다
        seconds = interCity ? route.duration : (route.distance / 1000 / settings.est.transitSpeed) * 3600 + settings.est.transitOverheadMin * 60;
      }
    }
    // 사용자 직접 입력(구간의 도착 장소에 저장): 시간·요금 각각 있으면 자동 계산 대신 사용
    const ovMin = Number.isInteger(item.legMin) && item.legMin >= 0;
    const ovCost = Number.isInteger(item.legCost) && item.legCost >= 0;
    const durationMin = ovMin ? item.legMin : Math.ceil(seconds / 60 - 1e-9);
    // 실경로인데 카카오가 요금을 아예 안 준 경우(예: 심야 공항버스+지하철)도 거리 기반 시내 요금으로 추정하지 않고 미정으로 둔다
    const noFare = Boolean(real && !real.fareKnown && !real.fareRange);
    const cost = TP.fare.legCost({ mode, distanceM: distance, depMin, parking: item.parking, fare, fareMin, fareMax, override: ovCost ? item.legCost : null, unknown: (interCity || noFare) && !ovCost }, settings);
    return {
      from: prev,
      to: item,
      mode,
      profile,
      auto: !item.modeIn,
      distance,
      durationMin,
      depMin,
      cost, // cost.unknown: 요금 미정 (도시 간 이동 또는 카카오 요금 없음, 합계 제외)
      interCity, // 대중교통 조회 실패 + 도로거리 > est.interCityKm
      noFare, // 대중교통 실경로이지만 카카오가 요금을 주지 않음
      override: { min: ovMin, cost: ovCost }, // 사용자 직접 입력 여부
      geometry: route.geometry,
      estimated: route.estimated, // 경로 조회 실패 -> 직선거리 기반 추정
      transit: mode === 'transit' && !real, // 대중교통 추정값 (실경로를 못 받은 경우)
      transitReal: real, // 대중교통 실경로: { routes, idx, defaultIdx, route, landingURL, fareKnown, fareRange }
      fallbackReason: route.fallbackReason || '', // 대중교통 추정으로 대체된 이유
      loading,
    };
  }

  // ---- 대중교통 실경로 표시용 ----
  const STEP_ICON = { SUBWAY: '🚇', BUS: '🚌', WALKING: '🚶' };
  const stepIcon = (type) => STEP_ICON[type] || '🚏';
  /** 탑승 구간 이름: 노선 번호(여러 개면 '첫 노선 외 N대'), 없으면 안내 문구 */
  function stepName(step) {
    const v = step.vehicles || [];
    if (!v.length) return step.guidance.split(' (')[0] || '이동';
    return v.length > 1 && step.type === 'BUS' ? `${v[0]}외 ${v.length - 1}대` : v.slice(0, 2).join('·');
  }
  /** '🚇 5호선 → 🚌 7212' (도보 구간은 생략, 탑승 구간이 없으면 도보) */
  function routeSummary(route) {
    const rides = route.steps.filter((s) => s.type !== 'WALKING');
    return rides.length ? rides.map((s) => `${stepIcon(s.type)} ${stepName(s)}`).join(' → ') : '🚶 도보';
  }
  const ROUTE_TYPE_LABEL = { BUS: '버스', SUBWAY: '지하철', BUS_AND_SUBWAY: '버스+지하철' };
  const routeTypeLabel = (route) => ROUTE_TYPE_LABEL[route.type] || '대중교통';

  /** 하루 일정: 각 장소의 도착/출발 시각과 구간, 합계 */
  function buildDay(day, dayIndex, settings) {
    const rows = [];
    let clock = parseTime(day.startTime);
    let prev = null;
    const stats = {
      travelMin: 0, distance: 0, transport: 0, extra: 0, total: 0,
      byMode: { walk: 0, bike: 0, transit: 0, taxi: 0, car: 0 },
      legCount: 0, failedLegs: 0, unknownCostLegs: 0, loadingLegs: 0, waitMin: 0, lateCount: 0, end: clock, late: false,
    };
    const people = Math.max(1, Math.round(settings.people || 1));

    for (const item of day.items) {
      let leg = null;
      if (prev) {
        leg = computeLeg(prev, item, settings, clock);
        clock += leg.durationMin;
        stats.travelMin += leg.durationMin;
        stats.distance += leg.distance;
        stats.transport += leg.cost.total;
        stats.byMode[leg.mode] += leg.cost.total;
        stats.legCount++;
        if (leg.cost.unknown) stats.unknownCostLegs++;
        if (leg.loading) stats.loadingLegs++;
        else if (leg.estimated) stats.failedLegs++;
      }
      // est: 고정 시각을 무시한 도착 예정. 시작·종료·체류 중 두 개가 정해지면 나머지는 계산한다:
      // 목표 시작 = 고정 시작, 없으면 고정 종료 - 체류. 목표 시작까지 기다리고(여유), 이미 지났으면 늦음
      const est = clock;
      let target = null;
      if (item.fixedStart) target = parseTime(item.fixedStart);
      else if (item.fixedEnd) target = Math.max(0, parseTime(item.fixedEnd) - item.stay);
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
      let endLateMin = 0;
      if (item.fixedEnd) {
        const fe = parseTime(item.fixedEnd);
        clock = Math.max(fe, start);
        endLateMin = Math.max(0, start - fe);
      } else {
        clock = start + item.stay;
      }
      stats.waitMin += waitMin;
      if (lateMin > 0 || endLateMin > 0) stats.lateCount++;
      stats.extra += item.cost * people;
      rows.push({ item, est, arrival: start, departure: clock, leg, waitMin, lateMin, endLateMin, late: clock >= 1440 || start >= 1440 });
      prev = item;
    }
    stats.end = clock;
    stats.late = clock >= 1440;
    stats.total = stats.transport + stats.extra;
    return { day, dayIndex, rows, stats };
  }

  /** 여행 전체 */
  function buildTrip(trip, settings) {
    const days = trip.days.map((d, i) => buildDay(d, i, settings));
    const people = Math.max(1, Math.round(settings.people || 1));
    const totals = {
      travelMin: 0, distance: 0, transport: 0, extra: 0, total: 0, people,
      byMode: { walk: 0, bike: 0, transit: 0, taxi: 0, car: 0 },
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
      totals.items += d.rows.length;
      for (const m of MODE_IDS) totals.byMode[m] += s.byMode[m];
    }
    totals.perPerson = totals.total / people;
    return { days, totals, people };
  }

  TP.fmt = { fmtTime, fmtDuration, fmtDist, fmtWon, fmtDate, parseTime, dayDate };
  TP.planner = { DAY_COLORS, MODE_IDS, resolveMode, computeLeg, buildDay, buildTrip, stepIcon, stepName, routeSummary, routeTypeLabel };
})();
