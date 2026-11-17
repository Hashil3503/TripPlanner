/* version.js - public/ 파일 이름과 내용으로 앱 버전 해시를 계산한다 (배포 판별용) */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** 하위 폴더까지 파일 목록을 모은다 (점으로 시작하는 파일/폴더는 건너뛴다) */
function collect(dir, rel, out) {
  for (const ent of fs.readdirSync(rel ? path.join(dir, rel) : dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const relPath = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) collect(dir, relPath, out);
    else if (ent.isFile()) out.push({ rel: relPath, abs: path.join(dir, relPath) });
  }
}

/** dir 아래 모든 파일을 경로순으로 SHA-256에 넣고 앞 12자리를 돌려준다. 내용이나 이름이 바뀌면 값이 달라진다 */
function computeAppVersion(dir) {
  const files = [];
  collect(dir, '', files);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const hash = crypto.createHash('sha256');
  for (const f of files) {
    hash.update(f.rel, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(fs.readFileSync(f.abs));
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex').slice(0, 12);
}

module.exports = { computeAppVersion };
