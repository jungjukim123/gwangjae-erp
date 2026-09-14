const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { writeAuditLog } = require('../auditLog');

const router = express.Router();

// 계정 추가/삭제는 auth.js가 서버 로직 안에서 직접 기록하지만, 급여확정/해제·계약삭제·
// 근태확정/해제는 gwangjae_v222.html의 클라이언트 함수(doSalConfirm/doSalRelease/deleteCon/
// doConfirm/doRelease)가 실제 트리거이므로 이 범용 엔드포인트를 호출하는 방식으로 남겨둔다.
// 3단계 진행 순서상 이 호출을 실제로 추가하는 건 5번째 단계(확정/스냅샷 검증)에서 진행.
const ALLOWED_ACTIONS = new Set([
  'salary_confirm', 'salary_release',
  'contract_delete',
  'attendance_confirm', 'attendance_release',
]);

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { action, targetType, targetId, detail } = req.body || {};
    if (!ALLOWED_ACTIONS.has(action)) {
      return res.status(400).json({ error: `unsupported action: ${action}` });
    }
    await writeAuditLog({
      actorId: req.session.user.id,
      actorName: req.session.user.name,
      action, targetType, targetId, detail,
      ip: req.ip,
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
