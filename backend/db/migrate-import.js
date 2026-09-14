#!/usr/bin/env node
/**
 * 5단계 데이터 이관 - Phase B: Phase A가 db/_export/*.json에 저장해둔 실데이터를
 * hr_cx_manage_de에 실제로 넣는다. Phase A에서 중복(사번/no) 없음을 이미 확인한 뒤에만 실행.
 *
 * - 데이터 구조/필드는 전혀 재설계하지 않고 tableSchemas.js의 컬럼 목록을 그대로 재사용해서
 *   API가 쓰는 것과 동일한 INSERT...ON CONFLICT DO UPDATE 패턴으로 넣는다.
 * - meta.accounts의 평문 비밀번호만 이 시점에 bcrypt로 해시 변환한다(그 외 값은 그대로).
 * - 절대 Supabase에는 쓰지 않는다(원본 보존, 2단계 계획서 5절).
 */
// ENV_FILE=.env.production node db/migrate-import.js 처럼 지정하면 운영 DB로, 안 지정하면
// 기본 .env(개발 DB)로 연결한다 — dev/운영 접속정보를 같은 파일에 섞지 않기 위함.
require('dotenv').config({ path: process.env.ENV_FILE || '.env' });
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('../src/db');
const { TABLES } = require('../src/tableSchemas');

const EXPORT_DIR = path.join(__dirname, '_export');

function loadExport(table) {
  const p = path.join(EXPORT_DIR, table + '.json');
  if (!fs.existsSync(p)) throw new Error(`${p} 없음 - 먼저 migrate-export-validate.js(Phase A)를 실행하세요`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// tables.js와 동일한 이유(node-postgres가 JS 배열을 jsonb 파라미터로 줄 때 Postgres 배열
// 리터럴로 잘못 직렬화하는 문제)로, 항상 문자열로 넘긴다.
function normalizeJsonInput(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

async function upsertRows(client, table, rows) {
  const schema = TABLES[table];
  if (!rows.length) return 0;
  const cols = schema.columns;
  const values = [];
  const rowPlaceholders = rows.map((row) => {
    const ph = cols.map((c) => {
      let v = row[c];
      if (v === undefined) v = null;
      if (schema.json.includes(c)) v = normalizeJsonInput(v);
      values.push(v);
      return `$${values.length}`;
    });
    return `(${ph.join(',')})`;
  });
  const colList = cols.map((c) => `"${c}"`).join(',');
  const updateSet = cols.filter((c) => c !== schema.pk).map((c) => `"${c}"=EXCLUDED."${c}"`).concat('"updated_at"=now()').join(', ');
  const sql = `INSERT INTO "${table}" (${colList}) VALUES ${rowPlaceholders.join(',')} ON CONFLICT ("${schema.pk}") DO UPDATE SET ${updateSet}`;
  await client.query(sql, values);
  return rows.length;
}

// 대량 테이블은 한 번에 너무 많은 파라미터를 보내면 안 되므로 나눠서 처리
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('=== 1) employees ===');
    const employees = loadExport('employees');
    await upsertRows(client, 'employees', employees);
    console.log(`  ${employees.length}행 이관 완료`);

    console.log('=== 2) contracts ===');
    const contracts = loadExport('contracts');
    await upsertRows(client, 'contracts', contracts);
    console.log(`  ${contracts.length}행 이관 완료`);

    console.log('=== 3) att_data (청크 단위) ===');
    const attData = loadExport('att_data');
    let attCount = 0;
    for (const c of chunk(attData, 500)) { await upsertRows(client, 'att_data', c); attCount += c.length; }
    console.log(`  ${attCount}행 이관 완료`);

    console.log('=== 4) slack_data (청크 단위) ===');
    const slackData = loadExport('slack_data');
    let slackCount = 0;
    for (const c of chunk(slackData, 500)) { await upsertRows(client, 'slack_data', c); slackCount += c.length; }
    console.log(`  ${slackCount}행 이관 완료`);

    console.log('=== 5) hr_saved ===');
    const hrSaved = loadExport('hr_saved');
    await upsertRows(client, 'hr_saved', hrSaved);
    console.log(`  ${hrSaved.length}행 이관 완료`);

    console.log('=== 6) sched_saved ===');
    const schedSaved = loadExport('sched_saved');
    await upsertRows(client, 'sched_saved', schedSaved);
    console.log(`  ${schedSaved.length}행 이관 완료`);

    console.log('=== 7) meta (accounts는 평문 비밀번호를 bcrypt로 해시 변환) ===');
    const meta = loadExport('meta');
    let hashedCount = 0;
    const metaTransformed = await Promise.all(meta.map(async (row) => {
      if (row.key !== 'accounts') return row;
      let accounts;
      try { accounts = JSON.parse(row.value); } catch (e) { return row; }
      if (!Array.isArray(accounts)) return row;
      const hashed = await Promise.all(accounts.map(async (a) => {
        if (a.pw && !String(a.pw).startsWith('$2')) {
          hashedCount++;
          return { ...a, pw: await bcrypt.hash(String(a.pw), 12) };
        }
        return a;
      }));
      return { ...row, value: JSON.stringify(hashed) };
    }));
    await upsertRows(client, 'meta', metaTransformed);
    console.log(`  ${meta.length}행 이관 완료 (계정 비밀번호 ${hashedCount}개 bcrypt 해시로 변환됨)`);

    await client.query('COMMIT');
    console.log('\n=== 커밋 완료 - 전부 하나의 트랜잭션으로 처리됨 ===');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('오류 발생, 전체 롤백함:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch(() => { process.exitCode = 1; })
  .finally(() => pool.end());
