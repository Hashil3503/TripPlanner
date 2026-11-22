/* geocode.js - 장소 검색 / 역지오코딩. 카카오 SDK(services, js/kakao.js 공유 로더)만 쓴다.
 * 카카오를 쓸 수 없거나 조회에 실패하면 다른 서비스로 넘어가지 않고 실패로 알린다.
 * (Nominatim 대체는 입력 중 자동 검색이 사용 정책에 어긋나 제거함, TP-030)
 */
(function () {
  'use strict';
  const TP = (window.TP = window.TP || {});

  const searchCache = new Map();

  // =====================================================================
  // 카카오 JavaScript SDK (services 라이브러리)
  // =====================================================================
  const loadKakao = () => TP.kakao.load(); // 공유 로더 (js/kakao.js)

  /** 검색 입력 디바운스(ms) */
  const DEBOUNCE_MS = 300;

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

  /** 카카오 category_name(+장소 이름) -> 'train'(기차역) | 'bus'(고속·시외버스터미널) | null. 지하철역(SW8)은 기차역이 아니다.
   *  카카오가 군내·시내·농어촌·마을버스 정류장도 '고속,시외버스터미널'로 분류하므로 이름으로 뺀다 (예: 화순군내버스정류장) */
  function hubOfCategory(full, name) {
    const s = String(full || '');
    if (/기차역/.test(s)) return 'train';
    if (/버스터미널/.test(s) && !/군내버스|시내버스|농어촌버스|마을버스/.test(String(name || ''))) return 'bus';
    return null;
  }

  function kakaoPlaceResults(data) {
    return (data || [])
      .map((d) => ({
        name: d.place_name || '',
        displayName: [d.road_address_name || d.address_name, d.category_group_name].filter(Boolean).join(' · '),
        lat: parseFloat(d.y),
        lon: parseFloat(d.x),
        category: kakaoCategory(d),
        hub: hubOfCategory(d.category_name, d.place_name),
        distance: d.distance ? Number(d.distance) : null, // 기준점 검색일 때만 (m)
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
  // 공개 API
  // =====================================================================
  /** 장소 검색 -> [{ name, displayName, lat, lon, category, hub, source: 'kakao' }]
   *  카카오 키워드 -> 주소 검색. 카카오를 쓸 수 없거나 실패하면 throw (빈 배열은 '결과 없음') */
  async function search(query, signal) {
    const q = query.trim();
    const cached = searchCache.get(q);
    if (cached) return cached;
    const { list, failed } = await searchKakaoOnly(q);
    if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
    if (failed) throw new Error('카카오 검색 실패');
    searchCache.set(q, list);
    return list;
  }

  /** 좌표 -> 장소 이름 { name, displayName, category, source }. 카카오를 쓸 수 없거나 실패·결과 없음이면 throw */
  async function reverse(lat, lon) {
    if (!(await loadKakao())) throw new Error('카카오를 쓸 수 없음');
    const r = await reverseKakao(lat, lon);
    if (!r) throw new Error('주소 없음');
    return r;
  }

  /** 카카오 검색 -> { list, failed }: 오류(failed)와 '결과 없음'(빈 list)을 구분한다 */
  async function searchKakaoOnly(query) {
    if (!(await loadKakao())) return { list: [], failed: true };
    try {
      return { list: await searchKakao(query.trim()), failed: false };
    } catch (e) {
      console.warn(e);
      return { list: [], failed: true };
    }
  }

  /** 장소 주변(20km) 기차역/버스터미널, 가까운 순 -> { list, failed }.
   *  failed: 카카오를 쓸 수 없거나 한 페이지라도 조회에 실패함 (list가 적거나 비어도 '근처에 없음'이 아니다) */
  async function nearbyHubs(place, kind) {
    if (!(await loadKakao())) return { list: [], failed: true };
    const kk = window.kakao.maps;
    const opts = { location: new kk.LatLng(place.lat, place.lon), radius: 20000, sort: kk.services.SortBy.DISTANCE, size: 15 };
    // 카카오는 한 번에 15개까지만 주고 '버스터미널' 분류로 검색할 수도 없다. 큰 터미널 근처는 가게·주차장이 첫 페이지를 채우므로 3페이지(45개)까지 받아 거른다
    const docs = [];
    let failed = false;
    for (let page = 1; page <= 3; page++) {
      try {
        const got = await kakaoCall((cb) => new kk.services.Places().keywordSearch(kind === 'train' ? '기차역' : '버스터미널', cb, { ...opts, page }), (d) => d || []);
        docs.push(...got);
        if (got.length < opts.size) break; // 마지막 페이지
      } catch (e) {
        console.warn(e);
        failed = true; // 받은 페이지까지는 보여 주되, 목록이 다 온 것이 아님을 알린다
        break;
      }
    }
    return { list: kakaoPlaceResults(docs).filter((r) => r.hub === kind && !/폐역|폐쇄/.test(r.name)), failed }; // 폐역은 제외
  }

  TP.geocode = {
    hubOfCategory,
    nearbyHubs,
    search,
    searchKakaoOnly,
    reverse,
    DEBOUNCE_MS,
  };
})();
