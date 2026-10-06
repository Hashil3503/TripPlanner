/* deploy.js - 외부 배포용 설정 해석 (환경변수)
 * - TP_PUBLIC_URL: 서비스 주소. 쉼표로 여러 개 (예: https://trip.example.com). 이 주소의 Host/Origin 요청을 허용하고,
 *   https 주소가 있으면 세션 쿠키에 Secure를 붙인다.
 * - TP_TRUST_PROXY=1: 같은 PC의 리버스 프록시(Caddy/Nginx) 뒤에서 실행할 때, 프록시가 붙인 X-Forwarded-For로 접속자 IP를 판단한다. */
'use strict';

/** 'https://a.com, http://1.2.3.4:8080' -> [{ origin, host, https }] (잘못된 값은 이유와 함께 throw) */
function parsePublicUrls(raw) {
  const out = [];
  for (const part of String(raw || '').split(',')) {
    const v = part.trim();
    if (!v) continue;
    let u;
    try {
      u = new URL(v);
    } catch (e) {
      throw new Error(`TP_PUBLIC_URL 값이 주소 형식이 아니에요: ${v}`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`TP_PUBLIC_URL은 http:// 또는 https:// 로 시작해야 해요: ${v}`);
    if ((u.pathname && u.pathname !== '/') || u.search || u.hash || u.username || u.password) {
      throw new Error(`TP_PUBLIC_URL에는 경로 없이 주소만 적어 주세요 (예: https://trip.example.com): ${v}`);
    }
    out.push({ origin: u.origin, host: u.host.toLowerCase(), https: u.protocol === 'https:' });
  }
  return out;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** 접속자 IP. 프록시를 믿는 설정이고 요청이 같은 PC(프록시)에서 왔을 때만 X-Forwarded-For의 마지막 값(프록시가 본 접속자)을 쓴다 */
function clientIpFrom(req, trustProxy) {
  const direct = req.socket.remoteAddress || 'unknown';
  if (!trustProxy || !LOOPBACK.has(direct)) return direct;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1].slice(0, 64) : direct;
}

module.exports = { parsePublicUrls, clientIpFrom };
