/* fare.js - 교통비 계산 (대중교통 / 택시 / 자가용)
 * 모든 요금 상수는 DEFAULT_CONFIG 한 곳에 모아 두었고, 설정 모달에서 수정/저장할 수 있다.
 * 브라우저(window.TP.fare)와 node(module.exports) 양쪽에서 로드 가능.
 */
(function (root) {
  'use strict';
  const TP = (root.TP = root.TP || {});

  // ---- 요금/추정 설정 (2026 서울 기준 기본값) ----
  const DEFAULT_CONFIG = {
    people: 1, // 여행 인원
    transit: {
      rangePick: 1, // 카카오가 요금을 범위(최소~최대)로 줄 때 합계 기준: 0 = 최소, 0.5 = 중간값, 1 = 최대 (기본: 경비를 보수적으로 잡도록 최대)
    },
    taxi: {
      baseFare: 4800, // 서울 중형택시 기본요금
      baseMeters: 1600, // 기본요금 거리(m)
      stepMeters: 131, // 이후 131m마다
      stepFee: 100, // 100원 추가
      surcharge20: 0.2, // 22~23시, 02~04시 출발
      surcharge40: 0.4, // 23~02시 출발
    },
    car: {
      efficiency: 12, // 연비(km/L)
      fuelPrice: 1850, // 유가(원/L, 2026-11 휘발유 전국 평균)
      tollBase: 900, // 고속도로 통행료 기본요금(원, 1종 폐쇄식)
      tollPerKm: 44.3, // km당 주행요금(원, 1종)
    },
    est: {
      walk: 4.5, // km/h (경로 조회 실패 시 추정용)
      bike: 15,
      car: 30,
      detour: 1.3, // 직선거리 -> 도로거리 보정 계수
      autoWalkKm: 1.2, // 자동 이동수단: 이 거리 이하면 도보
      noRouteWalkKm: 2, // 대중교통 경로가 없을 때 이 직선거리(km) 이하는 도보, 초과는 자동차 시간으로 계산
    },
  };

  // 사용자가 바꿀 수 있는 설정 경로. 나머지는 코드 고정값(저장된 값 무시)
  const USER_SETTINGS = ['people', 'car.efficiency', 'car.fuelPrice', 'transit.rangePick'];

  const MODES = [
    { id: 'walk', label: '도보', emoji: '🚶' },
    { id: 'bike', label: '자전거', emoji: '🚲' },
    { id: 'transit', label: '대중교통', emoji: '🚌' },
    { id: 'taxi', label: '택시', emoji: '🚕' },
    { id: 'car', label: '자가용', emoji: '🚗' },
  ];

  const roundTo = (n, unit) => Math.round(n / unit) * unit;
  // 부동소수점 오차(예: 10/5 = 2.0000000001)로 ceil이 튀지 않게 보정
  const ceilSafe = (x) => Math.ceil(x - 1e-9);

  /** 택시 심야 할증률. depMin: 출발 시각(자정 기준 분, 1440 이상이면 익일로 환산)
   *  22:00~23:00, 02:00~04:00 -> 20% / 23:00~02:00 -> 40% */
  function taxiNightRate(depMin, cfg) {
    const t = (cfg || DEFAULT_CONFIG).taxi;
    const m = ((Math.floor(depMin) % 1440) + 1440) % 1440;
    const h = Math.floor(m / 60);
    if (h >= 23 || h < 2) return t.surcharge40;
    if (h === 22 || (h >= 2 && h < 4)) return t.surcharge20;
    return 0;
  }

  /** 택시 요금(원, 100원 단위 반올림). 시간(저속 주행) 요금은 반영하지 않는다. */
  function taxiFare(distMeters, depMin, cfg) {
    const t = (cfg || DEFAULT_CONFIG).taxi;
    let fare = t.baseFare;
    if (distMeters > t.baseMeters) {
      fare += ceilSafe((distMeters - t.baseMeters) / t.stepMeters) * t.stepFee;
    }
    const rate = taxiNightRate(depMin == null ? 720 : depMin, cfg);
    return roundTo(fare * (1 + rate), 100);
  }

  /** 자가용 연료비(원, 10원 단위). */
  function fuelCost(distKm, cfg) {
    const c = (cfg || DEFAULT_CONFIG).car;
    if (!(c.efficiency > 0)) return 0;
    return roundTo((distKm / c.efficiency) * c.fuelPrice, 10);
  }

  // shortcut: 도로 이름/번호로 고속도로를 판별해 민자고속도로·개방식 요금·무료 구간은 구분하지 못한다. 정확도가 필요하면 통행료를 주는 길찾기 API로 교체
  function tollRoadKm(steps) {
    if (!Array.isArray(steps)) return 0;
    let meters = 0;
    for (const s of steps) {
      if (!s || typeof s !== 'object') continue;
      if ((typeof s.name === 'string' && s.name.includes('고속도로')) || (!s.name && s.ref)) meters += Math.max(0, s.distance || 0);
    }
    return meters / 1000;
  }

  /** 자가용 고속도로 통행료(원, 100원 단위 추정). km: 고속도로 거리(km) */
  function tollFare(km, cfg) {
    if (!(km > 0)) return 0;
    const c = (cfg || DEFAULT_CONFIG).car;
    return roundTo(c.tollBase + km * c.tollPerKm, 100);
  }

  /** rangePick 값을 0 / 0.5 / 1 중 가장 가까운 값으로 (잘못된 값은 기본값 1 = 최대) */
  function snapRangePick(v) {
    if (typeof v !== 'number' || !isFinite(v)) return 1;
    return v < 0.25 ? 0 : v < 0.75 ? 0.5 : 1;
  }

  /** 요금 범위의 1인 요금(원, 10원 단위). 범위가 올바르지 않으면 null */
  function rangeFare(min, max, cfg) {
    if (!(typeof min === 'number' && typeof max === 'number' && isFinite(min) && isFinite(max) && min >= 0 && max >= min)) return null;
    const pick = snapRangePick(((cfg || DEFAULT_CONFIG).transit || {}).rangePick);
    return roundTo(min + (max - min) * pick, 10);
  }

  /** 한 구간의 비용.
   * opts: { mode, distanceM, depMin, parking, fare, tollKm }  (fare: 대중교통 실제 1인 요금 - 있으면 그대로 사용,
   *  fareMin/fareMax: 요금이 범위로 온 경우 - fare가 없을 때 rangePick 기준으로 사용. 둘 다 없으면 요금 미정(unknown),
   *  tollKm: 경로 중 고속도로 거리(km, 자가용 통행료 추정용),
   *  override: 사용자 직접 입력 요금(원) - 있으면 계산 대신 사용. 대중교통·도보·자전거는 1인 요금, 택시·자가용은 차량 1대 총액,
   *  unknown: true면 요금 미정(0원, 합계에서 제외))
   * 반환: { total(전체 인원 합), perPerson, fuel, parking, toll, surchargeRate, unknown }
   *  - 대중교통: 요금 x 인원 / 택시·자가용: 차량 1대를 공유(총액 / 인원)
   *  - 도보·자전거: 0원 */
  function legCost(opts, cfg) {
    cfg = cfg || DEFAULT_CONFIG;
    const people = Math.max(1, Math.round(cfg.people || 1));
    const distM = Math.max(0, opts.distanceM || 0);
    const out = { total: 0, perPerson: 0, fuel: 0, parking: 0, toll: 0, surchargeRate: 0, unknown: false };
    const hasOverride = opts.override != null && isFinite(opts.override) && opts.override >= 0;
    if (hasOverride) {
      const v = Math.round(opts.override);
      if (opts.mode === 'taxi' || opts.mode === 'car') {
        out.total = v;
        out.perPerson = v / people;
      } else {
        out.perPerson = v;
        out.total = v * people;
      }
      return out;
    }
    if (opts.unknown) {
      out.unknown = true;
      return out;
    }
    switch (opts.mode) {
      case 'transit': {
        let per = opts.fare != null && isFinite(opts.fare) ? opts.fare : null;
        if (per == null) per = rangeFare(opts.fareMin, opts.fareMax, cfg);
        if (per == null) {
          out.unknown = true; // 거리로 요금을 추정하지 않는다
          break;
        }
        out.perPerson = per;
        out.total = per * people;
        break;
      }
      case 'taxi': {
        out.surchargeRate = taxiNightRate(opts.depMin == null ? 720 : opts.depMin, cfg);
        out.total = taxiFare(distM, opts.depMin, cfg);
        out.perPerson = out.total / people;
        break;
      }
      case 'car': {
        out.fuel = fuelCost(distM / 1000, cfg);
        out.parking = Math.max(0, opts.parking || 0);
        out.toll = tollFare(opts.tollKm, cfg);
        out.total = out.fuel + out.parking + out.toll;
        out.perPerson = out.total / people;
        break;
      }
      default: // walk, bike
        break;
    }
    return out;
  }

  const fare = { DEFAULT_CONFIG, USER_SETTINGS, MODES, taxiNightRate, taxiFare, fuelCost, tollRoadKm, tollFare, snapRangePick, rangeFare, legCost };
  TP.fare = fare;
  if (typeof module !== 'undefined' && module.exports) module.exports = fare;
})(typeof window !== 'undefined' ? window : globalThis);
