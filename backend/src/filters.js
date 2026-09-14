// PostgREST 스타일 필터 문법 파서.
// 지원 문법: ?col=eq.값 | ?col=like.패턴(*는 SQL %로 변환) | ?col=in.(a,b,c)
//          | ?col=gte.값 | ?col=lte.값 | ?col=gt.값 | ?col=lt.값
// (gte/lte/gt/lt는 GAS 스크립트의 날짜 범위 조회(예: date=gte.X&date=lte.Y)를 지원하기 위해 추가됨)
// allowedColumns에 없는 파라미터는 조용히 무시한다(오타/조작된 파라미터가 조건절에 섞여
// 들어가는 것을 막기 위함 — 화이트리스트 밖 컬럼으로 필터링하고 싶으면 tableSchemas.js에 추가할 것).
//
// ★ 같은 컬럼에 조건을 두 번 걸면(예: date=gte.X&date=lte.Y) Express(qs)가 값을 배열로 묶어서 준다
//   (req.query.date === ['gte.X','lte.Y']). 문자열 하나만 가정하면 이 경우 전체가 조용히 씹히므로
//   배열/문자열 둘 다 처리한다.
function parseOneCondition(col, rawVal, params, clauses) {
  if (typeof rawVal !== 'string') return;
  const m = rawVal.match(/^(eq|like|in|gte|lte|gt|lt)\.(.*)$/s);
  if (!m) return;
  const [, op, val] = m;

  if (op === 'eq') {
    params.push(val);
    clauses.push(`"${col}" = $${params.length}`);
  } else if (op === 'like') {
    params.push(val.replace(/\*/g, '%'));
    clauses.push(`"${col}" LIKE $${params.length}`);
  } else if (op === 'in') {
    const inner = val.replace(/^\(/, '').replace(/\)$/, '');
    const list = inner.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    if (!list.length) return;
    const placeholders = list.map((v) => { params.push(v); return `$${params.length}`; });
    clauses.push(`"${col}" IN (${placeholders.join(',')})`);
  } else if (op === 'gte') {
    params.push(val); clauses.push(`"${col}" >= $${params.length}`);
  } else if (op === 'lte') {
    params.push(val); clauses.push(`"${col}" <= $${params.length}`);
  } else if (op === 'gt') {
    params.push(val); clauses.push(`"${col}" > $${params.length}`);
  } else if (op === 'lt') {
    params.push(val); clauses.push(`"${col}" < $${params.length}`);
  }
}

function parseFilters(query, allowedColumns) {
  const clauses = [];
  const params = [];

  for (const [col, rawVal] of Object.entries(query || {})) {
    if (!allowedColumns.includes(col)) continue;
    if (Array.isArray(rawVal)) {
      rawVal.forEach((v) => parseOneCondition(col, v, params, clauses));
    } else {
      parseOneCondition(col, rawVal, params, clauses);
    }
  }

  return {
    where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
    hasFilter: clauses.length > 0,
  };
}

module.exports = { parseFilters };
