'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePublicUrls, clientIpFrom } = require('../server/deploy');
const auth = require('../server/auth');

test('parsePublicUrls: 비어 있으면 빈 목록, 여러 주소는 쉼표로', () => {
  assert.deepEqual(parsePublicUrls(''), []);
  assert.deepEqual(parsePublicUrls(undefined), []);
  assert.deepEqual(parsePublicUrls(' https://Trip.Example.com , http://1.2.3.4:8080/ '), [
    { origin: 'https://trip.example.com', host: 'trip.example.com', https: true },
    { origin: 'http://1.2.3.4:8080', host: '1.2.3.4:8080', https: false },
  ]);
});

test('parsePublicUrls: 잘못된 값은 거부', () => {
  for (const bad of ['trip.example.com', 'ftp://a.com', 'https://a.com/app', 'https://a.com/?x=1', 'https://u:p@a.com']) {
    assert.throws(() => parsePublicUrls(bad), /TP_PUBLIC_URL/, bad);
  }
});

test('clientIpFrom: 프록시를 믿을 때만, 같은 PC에서 온 요청의 X-Forwarded-For 마지막 값', () => {
  const req = (remote, xff) => ({ socket: { remoteAddress: remote }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  assert.equal(clientIpFrom(req('127.0.0.1', '9.9.9.9, 5.6.7.8'), false), '127.0.0.1');
  assert.equal(clientIpFrom(req('127.0.0.1', '9.9.9.9, 5.6.7.8'), true), '5.6.7.8');
  assert.equal(clientIpFrom(req('::1', '5.6.7.8'), true), '5.6.7.8');
  assert.equal(clientIpFrom(req('127.0.0.1'), true), '127.0.0.1');
  // 프록시가 아닌 곳에서 직접 온 요청은 헤더를 무시 (위조 방지)
  assert.equal(clientIpFrom(req('3.3.3.3', '5.6.7.8'), true), '3.3.3.3');
});

test('세션 쿠키: secure면 Secure 속성', () => {
  assert.ok(!auth.sessionCookie('t', false).includes('Secure'));
  assert.ok(auth.sessionCookie('t', true).endsWith('; Secure'));
  assert.ok(auth.clearCookie(true).includes('Max-Age=0; Secure'));
});
