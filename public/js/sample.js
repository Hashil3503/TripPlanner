/* sample.js - 첫 실행 시 불러오는 샘플 여행 (서울 1박 2일). 좌표는 대략적인 위치. */
(function () {
  'use strict';
  const TP = (window.TP = window.TP || {});

  function create() {
    const S = TP.store;
    const item = (name, lat, lon, category, stay, memo, cost) =>
      S.newItem({ name, lat, lon, category, stay, memo: memo || '', cost: cost || 0 });

    const trip = S.newTrip('서울 1박 2일 (샘플)', nextSaturday(), 2);
    trip.days[0].startTime = '09:00';
    trip.days[0].items = [
      item('경복궁', 37.579617, 126.977041, 'sight', 90, '수문장 교대식 10시', 3000),
      item('광장시장', 37.570164, 126.999434, 'food', 60, '빈대떡, 마약김밥', 12000),
      item('동대문디자인플라자(DDP)', 37.566479, 127.009277, 'sight', 60, '', 0),
      item('명동 쇼핑거리', 37.563692, 126.985437, 'shop', 90, '', 0),
      item('N서울타워', 37.551169, 126.988227, 'sight', 90, '야경 감상', 16000),
      item('서울역 인근 숙소(예시)', 37.554722, 126.970833, 'stay', 0, '체크인', 0),
    ];
    trip.days[1].startTime = '10:00';
    trip.days[1].items = [
      item('연남동 카페거리', 37.562131, 126.925583, 'cafe', 60, '', 6000),
      item('홍대 걷고싶은거리', 37.555778, 126.923444, 'shop', 90, '', 0),
      item('더현대 서울', 37.525999, 126.928549, 'shop', 90, '점심 포함', 15000),
      item('여의도 한강공원', 37.528390, 126.932641, 'sight', 60, '치맥 / 피크닉', 8000),
    ];
    return trip;
  }

  // 데모용: 다가오는 토요일 날짜 (YYYY-MM-DD)
  function nextSaturday() {
    const d = new Date();
    d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  TP.sample = { create };
})();
