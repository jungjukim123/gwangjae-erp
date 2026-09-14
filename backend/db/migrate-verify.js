#!/usr/bin/env node
/**
 * 5단계 데이터 이관 - Phase C: 이관 후 검증.
 * db/_export/*.json(Supabase 원본)과 hr_cx_manage_de 실제 데이터를 대조한다.
 * 2단계 계획서 5절: 행수 비교 + 샘플 diff + JSON 배열 필드 항목수 비교.
 */
// ENV_FILE=.env.production node db/migrate-verify.js 로 운영 DB 대상 검증 가능
require('dotenv').config({ path: process.env.ENV_FILE || '.env' });
const fs = require('fs');
const path = require('path');
const pool = require('./../src/db');

const EXPORT_DIR = path.join(__dirname, '_export');
function loadExport(table) {
  return JSON.parse(fs.readFileSync(path.join(EXPORT_DIR, table + '.json'), 'utf8'));
}

async function main() {
  let problems = [];

  console.log('=== 1) 테이블별 행수 비교 (Supabase export vs hr_cx_manage_de) ===');
  const TABLES = ['employees', 'contracts', 'att_data', 'slack_data', 'hr_saved', 'meta', 'sched_saved'];
  for (const t of TABLES) {
    const source = loadExport(t);
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM "${t}"`);
    const target = rows[0].n;
    const ok = source.length === target;
    console.log(`  ${t}: 원본 ${source.length}행 / 이관본 ${target}행 ${ok ? 'OK' : '⚠️ 불일치!'}`);
    if (!ok) problems.push(`${t} 행수 불일치: 원본=${source.length} 이관본=${target}`);
  }

  console.log('\n=== 2) employees 샘플 대조 (무작위 5건, 사번/이름/시급만 표시) ===');
  const empSource = loadExport('employees');
  const sampleIdx = [];
  for (let i = 0; i < Math.min(5, empSource.length); i++) sampleIdx.push(Math.floor(Math.random() * empSource.length));
  for (const idx of sampleIdx) {
    const s = empSource[idx];
    const { rows } = await pool.query('SELECT "사번","이름","시급" FROM employees WHERE "사번" = $1', [s.사번]);
    const t = rows[0];
    const ok = t && t.이름 === s.이름 && Number(t.시급) === Number(s.시급 || 0);
    console.log(`  사번=${s.사번}: 원본(이름=${s.이름},시급=${s.시급}) vs 이관본(${t ? `이름=${t.이름},시급=${t.시급}` : '없음!'}) ${ok ? 'OK' : '⚠️ 불일치!'}`);
    if (!ok) problems.push(`employees 샘플 불일치: 사번=${s.사번}`);
  }

  console.log('\n=== 3) att_data / hr_saved 대량 데이터 해시 비교 ===');
  for (const t of ['att_data', 'hr_saved']) {
    const { rows } = await pool.query(`SELECT md5(string_agg(md5(t::text), '' ORDER BY key)) AS h FROM "${t}" t`);
    console.log(`  ${t} 테이블 해시: ${rows[0].h} (참고용 — 원본 Supabase는 Postgres 직접 접속이 없어 동일 방식 재계산 불가, 대신 아래 4번 항목수 비교로 대체 검증)`);
  }

  console.log('\n=== 4) hr_saved / sched_saved의 days_json 배열 항목수 비교 ===');
  for (const t of ['hr_saved', 'sched_saved']) {
    const source = loadExport(t);
    const { rows } = await pool.query(`SELECT key, jsonb_array_length(days_json) AS n FROM "${t}"`);
    const targetMap = new Map(rows.map((r) => [r.key, r.n]));
    let mismatch = 0;
    for (const s of source) {
      let srcArr;
      try { srcArr = JSON.parse(s.days_json || '[]'); } catch (e) { srcArr = []; }
      const targetN = targetMap.get(s.key);
      if (!Array.isArray(srcArr) || srcArr.length !== targetN) {
        mismatch++;
        if (mismatch <= 3) console.log(`  ⚠️ ${t} key=${s.key}: 원본 ${srcArr.length}개 vs 이관본 ${targetN}개`);
      }
    }
    console.log(`  ${t}: 총 ${source.length}행 중 항목수 불일치 ${mismatch}건`);
    if (mismatch > 0) problems.push(`${t} days_json 항목수 불일치 ${mismatch}건`);
  }

  console.log('\n=== 5) meta의 배열형 값 항목수 비교 (leaveUsage, otRequests, attRequests, somData) ===');
  const metaSource = loadExport('meta');
  const { rows: metaTarget } = await pool.query('SELECT key, value FROM meta');
  const metaTargetMap = new Map(metaTarget.map((r) => [r.key, r.value]));
  for (const s of metaSource) {
    let srcParsed;
    try { srcParsed = JSON.parse(s.value); } catch (e) { continue; }
    if (!Array.isArray(srcParsed)) continue;
    const tgt = metaTargetMap.get(s.key);
    const tgtArr = Array.isArray(tgt) ? tgt : (typeof tgt === 'string' ? JSON.parse(tgt) : null);
    const ok = Array.isArray(tgtArr) && tgtArr.length === srcParsed.length;
    console.log(`  ${s.key}: 원본 ${srcParsed.length}개 vs 이관본 ${tgtArr ? tgtArr.length : '파싱불가'}개 ${ok ? 'OK' : '⚠️ 불일치!'}`);
    if (!ok) problems.push(`meta.${s.key} 배열 항목수 불일치`);
  }

  console.log('\n=== 6) accounts 비밀번호 해시 상태 재확인 ===');
  const accRow = metaTarget.find((r) => r.key === 'accounts');
  const accounts = Array.isArray(accRow.value) ? accRow.value : JSON.parse(accRow.value);
  const stillPlain = accounts.filter((a) => a.pw && !String(a.pw).startsWith('$2')).length;
  console.log(`  전체 ${accounts.length}개 중 평문 남은 것: ${stillPlain}개`);
  if (stillPlain > 0) problems.push(`accounts에 아직 평문 비밀번호 ${stillPlain}개 남음`);

  console.log('\n=== 최종 결과 ===');
  if (problems.length === 0) {
    console.log('전부 통과. 데이터 이관 검증 완료.');
  } else {
    console.log(`문제 ${problems.length}건:`);
    problems.forEach((p) => console.log('  - ' + p));
    process.exitCode = 1;
  }
}

main().catch((err) => { console.error('검증 스크립트 오류:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
