function doGet(e) {
  // ★ "나의 근태현황" 읽기전용 웹페이지 (사번+휴대폰 뒷자리 로그인, gas_근태소명_슬랙버튼.js)
  if (e.parameter.action === 'my_att') {
    return SomyungBtn.handleMyAttGet(e);
  }

  // ★ "나의 근태현황" JSON API (별도 정적 페이지에서 JSONP로 호출, gas_근태소명_슬랙버튼.js)
  if (e.parameter.action === 'my_att_api') {
    return SomyungBtn.handleMyAttApi(e);
  }

  // ★ 소명 Slack 발송 분기
  if (e.parameter.action === 'slack_post') {
    const token   = e.parameter.token;
    const channel = e.parameter.channel;
    const text    = decodeURIComponent(e.parameter.text);
    const payload = { channel, text, mrkdwn: true };
    if (e.parameter.blocks) payload.blocks = JSON.parse(decodeURIComponent(e.parameter.blocks));
    const res = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify(payload)
    });
    const cb = e.parameter.callback;
    return ContentService
      .createTextOutput(cb + '(' + res.getContentText() + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  // 기존: 근태 데이터 조회
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const data = sheet.getDataRange().getValues();
  const rows = data.slice(1);

  const p = n => String(n).padStart(2,'0');

  const result = rows
    .filter(row => row[0] && row[1] && row[2])
    .map(row => {
      const raw = String(row[2]);
      const match = raw.match(/(\w+) (\d+), (\d+), (\d+):(\d+):(\d+) (AM|PM)/);

      let hours = parseInt(match[4]);
      const minutes = parseInt(match[5]);
      const ampm = match[7];
      const year = parseInt(match[3]);
      const day = parseInt(match[2]);
      const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const month = monthNames.indexOf(match[1]);

      if (ampm === 'PM' && hours !== 12) hours += 12;
      if (ampm === 'AM' && hours === 12) hours = 0;

      const utc = new Date(Date.UTC(year, month, day, hours, minutes));
      const kst = new Date(utc.getTime() + 9 * 60 * 60 * 1000);

      return {
        이름: String(row[0]).replace(/^@/, '').trim(),
        구분: String(row[1]).trim(),
        날짜: `${kst.getUTCFullYear()}-${p(kst.getUTCMonth()+1)}-${p(kst.getUTCDate())}`,
        시간: `${p(kst.getUTCHours())}:${p(kst.getUTCMinutes())}`
      };
    });

  const callback = e.parameter.callback;
  const json = JSON.stringify({ data: result });

  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Supabase 설정
const SB_URL = 'https://dcvitbydqidndwbqqprm.supabase.co'
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRjdml0YnlkcWlkbmR3YnFxcHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyMDE1ODMsImV4cCI6MjA5Nzc3NzU4M30.xHDxj8-0jTTOrWTErOMPQB4EvyKhuOsgkPAjAB2txmc'

// ── 이름 정규화 (ERP와 동일)
function cleanName(v) {
  return String(v || '').replace(/^@/, '').replace(/\([^)]*\)/g, '').replace(/\s/g, '').trim()
}

// ── Supabase에서 사번 조회 (재직중 우선 매칭)
function getEmpId(name) {
  const res = UrlFetchApp.fetch(`${SB_URL}/rest/v1/employees?select=사번,이름,퇴사`, {
    headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY }
  })
  const emps = JSON.parse(res.getContentText())
  const target = cleanName(name)

  const matched = emps.filter(e => {
    const en = cleanName(e['이름'])
    if (en === target) return true
    const minLen = Math.min(en.length, target.length)
    if (minLen >= 3 && (en.includes(target) || target.includes(en))) return true
    return false
  })

  if (!matched.length) return null

  const active = matched.find(e => !e['퇴사'] || e['퇴사'] === '')
  return active ? active['사번'] : matched[0]['사번']
}

// ── Supabase slack_data에 저장
function upsertSlack(empId, dateStr, field, timeStr) {
  const key = `${empId}_${dateStr}`
  const now = new Date()
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  const p = n => String(n).padStart(2,'0')
  const updated = `${kst.getUTCFullYear()}-${p(kst.getUTCMonth()+1)}-${p(kst.getUTCDate())} ${p(kst.getUTCHours())}:${p(kst.getUTCMinutes())}`

  const check = UrlFetchApp.fetch(
    `${SB_URL}/rest/v1/slack_data?key=eq.${encodeURIComponent(key)}&select=in,out`, {
    headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY }
  })
  const existing = JSON.parse(check.getContentText())
  if (existing.length > 0 && existing[0][field]) {
    Logger.log(`스킵: ${key} / ${field} 이미 존재`)
    return
  }

  UrlFetchApp.fetch(`${SB_URL}/rest/v1/slack_data`, {
    method: 'POST',
    headers: {
      'apikey':        SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=merge-duplicates'
    },
    payload: JSON.stringify({ key, emp_id: empId, date: dateStr, [field]: timeStr, updated })
  })
  Logger.log(`저장: ${empId} / ${dateStr} / ${field}:${timeStr}`)
}

// ── 시트에 새 행 생길 때 자동 실행 (트리거로 등록)
function onNewRow() {
  const sheet   = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0]
  const lastRow = sheet.getLastRow()
  if (lastRow < 2) return

  const row = sheet.getRange(lastRow, 1, 1, 3).getValues()[0]
  const 이름원본 = String(row[0] || '').trim()
  const 구분    = String(row[1] || '').trim()
  const raw     = String(row[2] || '').trim()

  if (!이름원본 || !구분 || !raw) return

  const match = raw.match(/(\w+) (\d+), (\d+), (\d+):(\d+):(\d+) (AM|PM)/)
  if (!match) return

  const p = n => String(n).padStart(2,'0')
  let hours = parseInt(match[4])
  const minutes   = parseInt(match[5])
  const ampm      = match[7]
  const year      = parseInt(match[3])
  const day       = parseInt(match[2])
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  const month     = monthNames.indexOf(match[1])

  if (ampm === 'PM' && hours !== 12) hours += 12
  if (ampm === 'AM' && hours === 12) hours = 0

  const utc     = new Date(Date.UTC(year, month, day, hours, minutes))
  const kst     = new Date(utc.getTime() + 9 * 60 * 60 * 1000)
  const field   = 구분 === '출근' ? 'in' : 'out'
  // 자정 넘김 보정: 퇴근시간이 00시대면 전날 퇴근으로 날짜를 되돌리고 시간은 00:00 고정
  // (gwangjae_v222.html의 syncSlack()/로드 시 보정과 동일 규칙 — 이 보정이 없으면 야간근무자의
  //  자정 넘김 퇴근이 다음날 근태로 잘못 붙어 급여계산이 틀어짐)
  const isMidnightOut = field === 'out' && kst.getUTCHours() === 0
  if (isMidnightOut) kst.setUTCDate(kst.getUTCDate() - 1)
  const dateStr = `${kst.getUTCFullYear()}-${p(kst.getUTCMonth()+1)}-${p(kst.getUTCDate())}`
  const timeStr = isMidnightOut ? '00:00' : `${p(kst.getUTCHours())}:${p(kst.getUTCMinutes())}`
  const empId   = getEmpId(이름원본)

  if (!empId) {
    Logger.log(`직원 매칭 실패: ${이름원본}`)
    return
  }

  upsertSlack(empId, dateStr, field, timeStr)
}

function checkWrongData() {
  const res1 = UrlFetchApp.fetch(
    `${SB_URL}/rest/v1/slack_data?emp_id=eq.B2501012&select=key,date,in,out`, {
    headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY }
  })
  const wrong = JSON.parse(res1.getContentText())
  Logger.log(`변정인 잘못된 데이터(B2501012): ${wrong.length}건`)

  const res2 = UrlFetchApp.fetch(
    `${SB_URL}/rest/v1/slack_data?emp_id=eq.B2600302&select=key,date,in,out`, {
    headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY }
  })
  const hyunji = JSON.parse(res2.getContentText())
  Logger.log(`이현지(B2600302): ${hyunji.length}건`)
}

function fixHyunji() {
  const res = UrlFetchApp.fetch(
    `${SB_URL}/rest/v1/slack_data?emp_id=eq.B2501202&select=key,date,in,out,updated`, {
    headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY }
  })
  const rows = JSON.parse(res.getContentText())
  Logger.log(`이현지 잘못된 데이터(B2501202): ${rows.length}건`)

  if (rows.length === 0) {
    Logger.log('이전할 데이터 없음 — B2600302에 이미 정상 저장됨')
    return
  }

  rows.forEach(r => {
    const newKey = `B2600302_${r.date}`
    UrlFetchApp.fetch(`${SB_URL}/rest/v1/slack_data`, {
      method: 'POST',
      headers: {
        'apikey': SB_KEY,
        'Authorization': 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      payload: JSON.stringify({
        key: newKey,
        emp_id: 'B2600302',
        date: r.date,
        in: r.in || '',
        out: r.out || '',
        updated: r.updated || ''
      })
    })
    Logger.log(`이전완료: ${r.date} / in:${r.in} / out:${r.out}`)
  })

  UrlFetchApp.fetch(
    `${SB_URL}/rest/v1/slack_data?emp_id=eq.B2501202`, {
    method: 'DELETE',
    headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY }
  })
  Logger.log('B2501202 잘못된 데이터 삭제 완료')
}

function rebuildAllSlackData() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0]
  const data  = sheet.getDataRange().getValues()
  const rows  = data.slice(1)
  const p = n => String(n).padStart(2,'0')

  let ok = 0, skip = 0, fail = 0

  rows.forEach((row, i) => {
    if (!row[0] || !row[1] || !row[2]) return
    const 이름원본 = String(row[0]).trim()
    const 구분    = String(row[1]).trim()
    const raw     = String(row[2]).trim()

    const match = raw.match(/(\w+) (\d+), (\d+), (\d+):(\d+):(\d+) (AM|PM)/)
    if (!match) return

    let hours = parseInt(match[4])
    const minutes   = parseInt(match[5])
    const ampm      = match[7]
    const year      = parseInt(match[3])
    const day       = parseInt(match[2])
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    const month     = monthNames.indexOf(match[1])

    if (ampm === 'PM' && hours !== 12) hours += 12
    if (ampm === 'AM' && hours === 12) hours = 0

    const utc     = new Date(Date.UTC(year, month, day, hours, minutes))
    const kst     = new Date(utc.getTime() + 9 * 60 * 60 * 1000)
    const field   = 구분 === '출근' ? 'in' : 'out'
    // 자정 넘김 보정: onNewRow()와 동일 규칙 (퇴근시간이 00시대면 전날 퇴근 + 00:00 고정)
    const isMidnightOut = field === 'out' && kst.getUTCHours() === 0
    if (isMidnightOut) kst.setUTCDate(kst.getUTCDate() - 1)
    const dateStr = `${kst.getUTCFullYear()}-${p(kst.getUTCMonth()+1)}-${p(kst.getUTCDate())}`
    const timeStr = isMidnightOut ? '00:00' : `${p(kst.getUTCHours())}:${p(kst.getUTCMinutes())}`
    const empId   = getEmpId(이름원본)

    if (!empId) { fail++; return }

    const key = `${empId}_${dateStr}`
    try {
      UrlFetchApp.fetch(`${SB_URL}/rest/v1/slack_data`, {
        method: 'POST',
        headers: {
          'apikey': SB_KEY,
          'Authorization': 'Bearer ' + SB_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        payload: JSON.stringify({ key, emp_id: empId, date: dateStr, [field]: timeStr, updated: dateStr })
      })
      ok++
    } catch(e) {
      fail++
    }
  })

  Logger.log(`완료 — 저장:${ok}건 / 실패:${fail}건`)
}
