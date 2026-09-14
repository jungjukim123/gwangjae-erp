const crypto = require('crypto');

// ── IPv4 CIDR 매칭 (외부 패키지 없이 직접 구현) ──
function ipToLong(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function parseCidr(cidr) {
  const [range, bitsStr] = cidr.split('/');
  const base = ipToLong(range);
  const bits = bitsStr === undefined ? 32 : Number(bitsStr);
  if (base === null || Number.isNaN(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: base & mask, mask };
}

function ipInCidr(ip, cidr) {
  const long = ipToLong(ip);
  if (long === null) return false;
  const parsed = parseCidr(cidr);
  if (!parsed) return false;
  return (long & parsed.mask) === parsed.base;
}

function normalizeIp(ip) {
  if (!ip) return ip;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function getAllowedNetworks() {
  return (process.env.ALLOWED_NETWORKS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

// GAS(Google Apps Script)는 회사망 바깥(구글 클라우드)에서 서버-서버로 호출하므로
// requireAuthOrApiKey와 동일한 방식(Authorization: Bearer <GAS_API_KEY>)으로 IP 검사 예외를 둔다.
function isServiceCall(req) {
  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');
  const expected = process.env.GAS_API_KEY;
  return !!(expected && scheme === 'Bearer' && token && safeEqual(token, expected));
}

// req.headers만으로 클라이언트 IP를 뽑는다 (express req.ip와 동일하게 trust proxy 1단계만 신뢰:
// X-Forwarded-For의 첫 값을 클라이언트로 본다). HTTP 업그레이드(WebSocket) 요청처럼 express의
// req.ip를 못 쓰는 곳에서도 재사용하기 위해 별도 함수로 분리.
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return normalizeIp(String(xff).split(',')[0].trim());
  return normalizeIp(req.socket && req.socket.remoteAddress);
}

function isIpAllowed(ip, req) {
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (req && isServiceCall(req)) return true;
  const allowed = getAllowedNetworks();
  if (allowed.length === 0) return true; // 미설정 시 기존 동작 유지(막지 않음)
  return allowed.some((cidr) => ipInCidr(ip, cidr));
}

// 사내망(와이파이 포함) IP 대역 밖에서의 접속을 차단한다 — Supabase를 걷어낸 뒤로는
// 네트워크 레벨 접근 제어를 이 서버가 직접 담당해야 하기 때문 (ALLOWED_NETWORKS, .env 참고).
function ipAllowlist(req, res, next) {
  const ip = normalizeIp(req.ip);
  if (isIpAllowed(ip, req)) return next();
  return res.status(403).json({ error: 'forbidden: outside allowed network' });
}

module.exports = { ipAllowlist, isIpAllowed, getClientIp };
