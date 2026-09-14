#!/usr/bin/env node
/**
 * 5단계 데이터 이관 - Phase A: Supabase에서 실데이터를 읽어와(읽기 전용, Supabase에는
 * 아무것도 쓰지 않음) 검증만 한다. hr_cx_manage_de에도 아직 아무것도 쓰지 않는다.
 *
 * SB_URL/SB_KEY는 gwangjae_v222.html에 이미 있는 값을 그대로 읽어서 쓴다(중복 보관 안 함).
 *
 * 검증 항목 (2단계 계획서 5절):
 *  - 7개 테이블 행 수
 *  - employees.사번 중복 여부 (PK 제약 걸기 전 필수 점검)
 *  - contracts.no 중복 여부
 *  - meta 안의 leaveUsage/salSnapshot 같은 배열형 값들의 항목 수
 *  - accounts 중 비밀번호가 이미 bcrypt 해시인지 평문인지 (해시면 $2로 시작)
 *
 * 결과를 db/_export/ 밑에 JSON으로 저장해서 Phase B(실제 이관)가 그대로 재사용한다.
 */
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', '..', 'gwangjae_v222.html');
const OUT_DIR = path.join(__dirname, '_export');

function extractSupabaseCreds() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const urlM = html.match(/const SB_URL\s*=\s*'([^']+)'/);
  const keyM = html.match(/const SB_KEY\s*=\s*'([^']+)'/);
  if (!urlM || !keyM) throw new Error('gwangjae_v222.html에서 SB_URL/SB_KEY를 못 찾음');
  return { url: urlM[1], key: keyM[1] };
}

async function sbSelectAll(url, key, table) {
  const PAGE = 1000;
  let all = [];
  let offset = 0;
  while (true) {
    const res = await fetch(`${url}/rest/v1/${table}?limit=${PAGE}&offset=${offset}`, {
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Range-Unit': 'items' },
    });
    if (!res.ok) throw new Error(`SELECT ${table} 실패: ${res.status} ${await res.text()}`);
    const rows = await res.json();
    all = all.concat(rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

function findDuplicates(rows, field) {
  const seen = new Map();
  const dups = new Map();
  for (const r of rows) {
    const v = r[field];
    if (v === undefined || v === null || v === '') continue;
    if (seen.has(v)) {
      if (!dups.has(v)) dups.set(v, [seen.get(v)]);
      dups.get(v).push(r);
    } else {
      seen.set(v, r);
    }
  }
  return dups;
}

async function main() {
  const { url, key } = extractSupabaseCreds();
  console.log('=== Supabase 실데이터 export (읽기 전용) ===');
  console.log('URL:', url, '\n');

  const TABLES = ['employees', 'contracts', 'att_data', 'slack_data', 'hr_saved', 'meta', 'sched_saved'];
  const data = {};
  for (const t of TABLES) {
    process.stdout.write(`  ${t} 조회 중... `);
    data[t] = await sbSelectAll(url, key, t);
    console.log(`${data[t].length}행`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const t of TABLES) {
    fs.writeFileSync(path.join(OUT_DIR, t + '.json'), JSON.stringify(data[t]), 'utf8');
  }
  console.log(`\n원본 데이터를 ${OUT_DIR} 에 저장함 (Phase B에서 재사용, Supabase는 다시 안 건드림)\n`);

  console.log('=== 검증 1) employees.사번 중복 확인 ===');
  const empDups = findDuplicates(data.employees, '사번');
  if (empDups.size === 0) {
    console.log('  중복 없음 - PK 제약 걸어도 안전\n');
  } else {
    console.log(`  ⚠️ 중복 사번 ${empDups.size}건 발견 - 자동 병합하지 않음, 아래 확인 필요:`);
    for (const [sabn, rows] of empDups) {
      console.log(`    사번 "${sabn}": ${rows.length}행 (이름: ${rows.map((r) => r.이름).join(', ')})`);
    }
    console.log('');
  }

  console.log('=== 검증 2) contracts.no 중복 확인 ===');
  const conDups = findDuplicates(data.contracts, 'no');
  if (conDups.size === 0) {
    console.log('  중복 없음 - PK 제약 걸어도 안전\n');
  } else {
    console.log(`  ⚠️ 중복 no ${conDups.size}건 발견 - 자동 병합하지 않음, 아래 확인 필요:`);
    for (const [no, rows] of conDups) {
      console.log(`    no ${no}: ${rows.length}행 (이름: ${rows.map((r) => r.이름).join(', ')}, key: ${rows.map((r) => r.key).join(', ')})`);
    }
    console.log('');
  }

  console.log('=== 검증 3) meta 키 목록 + 배열형 값 항목 수 ===');
  for (const row of data.meta) {
    let parsed;
    try { parsed = JSON.parse(row.value); } catch (e) { parsed = null; }
    if (Array.isArray(parsed)) {
      console.log(`  ${row.key}: 배열, ${parsed.length}개 항목`);
    } else if (parsed && typeof parsed === 'object') {
      console.log(`  ${row.key}: 객체, 키 ${Object.keys(parsed).length}개`);
    } else {
      console.log(`  ${row.key}: (파싱 불가 또는 원시값)`);
    }
  }
  console.log('');

  console.log('=== 검증 4) accounts 비밀번호 상태 (평문 인원수만 표시, 실제 값은 출력 안 함) ===');
  const accountsRow = data.meta.find((r) => r.key === 'accounts');
  if (accountsRow) {
    let accounts = [];
    try { accounts = JSON.parse(accountsRow.value); } catch (e) {}
    const hashed = accounts.filter((a) => a.pw && String(a.pw).startsWith('$2')).length;
    const plain = accounts.filter((a) => a.pw && !String(a.pw).startsWith('$2')).length;
    const empty = accounts.filter((a) => !a.pw).length;
    console.log(`  전체 계정 ${accounts.length}개 — 이미 해시됨: ${hashed}, 평문(이관 시 해시 변환 필요): ${plain}, 비밀번호 없음: ${empty}`);
  } else {
    console.log('  accounts 키가 meta에 없음');
  }

  console.log('\n=== 검증 5) 대량 테이블 행 수 요약 ===');
  console.log(`  att_data: ${data.att_data.length}행, slack_data: ${data.slack_data.length}행, hr_saved: ${data.hr_saved.length}행, sched_saved: ${data.sched_saved.length}행`);

  console.log('\n=== Phase A 완료 ===');
  const hasBlockingDup = empDups.size > 0 || conDups.size > 0;
  if (hasBlockingDup) {
    console.log('⚠️ 중복이 발견되어 Phase B(실제 이관)를 바로 진행하면 안 됩니다. 위 목록을 보고 어떤 행을 남길지 정해주세요.');
    process.exitCode = 2;
  } else {
    console.log('중복 없음 확인. Phase B(실제 이관)로 진행해도 안전합니다.');
  }
}

main().catch((err) => {
  console.error('Phase A 실패:', err.message);
  process.exitCode = 1;
});
