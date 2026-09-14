const { Pool } = require('pg');

// DB 접속정보는 전부 환경변수(.env)에서만 읽는다 — 코드에 절대 하드코딩하지 않는다
// (프로젝트 CLAUDE.md 보안규칙 9).
const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  max: Number(process.env.PG_POOL_MAX || 15),
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('[pg pool] unexpected idle client error', err);
});

module.exports = pool;
