/* geocode.js - 장소 검색 / 역지오코딩.
 * 카카오 SDK(services, js/kakao.js 공유 로더)를 우선 사용하고(키가 있고 로드에 성공했을 때),
 * 결과가 없거나 사용할 수 없으면 Nominatim(OSM)으로 대체한다. Nominatim은 정책상 초당 1회 이하로 호출한다.
 */
(function () {
  'use strict';
  const TP = (window.TP = window.TP || {});

  const BASE = 'https://nominatim.openstreetmap.org';
  const MIN_GAP_MS = 1100;
  let nextSlot = 0;
  const searchCache = new Map();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 모든 Nominatim 요청을 직렬화된 시간 슬롯에 배치 (>= 1.1초 간격)
  async function throttle(signal) {
    const t = Math.max(Date.now(), nextSlot);
    nextSlot = t + MIN_GAP_MS;
    const wait = t - Date.now();
    if (wait > 0) await sleep(wait);
    if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
  }

  async function getJSON(url, signal) {
    await throttle(signal);
    const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // Nominatim class/type -> 앱 카테고리 추정
  function guessCategory(cls, type) {
    const t = String(type || '');
    const c = String(cls || '');
    if (/restaurant|fast_food|food_court|bar|pub|biergarten/.test(t)) return 'food';
    if (/cafe|ice_cream|bakery|coffee/.test(t)) return 'cafe';
    if (/hotel|hostel|guest_house|motel|apartment|resort/.test(t) || c === 'tourism' && /hotel|hostel|guest_house|motel/.test(t)) return 'stay';
    if (c === 'shop' || /mall|marketplace|department_store|supermarket/.test(t)) return 'shop';
    if (c === 'tourism' || c === 'historic' || /museum|attraction|park|viewpoint|theatre|zoo|castle|palace/.test(t) || c === 'leisure') return 'sight';
    return 'etc';
  }

  // =====================================================================
  // 카카오 JavaScript SDK (services 라이브러리)
  // =====================================================================
  const loadKakao = () => TP.kakao.load(); // 공유 로더 (js/kakao.js)

  /** 입력 디바운스(ms): 카카오는 호출 제한이 느슨해 짧게, Nominatim은 길게 */
  const debounceMs = () => {
    const st = TP.kakao.status().state;
    return st === 'loading' || st === 'ready' ? 300 : 700;
  };

  // 카카오 카테고리 -> 앱 카테고리
  function kakaoCategory(doc) {
    const code = doc.category_group_code || '';
    const group = doc.category_group_name || '';
    const full = doc.category_name || '';
    if (code === 'FD6' || group === '음식점') return 'food';
    if (code === 'CE7' || group === '카페') return 'cafe';
    if (code === 'AD5' || group === '숙박') return 'stay';
    if (code === 'AT4' || code === 'CT1' || group === '관광명소' || group === '문화시설') return 'sight';
    if (code === 'MT1' || code === 'CS2' || group === '대형마트' || group === '편의점') return 'shop';
    if (/음식점/.test(full)) return 'food';
    if (/카페/.test(full)) return 'cafe';
    if (/숙박/.test(full)) return 'stay';
    if (/관광|문화/.test(full)) return 'sight';
    return 'etc';
  }

  function kakaoPlaceResults(data) {
    return (data || [])
      .map((d) => ({
        name: d.place_name || '',
        displayName: [d.road_address_name || d.address_name, d.category_group_name].filter(Boolean).join(' · '),
        lat: parseFloat(d.y),
        lon: parseFloat(d.x),
        category: kakaoCategory(d),
        source: 'kakao',
      }))
      .filter((r) => r.name && isFinite(r.lat) && isFinite(r.lon));
  }

  function kakaoAddressResults(data) {
    return (data || [])
      .map((d) => {
        const road = d.road_address || null;
        const addr = d.address || null;
        const full = (road && road.address_name) || d.address_name || (addr && addr.address_name) || '';
        return {
          name: (road && road.building_name) || full,
          displayName: full,
          lat: parseFloat(d.y),
          lon: parseFloat(d.x),
          category: 'etc',
          source: 'kakao',
        };
      })
      .filter((r) => r.name && isFinite(r.lat) && isFinite(r.lon));
  }

  // 카카오 콜백 -> Promise. ZERO_RESULT는 빈 값(mapper(null)), ERROR는 reject
  function kakaoCall(fn, mapper) {
    return new Promise((resolve, reject) => {
      const Status = window.kakao.maps.services.Status;
      try {
        fn((data, status) => {
          if (status === Status.OK) resolve(mapper(data));
          else if (status === Status.ZERO_RESULT) resolve(mapper(null));
          else reject(new Error('카카오 검색 오류 (' + status + ')'));
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  async function searchKakao(q) {
    const svc = window.kakao.maps.services;
    let res = await kakaoCall((cb) => new svc.Places().keywordSearch(q, cb, { size: 10 }), kakaoPlaceResults);
    // 순수 주소 입력 (예: "서울 강남구 테헤란로 152")
    if (!res.length) res = await kakaoCall((cb) => new svc.Geocoder().addressSearch(q, cb), kakaoAddressResults);
    return res;
  }

  async function reverseKakao(lat, lon) {
    const svc = window.kakao.maps.services;
    const list = await kakaoCall((cb) => new svc.Geocoder().coord2Address(lon, lat, cb), (d) => d || []);
    const r = list[0];
    if (!r) return null;
    const road = r.road_address || null;
    const addr = r.address || null;
    const full = (road && road.address_name) || (addr && addr.address_name) || '';
    const name = (road && road.building_name) || full;
    if (!name) return null;
    return { name, displayName: full, category: 'etc', source: 'kakao' };
  }

  // =====================================================================
  // Nominatim (OSM)
  // =====================================================================
  async function searchNominatim(q, signal) {
    const url = `${BASE}/search?format=json&q=${encodeURIComponent(q)}&accept-language=ko&limit=5`;
    const arr = await getJSON(url, signal);
    return (Array.isArray(arr) ? arr : [])
      .map((r) => ({
        name: r.name || String(r.display_name || '').split(',')[0].trim() || q,
        displayName: r.display_name || '',
        lat: parseFloat(r.lat),
        lon: parseFloat(r.lon),
        category: guessCategory(r.category || r.class, r.type),
        source: 'osm',
      }))
      .filter((r) => isFinite(r.lat) && isFinite(r.lon));
  }

  async function reverseNominatim(lat, lon, signal) {
    const url = `${BASE}/reverse?format=json&lat=${lat}&lon=${lon}&accept-language=ko&zoom=18`;
    const j = await getJSON(url, signal);
    if (!j || j.error) throw new Error(j && j.error ? j.error : 'no result');
    const display = j.display_name || '';
    const parts = display.split(',').map((s) => s.trim()).filter(Boolean);
    const name = j.name || parts.slice(0, 2).join(' ') || `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    return { name, displayName: display, category: guessCategory(j.category || j.class, j.type), source: 'osm' };
  }

  // =====================================================================
  // 공개 API
  // =====================================================================
  /** 장소 검색 -> [{ name, displayName, lat, lon, category, source: 'kakao'|'osm' }]
   *  카카오(키워드 -> 주소) -> 결과가 없거나 실패하면 Nominatim */
  async function search(query, signal) {
    const q = query.trim();
    const cached = searchCache.get(q);
    if (cached) return cached;
    let results = [];
    if (await loadKakao()) {
      try {
        results = await searchKakao(q);
      } catch (e) {
        console.warn(e);
        results = [];
      }
      if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
    }
    if (!results.length) results = await searchNominatim(q, signal);
    searchCache.set(q, results);
    return results;
  }

  /** 좌표 -> 장소 이름 { name, displayName, category, source } (카카오 -> 실패/결과 없음이면 Nominatim) */
  async function reverse(lat, lon, signal) {
    if (await loadKakao()) {
      try {
        const r = await reverseKakao(lat, lon);
        if (r) return r;
      } catch (e) {
        console.warn(e);
      }
    }
    return reverseNominatim(lat, lon, signal);
  }

  TP.geocode = {
    search,
    reverse,
    debounceMs,
  };
})();
