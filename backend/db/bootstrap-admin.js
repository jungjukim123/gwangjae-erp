#!/usr/bin/env node
/**
 * pgAdmin4나 원격 데스크톱 없이, 이 스크립트로 (1) hr_cx_manage_de DB 생성,
 * (2) 이 프로젝트 전용 최소권한 role(hr_cx_manage_app) 생성 + 권한부여,
 * (3) schema.sql 적용까지 한 번에 처리합니다.
 *
 * 반드시 본인 터미널에서 직접 실행하세요 (Claude Code가 대신 실행하면 안 됩니다).
 * 관리자 비밀번호는 화면에 표시되지 않고, 이 스크립트는 그 값을 어디에도 저장/전송하지 않습니다.
 *
 * 사용법 (본인 터미널에서):
 *   cd backend
 *   node db/bootstrap-admin.js
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Client } = require('pg');

function ask(question) {
  return new Promise(function (resolve) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, function (answer) {
      rl.close();
      resolve(answer);
    });
  });
}

// 리터럴 제어문자를 소스에 직접 넣지 않고 문자 코드 숫자로만 비교한다.
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

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
function assertIdent(name, label) {
  if (!IDENT_RE.test(name)) {
    throw new Error(label + ' 형식이 올바르지 않습니다: "' + name + '" (영문/숫자/밑줄만, 첫글자는 영문 또는 밑줄)');
  }
}

async function main() {
  console.log('=== hr_cx_manage DB 부트스트랩 (관리자 권한 필요) ===');
  console.log('이 PC에서 10.10.70.115로 직접 접속됩니다. 입력값은 이번 실행에만 쓰이고 저장되지 않습니다.');
  console.log('');

  const host = (await ask('PostgreSQL 호스트 [10.10.70.115]: ')) || '10.10.70.115';
  const port = Number((await ask('포트 [5432]: ')) || '5432');
  const adminUser = (await ask('관리자 계정명 [postgres]: ')) || 'postgres';
  const adminPassword = await askHidden('관리자 비밀번호 (화면에 표시되지 않습니다): ');
  const targetDb = (await ask('생성할 DB 이름 [hr_cx_manage_de]: ')) || 'hr_cx_manage_de';
  const appUser = (await ask('앱 전용 계정명 [hr_cx_manage_app]: ')) || 'hr_cx_manage_app';
  const appPassword = await askHidden('앱 전용 계정의 새 비밀번호를 정해주세요 (화면 미표시): ');

  assertIdent(targetDb, 'DB 이름');
  assertIdent(appUser, '계정명');
  if (!appPassword || appPassword.length < 8) {
    throw new Error('앱 전용 계정 비밀번호는 8자 이상으로 정해주세요.');
  }

  // 1) 관리자 권한으로 기본 postgres DB에 접속 -> 대상 DB 없으면 생성
  const adminClient = new Client({ host: host, port: port, user: adminUser, password: adminPassword, database: 'postgres' });
  await adminClient.connect();
  try {
    const exists = await adminClient.query('SELECT 1 FROM pg_database WHERE datname = $1', [targetDb]);
    if (exists.rowCount === 0) {
      await adminClient.query('CREATE DATABASE "' + targetDb + '"');
      console.log('데이터베이스 "' + targetDb + '" 생성 완료');
    } else {
      console.log('데이터베이스 "' + targetDb + '"는 이미 존재합니다 (건너뜀)');
    }
  } finally {
    await adminClient.end();
  }

  // 2) 대상 DB에 관리자로 접속 -> 앱 전용 role 생성/갱신 + 최소권한 부여 + schema.sql 적용
  const dbClient = new Client({ host: host, port: port, user: adminUser, password: adminPassword, database: targetDb });
  await dbClient.connect();
  try {
    const roleExists = await dbClient.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [appUser]);
    if (roleExists.rowCount === 0) {
      await dbClient.query('CREATE ROLE "' + appUser + '" WITH LOGIN PASSWORD $1', [appPassword]);
      console.log('role "' + appUser + '" 생성 완료');
    } else {
      await dbClient.query('ALTER ROLE "' + appUser + '" WITH PASSWORD $1', [appPassword]);
      console.log('role "' + appUser + '"는 이미 존재해서 비밀번호만 갱신했습니다');
    }

    await dbClient.query('GRANT CONNECT ON DATABASE "' + targetDb + '" TO "' + appUser + '"');
    await dbClient.query('GRANT USAGE ON SCHEMA public TO "' + appUser + '"');
    await dbClient.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "' + appUser + '"');
    await dbClient.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "' + appUser + '"');
    await dbClient.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "' + appUser + '"');
    await dbClient.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "' + appUser + '"');
    console.log('권한 부여 완료');

    const already = await dbClient.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name IN " +
      "('employees','contracts','att_data','slack_data','hr_saved','meta','sched_saved','audit_log','session')"
    );
    if (already.rows[0].n > 0) {
      console.log('테이블이 이미 ' + already.rows[0].n + '개 존재합니다 - schema.sql은 건너뜁니다(중복 생성 방지, CREATE TABLE에 IF NOT EXISTS가 없어 재실행하면 에러납니다).');
      console.log('스키마를 다시 만들어야 하면 기존 테이블을 확인 후 수동으로 정리해주세요.');
    } else {
      const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
      await dbClient.query(schemaSql);
      console.log('schema.sql 적용 완료 (employees/contracts/att_data/slack_data/hr_saved/meta/sched_saved + audit_log + session)');
    }
  } finally {
    await dbClient.end();
  }

  console.log('');
  console.log('=== 완료 ===');
  console.log('이제 backend/.env를 만들고 아래 값을 채워주세요 (비밀번호는 방금 정하신 앱 전용 계정 비밀번호):');
  console.log('  PGHOST=' + host);
  console.log('  PGPORT=' + port);
  console.log('  PGDATABASE=' + targetDb);
  console.log('  PGUSER=' + appUser);
  console.log('  PGPASSWORD=(방금 입력하신 값)');
}

main().catch(function (err) {
  console.error('오류: ' + err.message);
  process.exit(1);
});
