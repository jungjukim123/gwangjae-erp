const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const pool = require('../db');
const { requireHr } = require('../middleware/requireAuth');
const { writeAuditLog } = require('../auditLog');

const router = express.Router();

// 4단계 계획(로그인 서버 전환) 대비 — 이번엔 백엔드만 구현. gwangjae_v222.html의 doLogin() 자체를
// 이 엔드포인트를 호출하도록 바꾸는 작업은 3단계 순서상 4번째 단계에서 별도로 진행한다.

// 로그인 무차별 대입 방지 — 2단계 계획서 2-5절
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.' },
});

// accounts는 지금과 동일하게 meta.value(JSONB) 안에 배열로 보관 — 데이터 구조 임의 변경 금지 원칙 준수.
// 다만 각 계정의 pw 필드는 이제 반드시 bcrypt 해시만 저장한다(평문 저장 금지).
async function getAccounts() {
  const { rows } = await pool.query(`SELECT value FROM meta WHERE key = 'accounts'`);
  if (!rows.length) return [];
  const list = rows[0].value;
  return Array.isArray(list) ? list : [];
}

function todayKst() {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 10);
}

// ── 계정 잠금(무차별 대입 방지, 보안규칙 13) — IP당 요청 제한(loginLimiter)과 별개로
//   "이 아이디"에 대한 연속 실패를 추적한다. 사번+휴대폰 뒷자리처럼 약한 조합을
//   자가 로그인으로 새로 허용하면서 반드시 같이 넣어야 하는 방어선.
const MAX_LOGIN_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

async function getLoginLock(id) {
  const { rows } = await pool.query('SELECT fail_count, locked_until FROM login_fails WHERE id = $1', [id]);
  return rows[0] || null;
}

async function registerLoginFailure(id) {
  const { rows } = await pool.query(
    `INSERT INTO login_fails (id, fail_count, updated_at) VALUES ($1, 1, now())
     ON CONFLICT (id) DO UPDATE SET fail_count = login_fails.fail_count + 1, updated_at = now()
     RETURNING fail_count`,
    [id]
  );
  if (rows[0].fail_count >= MAX_LOGIN_FAILS) {
    await pool.query('UPDATE login_fails SET locked_until = $2 WHERE id = $1', [id, new Date(Date.now() + LOGIN_LOCK_MS)]);
  }
}

async function clearLoginFailure(id) {
  await pool.query('DELETE FROM login_fails WHERE id = $1', [id]);
}

// ── MYPAGE 자가 로그인 — 계정관리(meta.accounts)에 없는 아이디는 계약기간관리(contracts)의
//   사번+휴대폰 뒷자리 4자리로 인증한다(계정 별도 생성 불필요). 동일 사번으로 계약이 여러 건
//   있으면 재직중(퇴사일 없음) 건을 우선하고, 없으면 가장 최근 계약(no 내림차순)을 쓴다.
//   employees 테이블엔 전화번호가 없어 contracts.phone만 본다.
async function findSelfServiceAccount(id, pw) {
  if (!/^\d{4}$/.test(pw)) return null;
  const { rows } = await pool.query(
    `SELECT "사번", "이름", "소속", "phone", "퇴사" FROM contracts
     WHERE "사번" = $1
     ORDER BY ("퇴사" IS NULL OR "퇴사" = '') DESC, "no" DESC`,
    [id]
  );
  if (!rows.length) return null;
  const con = rows[0];
  if (con.퇴사 && con.퇴사 < todayKst()) return null; // 퇴사 처리된 사번은 로그인 불가
  const digits = String(con.phone || '').replace(/\D/g, '');
  if (digits.length < 4 || digits.slice(-4) !== pw) return null;
  return { id: con.사번, name: con.이름, role: 'emp', info: con.소속 || '', av: (con.이름 || '?')[0] };
}

async function saveAccounts(list) {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  const updated = kst.toISOString().slice(0, 16).replace('T', ' '); // 'YYYY-MM-DD HH:MM' (기존 _kstNow와 동일 포맷)
  await pool.query(
    `INSERT INTO meta (key, value, updated) VALUES ('accounts', $1::jsonb, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated = EXCLUDED.updated, updated_at = now()`,
    [JSON.stringify(list), updated]
  );
}

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { id, pw } = req.body || {};
    if (!id || !pw) return res.status(400).json({ error: 'id/pw required' });

    const lock = await getLoginLock(id);
    if (lock && lock.locked_until && new Date(lock.locked_until) > new Date()) {
      return res.status(429).json({ error: '로그인 시도가 너무 많아 잠시 잠겼습니다. 15분 후 다시 시도하세요.' });
    }

    const accounts = await getAccounts();
    const acc = accounts.find((a) => a.id === id);
    let sessionUser = null;

    if (acc && acc.pw && (await bcrypt.compare(pw, acc.pw))) {
      sessionUser = {
        id: acc.id, name: acc.name, role: acc.role,
        info: acc.info || '', av: acc.av || '', menus: acc.menus || null,
      };
    } else if (!acc) {
      // 계정관리에 등록된 계정이 아니면 계약기간관리 사번+휴대폰 뒷자리 자가 로그인 시도
      sessionUser = await findSelfServiceAccount(id, pw);
    }

    if (!sessionUser) {
      await registerLoginFailure(id);
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }

    await clearLoginFailure(id);
    req.session.user = sessionUser;
    res.json({ user: req.session.user });
  } catch (err) { next(err); }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
  res.json({ user: req.session.user });
});

// 계정 목록 조회 — HR 권한 세션만 허용, pw(해시) 필드는 응답에서 항상 제외.
router.get('/accounts', requireHr, async (req, res, next) => {
  try {
    const accounts = await getAccounts();
    const safe = accounts.map(({ pw, ...rest }) => rest);
    res.json(safe);
  } catch (err) { next(err); }
});

// 계정 추가/수정 — HR 권한 세션만 허용. 평문 비밀번호는 여기서만 받고, 저장 전 반드시 해시.
router.post('/accounts', requireHr, async (req, res, next) => {
  try {
    const { id, pw, role, name, info, av, menus } = req.body || {};
    if (!id || !name) return res.status(400).json({ error: 'id/name required' });

    const accounts = await getAccounts();
    const idx = accounts.findIndex((a) => a.id === id);
    const isNew = idx < 0;
    if (isNew && (!pw || pw.length < 4)) {
      return res.status(400).json({ error: '비밀번호는 4자 이상이어야 합니다.' });
    }

    const hashedPw = pw ? await bcrypt.hash(pw, 12) : (isNew ? null : accounts[idx].pw);
    const nextAcc = { id, pw: hashedPw, role, name, info: info || '', av: av || name[0], menus: menus || null };
    if (isNew) accounts.push(nextAcc); else accounts[idx] = nextAcc;
    await saveAccounts(accounts);

    await writeAuditLog({
      actorId: req.session.user.id, actorName: req.session.user.name,
      action: isNew ? 'account_create' : 'account_update',
      targetType: 'account', targetId: id,
      detail: { role, menus }, ip: req.ip,
    });

    const { pw: _drop, ...safe } = nextAcc;
    res.json({ account: safe });
  } catch (err) { next(err); }
});

router.delete('/accounts/:id', requireHr, async (req, res, next) => {
  try {
    const accounts = await getAccounts();
    const target = accounts.find((a) => a.id === req.params.id);
    if (!target) return res.status(404).json({ error: 'not found' });
    if (target.id === 'jungjukim') return res.status(400).json({ error: '최고관리자는 삭제할 수 없습니다.' });

    const next = accounts.filter((a) => a.id !== req.params.id);
    await saveAccounts(next);

    await writeAuditLog({
      actorId: req.session.user.id, actorName: req.session.user.name,
      action: 'account_delete', targetType: 'account', targetId: req.params.id,
      ip: req.ip,
    });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
