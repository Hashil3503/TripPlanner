/* trips.js - 메인 화면(여행 목록)용 순수 로직: 해시 라우트, 카드에 보여줄 요약 문구. DOM을 다루지 않는다. */
(function () {
  'use strict';
  const TP = (window.TP = window.TP || {});

  // ---- 라우트: '#/' (또는 빈 해시) = 메인, '#/trip/<id>' = 여행 편집 ----
  /** location.hash -> { name: 'main' } | { name: 'trip', id }. 알 수 없는 해시는 메인으로 본다. */
  function parseRoute(hash) {
    const m = /^#\/trip\/([^/?#]+)\/?$/.exec(typeof hash === 'string' ? hash : '');
    if (m) {
      try {
        const id = decodeURIComponent(m[1]);
        if (id) return { name: 'trip', id };
      } catch (e) {
        /* 깨진 퍼센트 인코딩: 메인으로 */
      }
    }
    return { name: 'main' };
  }
  const tripHash = (id) => '#/trip/' + encodeURIComponent(id);
  const MAIN_HASH = '#/';
  /** 라우트의 표준 해시 (빈 해시와 '#/'를 같게 본다) */
  const canonicalHash = (hash) => {
    const r = parseRoute(hash);
    return r.name === 'trip' ? tripHash(r.id) : MAIN_HASH;
  };

  // ---- 카드 요약 ----
  /** '10월 10일 (토) – 10월 11일 (일) · 2일', 시작일이 없으면 '날짜 미정 · 2일' */
  function dateRangeText(trip) {
    const F = TP.fmt;
    const n = trip.days.length;
    const first = F.dayDate(trip, 0);
    if (!first) return `날짜 미정 · ${n}일`;
    const a = F.fmtDate(first);
    return n > 1 ? `${a} – ${F.fmtDate(F.dayDate(trip, n - 1))} · ${n}일` : `${a} · ${n}일`;
  }

  const placeCount = (trip) => trip.days.reduce((n, d) => n + d.items.length, 0);

  /** '경복궁 · 광장시장 · DDP 외 3곳' (일차 순서대로 앞의 3곳). 일정이 없으면 안내 문구 */
  function placePreview(trip, max) {
    max = max || 3;
    const names = [];
    for (const d of trip.days) for (const it of d.items) names.push(it.name);
    if (!names.length) return '아직 일정이 없어요';
    const head = names.slice(0, max).join(' · ');
    return names.length > max ? `${head} 외 ${names.length - max}곳` : head;
  }

  /** 예상 비용 문구. 경로를 아직 조회 중이거나 일정이 없거나 0원이면 null(표시하지 않음). totals는 planner.buildTrip의 totals */
  function costText(totals) {
    if (!totals || totals.items === 0 || totals.loadingLegs > 0 || !(totals.total > 0)) return null;
    return `약 ${TP.fmt.fmtWon(totals.total)}`;
  }

  TP.trips = { parseRoute, tripHash, canonicalHash, MAIN_HASH, dateRangeText, placeCount, placePreview, costText };
})();
