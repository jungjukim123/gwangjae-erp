#!/usr/bin/env node
/**
 * 로그인 계정을 하나 만들거나(이미 있으면) 비밀번호를 초기화합니다.
 * meta.accounts(JSONB 배열) 구조는 src/routes/auth.js와 완전히 동일하게 다룹니다.
 *
 * 반드시 본인 터미널에서 직접 실행하세요 (Claude Code가 대신 실행하면 안 됩니다).
 * 이 스크립트는 입력받은 비밀번호를 어디에도 저장/전송하지 않고 bcrypt 해시로만 DB에 남깁니다.
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

async function main() {
  console.log('=== 로그인 계정 생성/초기화 ===');
  console.log('지금 .env에 설정된 DB(' + process.env.PGDATABASE + '@' + process.env.PGHOST + ')에 계정을 만듭니다.');
  console.log('');

  const id = (await ask('아이디: ')).trim();
  if (!id) throw new Error('아이디를 입력해주세요.');
  const name = (await ask('이름: ')).trim() || id;
  // 화면에 안 보이게 입력받는 방식이 일부 Windows cmd 환경에서 입력이 씹히는 문제가 있어,
  // 신뢰성을 위해 그냥 화면에 보이는 일반 입력으로 받는다 (팀 전용 PC에서 본인이 직접 1회 실행).
  const password = (await ask('비밀번호 (4자 이상): ')).trim();
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
