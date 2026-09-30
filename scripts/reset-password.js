/* reset-password.js - 비밀번호를 잊은 계정의 비밀번호를 이 컴퓨터에서 직접 재설정한다.
 * 사용: npm run reset-password -- <아이디>   (DB 경로는 서버와 같이 TP_DB_PATH, 기본 data/tripplanner.db)
 * 비밀번호는 인자로 받지 않고 터미널에서 (화면에 보이지 않게) 두 번 입력받는다. 해당 계정의 모든 로그인 세션도 끊는다. */
'use strict';
const path = require('node:path');
const { open } = require('../server/db');
const auth = require('../server/auth');

const DB_PATH = process.env.TP_DB_PATH || path.join(__dirname, '..', 'data', 'tripplanner.db');

const fail = (msg, code) => {
  console.error(msg);
  process.exit(code || 1);
};

/** 입력 내용을 화면에 표시하지 않고 한 줄을 읽는다. 취소(Ctrl+C/Esc)나 빈 입력이면 null */
function readHidden(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let buf = '';
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (v) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      resolve(v);
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(buf || null);
        if (ch === '\u0003' || ch === '\u001b') return done(null); // Ctrl+C, Esc
        if (ch === '\u007f' || ch === '\b') buf = Array.from(buf).slice(0, -1).join('');
        else if (ch >= ' ') buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const username = process.argv[2];
  if (process.argv.length !== 3 || !username) fail('사용법: npm run reset-password -- <아이디>', 2);
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail('터미널에서 직접 실행해 주세요. 비밀번호를 파이프나 인자로 받지 않아요.', 2);

  let db;
  try {
    db = open(DB_PATH);
  } catch (e) {
    fail(`데이터베이스를 열 수 없어요: ${e.message}`);
  }
  try {
    const user = auth.USERNAME_RE.test(username) ? db.findUser(username) : null; // 로그인과 같은 조회 (대소문자 무시)
    if (!user) fail(`'${username}' 계정을 찾을 수 없어요.`);

    const pass = await readHidden(`${user.username} 계정의 새 비밀번호 (${auth.PASSWORD_MIN}~${auth.PASSWORD_MAX}자, 취소: 빈 입력/Ctrl+C): `);
    if (pass === null) fail('취소했어요. 변경된 것은 없어요.', 130);
    if (pass.length < auth.PASSWORD_MIN || pass.length > auth.PASSWORD_MAX) fail(`비밀번호는 ${auth.PASSWORD_MIN}~${auth.PASSWORD_MAX}자로 입력해 주세요.`);
    const pass2 = await readHidden('새 비밀번호 확인: ');
    if (pass2 === null) fail('취소했어요. 변경된 것은 없어요.', 130);
    if (pass !== pass2) fail('두 비밀번호가 일치하지 않아요. 변경된 것은 없어요.');

    db.setPassword(user.id, await auth.hashPassword(pass));
    const n = Number(db.deleteUserSessions(user.id).changes);
    console.log(`${user.username} 계정의 비밀번호를 변경했어요. 로그인 중이던 세션 ${n}개는 로그아웃 처리했어요.`);
  } finally {
    db.close();
  }
}

main().catch((e) => fail(`실패했어요: ${e.message}`));
