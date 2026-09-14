require('dotenv').config();

const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const PgSessionFactory = require('connect-pg-simple');

const pool = require('./db');
const tableRoutes = require('./routes/tables');
const authRoutes = require('./routes/auth');
const auditLogRoutes = require('./routes/auditLog');
const { attachRealtime } = require('./realtime');
const { ipAllowlist } = require('./middleware/ipAllowlist');

const app = express();
app.set('trust proxy', 1); // 사내 리버스프록시 뒤에서도 req.ip가 실제 클라이언트 IP를 가리키도록

// ── 사내망 IP 대역 밖에서의 접속을 차단 (집 등 외부에서는 화면 자체가 안 뜨게) ──
// ALLOWED_NETWORKS(.env)가 비어있으면 기존처럼 막지 않는다. GAS 서버-서버 호출(GAS_API_KEY)은 예외.
app.use(ipAllowlist);

// ── CORS: ERP가 실제 서비스되는 도메인만 허용 (2단계 계획서 2-4절) ──
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    // origin이 없는 요청(서버-서버, curl 등)은 통과 — 브라우저 fetch는 항상 origin을 보냄
    // 허용 안 된 origin은 에러를 던지지 않고 false만 반환 — cors 미들웨어가 CORS 헤더를 안 붙여서
    // 브라우저가 알아서 응답을 차단하게 한다(500으로 응답하면 서버 오류처럼 보여서 부적절함).
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(null, false);
  },
  credentials: true, // 세션 쿠키 전송 허용
}));

app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '20mb' }));

// ── 세션 (httpOnly 쿠키 + Postgres 저장소) — 2단계 계획서 2-3절 ──
// sessionMiddleware를 변수로 빼둔 이유: 아래 WebSocket 업그레이드 처리(realtime.js)에서
// 동일한 세션 검증 로직을 재사용해야 하기 때문 (express는 HTTP 요청에만 자동 적용, WS
// 업그레이드 요청에는 직접 한 번 더 실행해줘야 함).
const PgSession = PgSessionFactory(session);
const sessionMiddleware = session({
  store: new PgSession({ pool, tableName: 'session', createTableIfMissing: false }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === 'true',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 12, // 12시간
  },
});
app.use(sessionMiddleware);

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ── ERP 정적 파일 서빙: 저장소 루트에 있는 gwangjae_v222.html 딱 이 파일만 노출한다.
// (다른 프로젝트/스크립트와 같은 팀 컴퓨터에 배포돼도 이 서버는 이 파일 외엔 아무것도
// 서빙하지 않음 — 폴더 전체를 열어주는 express.static을 쓰지 않은 이유)
const ERP_HTML_PATH = path.join(__dirname, '..', '..', 'gwangjae_v222.html');
app.get(['/', '/gwangjae_v222.html'], (req, res) => res.sendFile(ERP_HTML_PATH));

app.use('/api/auth', authRoutes);
app.use('/api/audit-log', auditLogRoutes);
app.use('/api', tableRoutes);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'internal server error' });
});

const PORT = process.env.PORT || 4000;
const server = http.createServer(app);
attachRealtime(server, sessionMiddleware);
server.listen(PORT, () => {
  console.log(`hr_cx_manage API listening on :${PORT} (db=${process.env.PGDATABASE}), WebSocket on /ws`);
});
