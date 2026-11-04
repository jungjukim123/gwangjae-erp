const express = require('express');
const pool = require('../db');
const { TABLES } = require('../tableSchemas');
const { parseFilters } = require('../filters');
const { requireHrOrApiKey } = require('../middleware/requireAuth');
const realtimeBus = require('../realtimeBus');

const router = express.Router();

// JSONB 컬럼은 DB에는 객체로 저장하되, 클라이언트가 지금 하는 것처럼(JSON.parse(문자열))
// 그대로 동작하도록 응답에는 반드시 문자열로 다시 직렬화해서 내려준다.
// (2단계 계획서 "JSONB 이관 시 주의" 참고 — 여기서 안 지키면 클라이언트 파싱이 깨짐)
function serializeJsonColumns(row, jsonCols) {
  if (!jsonCols || !jsonCols.length) return row;
  const out = { ...row };
  jsonCols.forEach((c) => {
    if (out[c] !== null && out[c] !== undefined && typeof out[c] !== 'string') {
      out[c] = JSON.stringify(out[c]);
    }
  });
  return out;
}

// 반대로 POST로 들어오는 JSON 컬럼 값은 문자열(JSON.stringify된 것)로 올 수도 있고
// 이미 객체/배열로 올 수도 있어 둘 다 받되, pg 파라미터로는 항상 문자열로 넘긴다.
// ★ node-postgres는 JS 배열을 파라미터로 주면 Postgres 배열 리터럴("{...}")로 직렬화해버려서
//   JSON 배열이 필요한 jsonb 컬럼(days_json 등)에 넣으면 "invalid input syntax for type json"
//   에러가 난다(객체는 우연히 JSON.stringify돼서 문제 없었음). 그래서 여기서 미리 문자열로
//   만들어 넘기고, jsonb 컬럼으로의 캐스팅은 Postgres가 INSERT 대상 컬럼 타입을 보고 처리하게 한다.
function normalizeJsonInput(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function getSchemaOr404(req, res) {
  const table = req.params.table;
  const schema = TABLES[table];
  if (!schema) {
    res.status(404).json({ error: `unknown table: ${table}` });
    return null;
  }
  return { table, schema };
}

// GET /api/:table?col=eq.X&col2=like.Y*  → _sbSelect 대체
// limit/offset 없이 조건에 맞는 전체 행을 한 번에 반환한다 — 클라이언트가 하던
// 1000행 페이지네이션 루프를 서버가 대신 떠안는다(2단계 계획서 2-2절).
router.get('/:table', requireHrOrApiKey, async (req, res, next) => {
  try {
    const ctx = getSchemaOr404(req, res);
    if (!ctx) return;
    const { table, schema } = ctx;
    const { where, params } = parseFilters(req.query, schema.columns);
    const sql = `SELECT * FROM "${table}" ${where} ORDER BY "${schema.pk}"`;
    const result = await pool.query(sql, params);
    const rows = result.rows.map((r) => serializeJsonColumns(r, schema.json));
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/:table  body: 행 객체 또는 행 객체 배열 → _sbUpsert 대체
// INSERT ... ON CONFLICT(pk) DO UPDATE — Supabase의 Prefer: resolution=merge-duplicates와 동일 동작.
router.post('/:table', requireHrOrApiKey, async (req, res, next) => {
  try {
    const ctx = getSchemaOr404(req, res);
    if (!ctx) return;
    const { table, schema } = ctx;

    const rows = Array.isArray(req.body) ? req.body : [req.body];
    if (!rows.length) return res.json({ ok: true, count: 0 });

    const cols = schema.columns;
    const colList = cols.map((c) => `"${c}"`).join(',');
    const updateSet = cols
      .filter((c) => c !== schema.pk)
      .map((c) => `"${c}"=EXCLUDED."${c}"`)
      .concat('"updated_at"=now()')
      .join(', ');

    // ★ PostgreSQL은 쿼리 1개에 바인드 파라미터를 65535개까지만 받는다. 행 전체를 한 번의 INSERT로
    //   보내면(att_data는 행당 8개 → 약 8191행) 근태 데이터가 누적돼 한도를 넘는 순간 저장이 통째로
    //   실패하고, 화면엔 값이 남아 있다가 새로고침하면 서버 값으로 되돌아가 사라진다.
    //   그래서 한도 안에서 행을 나눠 하나의 트랜잭션으로 저장한다(일부만 반영되는 상태 방지).
    const chunkSize = Math.max(1, Math.floor(60000 / cols.length));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < rows.length; i += chunkSize) {
        const values = [];
        const rowPlaceholders = rows.slice(i, i + chunkSize).map((row) => {
          const ph = cols.map((c) => {
            let v = row[c];
            if (v === undefined) v = null;
            if (schema.json.includes(c)) v = normalizeJsonInput(v);
            values.push(v);
            return `$${values.length}`;
          });
          return `(${ph.join(',')})`;
        });
        const sql = `
      INSERT INTO "${table}" (${colList})
      VALUES ${rowPlaceholders.join(',')}
      ON CONFLICT ("${schema.pk}") DO UPDATE SET ${updateSet}
    `;
        await client.query(sql, values);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    realtimeBus.emit('change', table);
    res.json({ ok: true, count: rows.length });
  } catch (err) { next(err); }
});

// DELETE /api/:table?key=eq.X 또는 ?key=in.(a,b,c) 등 → 1단계에서 찾은 직접 fetch(DELETE) 10곳 대체
// 필터 없는 전체삭제는 사고 방지를 위해 항상 거부한다(기존 _sbReplace가 쓰던 key=neq.NONE 방식은
// 호출부가 없는 죽은 코드였으므로 지원하지 않음 — 1단계 분석 결과 참고).
router.delete('/:table', requireHrOrApiKey, async (req, res, next) => {
  try {
    const ctx = getSchemaOr404(req, res);
    if (!ctx) return;
    const { table, schema } = ctx;
    const { where, params, hasFilter } = parseFilters(req.query, schema.columns);
    if (!hasFilter) {
      return res.status(400).json({ error: 'DELETE requires at least one filter (eq/like/in)' });
    }
    const sql = `DELETE FROM "${table}" ${where}`;
    const result = await pool.query(sql, params);
    realtimeBus.emit('change', table);
    res.json({ ok: true, count: result.rowCount });
  } catch (err) { next(err); }
});

module.exports = router;
