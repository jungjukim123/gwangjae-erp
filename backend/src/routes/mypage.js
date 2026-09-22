const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/requireAuth');
const realtimeBus = require('../realtimeBus');

const router = express.Router();
router.use(requireAuth);

// MYPAGE(구성원 자가서비스) 전용 라우트 — 제네릭 /api/:table(HR 전용)와 달리, 로그인만
// 하면 role 무관하게 쓸 수 있다. 대신 서버가 항상 req.session.user.id를 "본인 사번"으로
// 강제해서 다른 사번의 데이터에는 애초에 접근할 수 없게 만든다(클라이언트가 emp_id를
// 보내도 전부 무시).

function kstNowDate() {
  return new Date(Date.now() + 9 * 3600 * 1000);
}
function kstDateStr() {
  return kstNowDate().toISOString().slice(0, 10);
}
function kstTimeStr() {
  const d = kstNowDate();
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function kstNowStr() {
  return kstNowDate().toISOString().slice(0, 16).replace('T', ' ');
}

// 시급/기본급/식대/직책수당/야간수당 등 임금 관련 컬럼은 MYPAGE 응답에서 항상 제외한다
// ("나의 근태현황"에 통상시급을 보여주지 않기로 한 결정 + 방어적 심층 대응).
const WAGE_COLS = ['시급', '기본', '식대', '직책', '야간'];
function stripWage(row) {
  if (!row) return row;
  const out = { ...row };
  WAGE_COLS.forEach((c) => { delete out[c]; });
  return out;
}

async function getOwnContracts(empId) {
  const { rows } = await pool.query(
    `SELECT * FROM contracts WHERE "사번" = $1 ORDER BY ("퇴사" IS NULL OR "퇴사" = '') DESC, "no" DESC`,
    [empId]
  );
  return rows;
}

async function getOwnEmployee(empId) {
  const { rows } = await pool.query(`SELECT * FROM employees WHERE "사번" = $1`, [empId]);
  return rows[0] || null;
}

async function getMonthConfirmed(yr, mo) {
  const { rows } = await pool.query(`SELECT value FROM meta WHERE key = 'confirmState'`);
  const state = rows[0] ? rows[0].value : {};
  return !!(state && state[`${yr}_${String(mo).padStart(2, '0')}`]);
}

router.get('/me', async (req, res, next) => {
  try {
    const empId = req.session.user.id;
    const cons = await getOwnContracts(empId);
    const emp = await getOwnEmployee(empId);
    res.json({
      user: req.session.user,
      employee: stripWage(emp),
      contracts: cons.map(stripWage),
    });
  } catch (err) { next(err); }
});

router.get('/attendance', async (req, res, next) => {
  try {
    const empId = req.session.user.id;
    const yr = parseInt(req.query.yr, 10);
    const mo = parseInt(req.query.mo, 10);
    if (!yr || !mo) return res.status(400).json({ error: 'yr/mo required' });
    const ymPrefix = `${yr}-${String(mo).padStart(2, '0')}`;

    const [emp, cons, attRows, slackRows, hrSavedRows, schedSavedRows] = await Promise.all([
      getOwnEmployee(empId),
      getOwnContracts(empId),
      pool.query(`SELECT * FROM att_data WHERE "emp_id" = $1 AND "date" LIKE $2`, [empId, `${ymPrefix}%`]),
      pool.query(`SELECT * FROM slack_data WHERE "emp_id" = $1 AND "date" LIKE $2`, [empId, `${ymPrefix}%`]),
      pool.query(`SELECT days_json FROM hr_saved WHERE "key" = $1`, [`${empId}_${yr}_${String(mo).padStart(2, '0')}`]),
      pool.query(`SELECT days_json FROM sched_saved WHERE "key" = $1`, [`${empId}_${yr}_${String(mo).padStart(2, '0')}`]),
    ]);
    const confirmed = await getMonthConfirmed(yr, mo);

    res.json({
      employee: stripWage(emp),
      contracts: cons.map(stripWage),
      attData: attRows.rows,
      slackData: slackRows.rows,
      daysJson: hrSavedRows.rows[0] ? hrSavedRows.rows[0].days_json : [],
      schedDays: schedSavedRows.rows[0] ? schedSavedRows.rows[0].days_json : [],
      confirmed,
    });
  } catch (err) { next(err); }
});

async function clockAction(req, res, next, field) {
  try {
    const empId = req.session.user.id;
    const ds = kstDateStr();
    const [yr, mo] = ds.split('-').map(Number);
    if (await getMonthConfirmed(yr, mo)) {
      return res.status(409).json({ error: '이미 확정된 근태월입니다. 관리자에게 문의하세요.' });
    }
    const key = `${empId}_${ds}`;
    const { rows } = await pool.query(`SELECT * FROM att_data WHERE "key" = $1`, [key]);
    const cur = rows[0] || { in: '', out: '' };
    const time = kstTimeStr();
    const nextIn = field === 'in' ? time : (cur.in || '');
    const nextOut = field === 'out' ? time : (cur.out || '');
    await pool.query(
      `INSERT INTO att_data ("key","emp_id","date","in","out","source","locked","updated")
       VALUES ($1,$2,$3,$4,$5,'mypage',true,$6)
       ON CONFLICT ("key") DO UPDATE SET "in"=$4, "out"=$5, "source"='mypage', "locked"=true,
         "updated"=$6, updated_at=now()`,
      [key, empId, ds, nextIn, nextOut, kstNowStr()]
    );
    realtimeBus.emit('change', 'att_data');
    res.json({ ok: true, date: ds, time, in: nextIn, out: nextOut });
  } catch (err) { next(err); }
}

router.post('/clock-in', (req, res, next) => clockAction(req, res, next, 'in'));
router.post('/clock-out', (req, res, next) => clockAction(req, res, next, 'out'));

// ── 근태소명요청서 — meta.somyungData(전체 직원 공용 JSON blob)에서 본인(eid=본인 사번) 항목만
//   읽고 쓴다. 관리자 화면(근태소명관리)이 참조하는 workerType/workerNote/workerIn/workerOut
//   필드만 채우고 status/memo/type은 건드리지 않는다(HR 전용 유지).
async function getSomyungData() {
  const { rows } = await pool.query(`SELECT value FROM meta WHERE key = 'somyungData'`);
  return rows[0] ? (rows[0].value || {}) : {};
}
async function saveSomyungData(data) {
  await pool.query(
    `INSERT INTO meta (key, value, updated) VALUES ('somyungData', $1::jsonb, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated = EXCLUDED.updated, updated_at = now()`,
    [JSON.stringify(data), kstNowStr()]
  );
}

router.get('/explanations', async (req, res, next) => {
  try {
    const empId = req.session.user.id;
    const yr = parseInt(req.query.yr, 10);
    const mo = parseInt(req.query.mo, 10);
    if (!yr || !mo) return res.status(400).json({ error: 'yr/mo required' });
    const ck = `${yr}_${String(mo).padStart(2, '0')}`;
    const data = await getSomyungData();
    const own = (data[ck] || []).filter((x) => x.eid === empId);
    res.json({ items: own });
  } catch (err) { next(err); }
});

router.post('/explanations', async (req, res, next) => {
  try {
    const empId = req.session.user.id;
    const { yr, mo, date, workerType, workerNote, workerIn, workerOut } = req.body || {};
    const y = parseInt(yr, 10), m = parseInt(mo, 10);
    if (!y || !m || !date) return res.status(400).json({ error: 'yr/mo/date required' });
    const ck = `${y}_${String(m).padStart(2, '0')}`;
    const emp = await getOwnEmployee(empId);
    const data = await getSomyungData();
    if (!data[ck]) data[ck] = [];
    let item = data[ck].find((x) => x.eid === empId && x.date === date);
    if (!item) {
      let autoType = '';
      if (workerIn && workerOut) autoType = '출근/퇴근 기록 없음';
      else if (workerIn) autoType = '출근 기록 없음';
      else if (workerOut) autoType = '퇴근 기록 없음';
      else if (workerType) autoType = workerType;
      if (!autoType) return res.status(400).json({ error: '소명사유 또는 출퇴근시간을 입력하세요.' });
      // ★ source: 'employee' — "새 신청서 작성"으로 구성원이 직접 만든 항목 표시(구분 헤더열용).
      //   관리자가 확인사항으로 먼저 지정한 항목은 이 분기를 타지 않으므로 source가 없다(=피플팀 요청).
      item = { eid: empId, name: (emp && emp.이름) || '', date, type: autoType, status: '대기중', memo: '', source: 'employee' };
      data[ck].push(item);
    }
    item.workerType = workerType || '';
    item.workerNote = workerNote || '';
    item.workerIn = workerIn || '';
    item.workerOut = workerOut || '';
    await saveSomyungData(data);
    res.json({ ok: true, item });
  } catch (err) { next(err); }
});

// ── 나의 연차현황 — hr_saved(전체 월 저장분)에서 본인 사번의 비고(연차/반차/반반차/결근/공가)와
//   meta.leaveUsage(수기입력/엑셀업로드분)를 모아서 반환한다. 발생·잔여 계산은 클라이언트가
//   기존 연차현황(hr12) 계산 함수(buildLeaveAccrualRows 등)를 그대로 재사용해서 처리한다.
router.get('/leave-status', async (req, res, next) => {
  try {
    const empId = req.session.user.id;
    const [emp, cons, hrSavedRows, leaveUsageRow] = await Promise.all([
      getOwnEmployee(empId),
      getOwnContracts(empId),
      pool.query(`SELECT yr, mo, days_json FROM hr_saved WHERE "emp_id" = $1`, [empId]),
      pool.query(`SELECT value FROM meta WHERE key = 'leaveUsage'`),
    ]);
    const leaveUsageAll = leaveUsageRow.rows[0] ? leaveUsageRow.rows[0].value : [];
    const leaveUsageOwn = (Array.isArray(leaveUsageAll) ? leaveUsageAll : []).filter((u) => u.사번 === empId);
    res.json({
      employee: stripWage(emp),
      contracts: cons.map(stripWage),
      hrSavedMonths: hrSavedRows.rows.map((r) => ({ yr: r.yr, mo: r.mo, days: r.days_json })),
      leaveUsage: leaveUsageOwn,
    });
  } catch (err) { next(err); }
});

// ── 연장/휴일근무요청서
router.get('/overtime-requests', async (req, res, next) => {
  try {
    const empId = req.session.user.id;
    const { rows } = await pool.query(
      `SELECT * FROM overtime_requests WHERE "emp_id" = $1 ORDER BY "work_date" DESC, id DESC`,
      [empId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/overtime-requests', async (req, res, next) => {
  try {
    const empId = req.session.user.id;
    const { work_date, req_type, start_time, end_time, hours, reason } = req.body || {};
    if (!work_date || !req_type) return res.status(400).json({ error: 'work_date/req_type required' });
    const emp = await getOwnEmployee(empId);
    const { rows } = await pool.query(
      `INSERT INTO overtime_requests
         ("emp_id","emp_name","work_date","req_type","start_time","end_time","hours","reason","status")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'대기중') RETURNING *`,
      [empId, (emp && emp.이름) || '', work_date, req_type, start_time || '', end_time || '', hours || null, reason || '']
    );
    realtimeBus.emit('change', 'overtime_requests');
    res.json({ ok: true, request: rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
