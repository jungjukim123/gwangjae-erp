#!/usr/bin/env node
/**
 * 로그인 계정을 하나 만들거나(이미 있으면) 비밀번호를 초기화합니다.
 * meta.accounts(JSONB 배열) 구조는 src/routes/auth.js와 완전히 동일하게 다룹니다.
 *
 * 반드시 본인 터미널에서 직접 실행하세요 (Claude Code가 대신 실행하면 안 됩니다).
 * 비밀번호는 화면에 표시되지 않고, 이 스크립트는 그 값을 어디에도 저장/전송하지 않습니다.
 *
 * 사용법 (backend 폴더에서, .env가 이미 있는 상태로):
 *   node db/create-account.js
 */
require('dotenv').config();
const readline = require('readline');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

function ask(question) {
  return new Promise(function (resolve) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, function (answer) {
      rl.close();
      resolve(answer);
    });
  });
}

// bootstrap-admin.js와 동일한 방식 — 리터럴 제어문자를 소스에 넣지 않고 문자 코드로만 비교.
const KEY_ENTER_CR = 13;
const KEY_ENTER_LF = 10;
const KEY_EOF_CTRL_D = 4;
const KEY_CANCEL_CTRL_C = 3;
const KEY_BACKSPACE = 8;
const KEY_DELETE = 127;
const NEWLINE = String.fromCharCode(10);

function askHidden(question) {
  return new Promise(function (resolve, reject) {
    process.stdout.write(question);
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error('터미널(TTY)에서 직접 실행해주세요 - 비밀번호를 안전하게 입력받을 수 없습니다.'));
      return;
    }
    stdin.resume();
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    let input = '';
    function onData(chunk) {
      const code = chunk.charCodeAt(0);
      if (code === KEY_ENTER_CR || code === KEY_ENTER_LF || code === KEY_EOF_CTRL_D) {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write(NEWLINE);
        resolve(input);
        return;
      }
      if (code === KEY_CANCEL_CTRL_C) {
        stdin.setRawMode(false);
        process.stdout.write(NEWLINE);
        process.exit(1);
        return;
      }
      if (code === KEY_BACKSPACE || code === KEY_DELETE) {
        input = input.slice(0, -1);
        return;
      }
      input += chunk;
    }
    stdin.on('data', onData);
  });
}

async function main() {
  console.log('=== 로그인 계정 생성/초기화 ===');
  console.log('지금 .env에 설정된 DB(' + process.env.PGDATABASE + '@' + process.env.PGHOST + ')에 계정을 만듭니다.');
  console.log('');

  const id = (await ask('아이디: ')).trim();
  if (!id) throw new Error('아이디를 입력해주세요.');
  const name = (await ask('이름: ')).trim() || id;
  const password = await askHidden('비밀번호 (4자 이상, 화면에 표시되지 않습니다): ');
  if (!password || password.length < 4) throw new Error('비밀번호는 4자 이상이어야 합니다.');
  const role = (await ask("역할 [hr]: ")).trim() || 'hr';

  const pool = new Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl: process.env.PGSSL === 'true',
  });

  try {
    const { rows } = await pool.query("SELECT value FROM meta WHERE key = 'accounts'");
    const accounts = rows.length && Array.isArray(rows[0].value) ? rows[0].value : [];

    const hashedPw = await bcrypt.hash(password, 12);
    const idx = accounts.findIndex((a) => a.id === id);
    const isNew = idx < 0;
    const nextAcc = { id, pw: hashedPw, role, name, info: '', av: name[0] || 'A', menus: null };
    if (isNew) accounts.push(nextAcc); else accounts[idx] = nextAcc;

    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 3600 * 1000);
    const updated = kst.toISOString().slice(0, 16).replace('T', ' ');

    await pool.query(
      `INSERT INTO meta (key, value, updated) VALUES ('accounts', $1::jsonb, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated = EXCLUDED.updated, updated_at = now()`,
      [JSON.stringify(accounts), updated]
    );

    console.log('');
    console.log(isNew ? '계정 생성 완료: ' : '기존 계정 비밀번호 갱신 완료: ', id, '(role=' + role + ')');
  } finally {
    await pool.end();
  }
}

main().catch(function (err) {
  console.error('오류: ' + err.message);
  process.exit(1);
});
