const pool = require('./db');

// 2단계 계획서 2-6절: 급여확정/해제, 계정 추가/삭제/권한변경, 계약삭제, 근태확정/해제
// 최소 5개 액션을 "누가 언제 무엇을" 기록. action 문자열은 이 5개 액션명으로 통일해서 쓸 것.
async function writeAuditLog({ actorId, actorName, action, targetType, targetId, detail, ip }) {
  await pool.query(
    `INSERT INTO audit_log (actor_id, actor_name, action, target_type, target_id, detail, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [actorId || null, actorName || null, action, targetType || null, targetId || null,
      detail ? JSON.stringify(detail) : null, ip || null]
  );
}

module.exports = { writeAuditLog };
