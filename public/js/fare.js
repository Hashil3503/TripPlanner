/* fare.js - 교통비 계산 (대중교통 / 택시 / 자가용)
 * 모든 요금 상수는 DEFAULT_CONFIG 한 곳에 모아 두었고, 설정 모달에서 수정/저장할 수 있다.
 * 브라우저(window.TP.fare)와 node(module.exports) 양쪽에서 로드 가능.
 */
(function (root) {
  'use strict';
  const TP = (root.TP = root.TP || {});

  // ---- 요금/추정 설정 (2025 서울 기준 기본값) ----
  const DEFAULT_CONFIG = {
    people: 1, // 여행 인원
    transit: {
      baseFare: 1550, // 기본요금(교통카드, 성인)
      baseKm: 10, // 기본요금 적용 거리(km)
      stepKm: 5, // 10km 초과 ~ 상한까지 추가요금 단위(km)
      stepFee: 100, // 단위당 추가요금(원)
      stepMaxKm: 50, // 이 거리까지는 5km당 추가
      farStepKm: 8, // 상한 초과분은 8km당 추가
      farStepFee: 100,
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
      fuelPrice: 1700, // 유가(원/L)
    },
    est: {
      walk: 4.5, // km/h (경로 조회 실패 시 추정용)
      bike: 15,
      car: 30,
      transitSpeed: 22, // 대중교통 평균 속도(km/h)
      transitOverheadMin: 10, // 대기/환승/도보 오버헤드(분)
      detour: 1.3, // 직선거리 -> 도로거리 보정 계수
      autoWalkKm: 1.2, // 자동 이동수단: 이 거리 이하면 도보
    },
  };

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

  /** 대중교통 요금(1인, 원). distKm: 이동 거리(km)
   *  - 10km 이내: 기본요금
   *  - 10km 초과 ~ 50km: 5km마다 +100원 (올림)
   *  - 50km 초과분: 8km마다 +100원 (올림)
   */
  function transitFare(distKm, cfg) {
    const t = (cfg || DEFAULT_CONFIG).transit;
    if (!(distKm > t.baseKm)) return t.baseFare;
    const nearKm = Math.min(distKm, t.stepMaxKm) - t.baseKm;
    let fare = t.baseFare + ceilSafe(nearKm / t.stepKm) * t.stepFee;
    if (distKm > t.stepMaxKm) {
      fare += ceilSafe((distKm - t.stepMaxKm) / t.farStepKm) * t.farStepFee;
    }
    return fare;
  }

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

  /** 자가용 연료비(원, 10원 단위). 통행료는 계산하지 않는다. */
  function fuelCost(distKm, cfg) {
    const c = (cfg || DEFAULT_CONFIG).car;
    if (!(c.efficiency > 0)) return 0;
    return roundTo((distKm / c.efficiency) * c.fuelPrice, 10);
  }

  /** 한 구간의 비용.
   * opts: { mode, distanceM, depMin, parking, fare }  (fare: 대중교통 실제 1인 요금 - 있으면 거리 기반 추정 대신 사용)
   * 반환: { total(전체 인원 합), perPerson, fuel, parking, surchargeRate }
   *  - 대중교통: 요금 x 인원 / 택시·자가용: 차량 1대를 공유(총액 / 인원)
   *  - 도보·자전거: 0원 */
  function legCost(opts, cfg) {
    cfg = cfg || DEFAULT_CONFIG;
    const people = Math.max(1, Math.round(cfg.people || 1));
    const distM = Math.max(0, opts.distanceM || 0);
    const out = { total: 0, perPerson: 0, fuel: 0, parking: 0, surchargeRate: 0 };
    switch (opts.mode) {
      case 'transit': {
        const per = opts.fare != null && isFinite(opts.fare) ? opts.fare : transitFare(distM / 1000, cfg);
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
        out.total = out.fuel + out.parking;
        out.perPerson = out.total / people;
        break;
      }
      default: // walk, bike
        break;
    }
    return out;
  }

  const fare = { DEFAULT_CONFIG, MODES, transitFare, taxiNightRate, taxiFare, fuelCost, legCost };
  TP.fare = fare;
  if (typeof module !== 'undefined' && module.exports) module.exports = fare;
})(typeof window !== 'undefined' ? window : globalThis);
