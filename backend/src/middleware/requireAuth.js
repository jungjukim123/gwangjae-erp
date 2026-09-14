const crypto = require('crypto');

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'not logged in' });
  }
  next();
}

function requireHr(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'not logged in' });
  }
  if (req.session.user.role !== 'hr') {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

// 상수시간 비교 — 문자열 길이가 다르면 timingSafeEqual이 바로 던지므로 길이부터 맞춰준다.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// 브라우저(세션 쿠키) 또는 GAS 같은 서버-서버 호출(Authorization: Bearer <GAS_API_KEY>) 둘 다 허용.
// GAS_API_KEY가 .env에 설정 안 돼 있으면 API 키 경로는 항상 거부(로그인 세션만 유효).
function requireAuthOrApiKey(req, res, next) {
  if (req.session && req.session.user) return next();

  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');
  const expected = process.env.GAS_API_KEY;
  if (expected && scheme === 'Bearer' && token && safeEqual(token, expected)) {
    req.isServiceCall = true; // 감사로그 등에서 "누가"를 구분하고 싶을 때 참고용
    return next();
  }

  return res.status(401).json({ error: 'not logged in' });
}

// MYPAGE(구성원 자가서비스) 도입으로 emp/field 세션도 로그인 상태를 갖게 되면서,
// requireAuthOrApiKey(로그인만 하면 통과)를 제네릭 /api/:table에 그대로 두면 구성원 계정이
// employees/contracts(시급·전화번호)/meta(계정 목록의 bcrypt 해시 포함) 등 전 테이블을
// devtools로 직접 조회/수정할 수 있게 된다 — HR 세션 또는 GAS API 키만 통과시킨다.
function requireHrOrApiKey(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'hr') return next();

  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');
  const expected = process.env.GAS_API_KEY;
  if (expected && scheme === 'Bearer' && token && safeEqual(token, expected)) {
    req.isServiceCall = true;
    return next();
  }

  if (req.session && req.session.user) return res.status(403).json({ error: 'forbidden' });
  return res.status(401).json({ error: 'not logged in' });
}

module.exports = { requireAuth, requireHr, requireAuthOrApiKey, requireHrOrApiKey };
