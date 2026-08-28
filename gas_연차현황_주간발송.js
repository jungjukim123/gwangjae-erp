// ============================================================
// 연차현황 주간 자동 발송 (Google Apps Script)
// ============================================================
// 담당자가 관제센터 프로그램에 접속하지 않아도, 매주 정해진 시각에
// 자동으로 각 직원의 연차현황(발생·사용·잔여)을 Slack DM으로 발송합니다.
//
// ★ 이 프로젝트 안 다른 스크립트와 이름이 겹치지 않도록, 모든 내부 로직을
//   YeonchaWeekly 라는 이름 하나 아래에 몰아넣었습니다. 프로젝트 최상위에는
//   YeonchaWeekly_로 시작하는 함수 4개만 노출되므로 다른 파일과 충돌하지 않습니다.
//
// ── 설치 방법 ──
// 1) 기존에 쓰고 계신 "근태연동 GAS" 프로젝트(SLK_POST_GAS_URL이 가리키는 그 프로젝트)를 엽니다.
// 2) 이 파일 전체를 새 스크립트 파일로 추가합니다 (파일 이름은 자유, 예: LeaveSummary.gs)
// 3) Slack Bot Token을 등록합니다 — 아래 함수 목록에서 YeonchaWeekly_setSlackToken을 고른 뒤
//    괄호 안에 토큰을 채워 한 번 실행하거나, 프로젝트 설정(⚙) → 스크립트 속성에
//    키: SLACK_BOT_TOKEN, 값: xoxb-로 시작하는 봇 토큰(③ 근태관리 화면과 동일)을 직접 등록하세요.
// 4) YeonchaWeekly_setupTrigger 함수를 "한 번" 실행합니다.
//    - 최초 실행 시 Google 권한 승인 창이 뜨면 승인해주세요(외부 URL 호출 + 트리거 생성 권한).
//    - 이후 매주 월요일 09:00에 자동 실행되도록 등록됩니다.
// 5) 지금 바로 테스트해보고 싶으면 YeonchaWeekly_send 함수를 직접 실행해보세요.
//
// ── 발송 대상 ──
// - 계약기간관리에 SlackID(U로 시작)가 등록돼 있고, 아직 퇴사하지 않은 직원에게만 발송합니다.
// - 계산 로직은 관제센터 프로그램(gwangjae_v222.html)의 연차현황 계산과 100% 동일하게 이식했습니다.
//   ★ 주의: 프로그램 쪽 연차 계산 로직이 바뀌면(발생/사용/잔여 산정 규칙 등) 이 스크립트도 함께 수정해야
//   두 화면의 숫자가 계속 일치합니다.
// ============================================================

const YeonchaWeekly = (function(){
  const SB_URL = 'https://dcvitbydqidndwbqqprm.supabase.co';
  const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRjdml0YnlkcWlkbmR3YnFxcHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyMDE1ODMsImV4cCI6MjA5Nzc3NzU4M30.xHDxj8-0jTTOrWTErOMPQB4EvyKhuOsgkPAjAB2txmc';
  const DOW_KEYS = ['sun','mon','tue','wed','thu','fri','sat'];
  const TRIGGER_FN = 'YeonchaWeekly_send'; // 최상위 트리거 진입점(아래에서 export)
  function setSlackToken(token){
    PropertiesService.getScriptProperties().setProperty('SLACK_BOT_TOKEN', token);
  }
  function _getSlackToken(){
    const token = PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
    if(!token) throw new Error('스크립트 속성에 SLACK_BOT_TOKEN이 등록되어 있지 않습니다. YeonchaWeekly_setSlackToken 함수로 등록해주세요.');
    return token;
  }

  function sbSelect(table, params){
    const url = SB_URL + '/rest/v1/' + table + '?' + (params||'') + '&limit=5000';
    const res = UrlFetchApp.fetch(url, {
      headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY },
      muteHttpExceptions: true
    });
    return JSON.parse(res.getContentText());
  }

  // ── 날짜 유틸 (HTML의 dStr/dim/addDaysStr/addMonthsClamped/addYearsClamped 이식) ──
  function dim(y,m){ return new Date(y, m, 0).getDate(); }
  function dStr(y,m,d){ return y+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0'); }
  function addDaysStr(ds,n){
    const d = new Date(ds+'T00:00:00');
    d.setDate(d.getDate()+n);
    return dStr(d.getFullYear(), d.getMonth()+1, d.getDate());
  }
  function addMonthsClamped(ds,n){
    const p = ds.split('-').map(Number), y=p[0], m=p[1], d=p[2];
    const t = (m-1)+n;
    const ny = y + Math.floor(t/12);
    const nm = ((t%12)+12)%12 + 1;
    return dStr(ny, nm, Math.min(d, dim(ny,nm)));
  }
  function addYearsClamped(ds,n){ return addMonthsClamped(ds, n*12); }

  // ── 계약/직원 조회 헬퍼 (HTML의 동명 함수와 동일 로직) ──
  function getJoinDate(empId, employees, contracts){
    const cons = contracts.filter(c=>c.사번===empId && c.cs).sort((a,b)=>new Date(a.cs)-new Date(b.cs));
    const emp = employees.find(e=>e.사번===empId);
    const fromCon = cons[0] && (cons[0].입사 || cons[0].cs);
    return (emp && emp.입사) || fromCon || '';
  }
  function getQuitDate(empId, employees, contracts){
    const hasCon = contracts.some(c=>c.사번===empId);
    if(hasCon){
      const exitCon = contracts.filter(c=>c.사번===empId && c.구분==='퇴사' && c.퇴사)
        .sort((a,b)=>new Date(b.퇴사)-new Date(a.퇴사))[0];
      if(exitCon) return exitCon.퇴사;
      const latestCon = contracts.filter(c=>c.사번===empId && c.구분!=='퇴사')
        .sort((a,b)=>new Date(b.cs)-new Date(a.cs))[0];
      return (latestCon && latestCon.퇴사) || '';
    }
    const emp = employees.find(e=>e.사번===empId);
    return (emp && emp.퇴사) || '';
  }
  function getLatestConEnd(empId, contracts){
    const cons = contracts.filter(c=>c.사번===empId && c.구분!=='퇴사' && c.ce);
    if(!cons.length) return '';
    return cons.reduce((max,c)=>c.ce>max?c.ce:max, cons[0].ce);
  }
  function getWeekSojeong(empId, ds, contracts, employees){
    const m = contracts.filter(c=>c.사번===empId && c.구분!=='퇴사' && c.cs<=ds && c.ce>=ds)
      .sort((a,b)=>new Date(b.cs)-new Date(a.cs));
    if(m.length) return Number(m[0].소정) || 40;
    const e = employees.find(x=>x.사번===empId);
    return Number(e && e.소정) || 40;
  }
  function getSchedSojeong(empId, ds, contracts, employees){
    const dow = new Date(ds+'T00:00:00').getDay(), key = DOW_KEYS[dow];
    const m = contracts.filter(c=>c.사번===empId && c.구분!=='퇴사' && c.cs<=ds && c.ce>=ds)
      .sort((a,b)=>new Date(b.cs)-new Date(a.cs));
    if(!m.length){
      const e = employees.find(x=>x.사번===empId);
      if(e && e.cs<=ds && e.ce>=ds) return 8;
      return '계약기간 없음';
    }
    const h = m[0][key];
    if(h==='주휴') return '주휴';
    return Number(h) || 0;
  }
  function getConWorkDaysCount(empId, ds, contracts){
    const m = contracts.filter(c=>c.사번===empId && c.구분!=='퇴사' && c.cs<=ds && c.ce>=ds)
      .sort((a,b)=>new Date(b.cs)-new Date(a.cs));
    if(!m.length) return 5;
    const con = m[0];
    const cnt = DOW_KEYS.filter(k=>con[k]!=='주휴' && Number(con[k])>0).length;
    return cnt>0 ? cnt : 5;
  }
  function getLeaveSojeong(empId, ds, contracts, employees){
    const raw = getSchedSojeong(empId, ds, contracts, employees);
    const v = typeof raw==='number' ? raw : 0;
    if(v>0) return v;
    return Math.round((getWeekSojeong(empId, ds, contracts, employees) / getConWorkDaysCount(empId, ds, contracts)) * 100) / 100;
  }
  function getLeaveHourPerDay(empId, ds, contracts, employees){
    const wk = getWeekSojeong(empId, ds, contracts, employees);
    return Math.round((wk/40)*8*100)/100;
  }
  function getLeaveTypeFactor(gubun){
    if(gubun==='반차') return 0.5;
    if(gubun==='반반차') return 0.25;
    if(gubun==='결근' || gubun==='공가') return 0;
    return 1; // 연차
  }

  // ── 연차사용현황 통합 조회 (자동연동 + 수동/업로드) ──
  function getLeaveUsageRecords(empId, leaveUsageList, hrSavedDaysByEmp){
    const list = [];
    (hrSavedDaysByEmp[empId] || []).forEach(d=>{
      if(d.bigo==='연차' || d.bigo==='반차' || d.bigo==='결근') list.push({사번:empId, 구분:d.bigo, 사용일:d.date, source:'auto'});
      else if(d.bigo==='월차') list.push({사번:empId, 구분:'연차', 사용일:d.date, source:'auto'});
    });
    leaveUsageList.forEach(u=>{ if(u.사번===empId) list.push(Object.assign({}, u, {source:'manual'})); });
    const seen = {};
    return list.filter(u=>{
      const k = u.사번+'_'+u.사용일+'_'+u.구분;
      if(seen[k]) return u.source==='auto';
      seen[k] = true; return true;
    });
  }

  // ── 연차 발생 회차 계산 (HTML buildLeaveAccrualRows 이식) ──
  function buildLeaveAccrualRows(empId, contracts, employees, leaveUsageList, hrSavedDaysByEmp, today){
    const join = getJoinDate(empId, employees, contracts);
    if(!join) return [];
    const quit = getQuitDate(empId, employees, contracts);
    const latestConEnd = getLatestConEnd(empId, contracts);
    const asOf = (quit && quit<today) ? quit : ((latestConEnd && latestConEnd<today) ? latestConEnd : today);

    const absences = getLeaveUsageRecords(empId, leaveUsageList, hrSavedDaysByEmp)
      .filter(u=>u.구분==='결근').map(u=>u.사용일);

    // ★ 주 소정근로시간이 15시간 미만이면 연차가 발생하지 않음(근로기준법 제18조③) — 계약이 기간별로
    //   15시간 위/아래를 오갈 수 있으므로 1년미만연차는 매월 산정일(creditDate), 1년이상연차는 매 회차
    //   기산일(bStart) 시점의 계약 기준으로 그때그때 판정
    const rows = [];
    let 발생시간합 = 0;
    for(let n=1; n<=11; n++){
      const winStart = addMonthsClamped(join, n-1);
      if(winStart>asOf) break;
      const creditDate = addMonthsClamped(join, n);
      const winEnd = addDaysStr(creditDate, -1);
      const 결근일자 = absences.filter(d=>d>=winStart && d<=winEnd);
      const weekSojeong = getWeekSojeong(empId, creditDate, contracts, employees);
      if(creditDate<=asOf && weekSojeong>=15 && 결근일자.length===0){
        발생시간합 += getLeaveHourPerDay(empId, creditDate, contracts, employees);
      }
    }
    const bucket0CeFull = addDaysStr(addYearsClamped(join,1), -1);
    const bucket0Ce = asOf<bucket0CeFull ? asOf : bucket0CeFull;
    rows.push({구분:'1년미만연차', cs:join, ce:bucket0Ce, 발생: Math.round(발생시간합*100)/100});

    let n = 1;
    while(n<=60){
      const bStart = addYearsClamped(join, n);
      if(bStart>asOf) break;
      const bEnd = addDaysStr(addYearsClamped(join, n+1), -1);
      const under15 = getWeekSojeong(empId, bStart, contracts, employees) < 15;
      const days = under15 ? 0 : Math.min(15 + Math.floor((n-1)/2), 25);
      const hourPerDay = getLeaveHourPerDay(empId, bStart, contracts, employees);
      rows.push({구분:'1년이상연차', cs:bStart, ce:bEnd, 발생: under15 ? 0 : Math.round(days*hourPerDay*100)/100});
      n++;
    }
    return rows;
  }

  // ── 발생 회차에 사용 이력을 FIFO로 소진 (HTML allocateLeaveUsage 이식) ──
  function allocateLeaveUsage(rows, usageRecords, empId, contracts, employees){
    rows.forEach(r=>{ r.사용 = 0; });
    usageRecords.forEach(u=>{
      const factor = getLeaveTypeFactor(u.구분);
      if(factor<=0) return;
      let remain = Math.round(factor * getLeaveSojeong(empId, u.사용일, contracts, employees) * 100) / 100;
      let lastEligible = null;
      for(let i=0; i<rows.length; i++){
        const r = rows[i];
        if(u.사용일 < r.cs) continue;
        lastEligible = r;
        const avail = r.발생 - r.사용;
        if(avail<=0) continue;
        const take = Math.min(avail, remain);
        r.사용 += take; remain -= take;
        if(remain<=0) break;
      }
      if(remain>0 && lastEligible) lastEligible.사용 += remain;
    });
    rows.forEach(r=>{
      r.사용 = Math.round(r.사용*100)/100;
      r.잔여 = Math.round((r.발생 - r.사용)*100)/100;
    });
  }

  // ── Slack DM 발송 ──
  function _postSlackDM(slackId, text){
    const token = _getSlackToken();
    const res = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ channel: slackId, text: text, mrkdwn: true }),
      muteHttpExceptions: true
    });
    const json = JSON.parse(res.getContentText());
    if(!json.ok) Logger.log('Slack 발송 실패 (' + slackId + '): ' + json.error);
    return json.ok;
  }

  // ── 메인 실행 함수: 매주 트리거로 호출됨 ──
  function send(){
    const employees = sbSelect('employees');
    const contracts = sbSelect('contracts');

    const metaRows = sbSelect('meta', 'key=eq.leaveUsage');
    const leaveUsageList = (metaRows.length && metaRows[0].value) ? JSON.parse(metaRows[0].value) : [];

    const hrSavedRows = sbSelect('hr_saved');
    const hrSavedDaysByEmp = {};
    hrSavedRows.forEach(r=>{
      const days = JSON.parse(r.days_json || '[]');
      if(!hrSavedDaysByEmp[r.emp_id]) hrSavedDaysByEmp[r.emp_id] = [];
      hrSavedDaysByEmp[r.emp_id] = hrSavedDaysByEmp[r.emp_id].concat(days);
    });

    const now = new Date();
    const today = dStr(now.getFullYear(), now.getMonth()+1, now.getDate());
    const yyyymm = now.getFullYear() + '년 ' + String(now.getMonth()+1).padStart(2,'0') + '월';

    // 사번별 최신(퇴사 아닌) 계약 하나 — SlackID 조회용
    const latestConByEmp = {};
    contracts.forEach(c=>{
      if(!c.사번 || c.구분==='퇴사') return;
      const cur = latestConByEmp[c.사번];
      if(!cur || new Date(c.cs) > new Date(cur.cs)) latestConByEmp[c.사번] = c;
    });

    let sent = 0, skipped = 0;
    Object.keys(latestConByEmp).forEach(empId=>{
      const emp = employees.find(e=>e.사번===empId);
      if(!emp){ skipped++; return; }

      const quit = getQuitDate(empId, employees, contracts);
      if(quit && quit<today){ skipped++; return; } // 이미 퇴사한 직원은 제외

      const slackId = latestConByEmp[empId].slackId;
      if(!slackId){ skipped++; return; } // SlackID 미등록자는 제외

      const rows = buildLeaveAccrualRows(empId, contracts, employees, leaveUsageList, hrSavedDaysByEmp, today);
      if(!rows.length){ skipped++; return; }
      const usageRecords = getLeaveUsageRecords(empId, leaveUsageList, hrSavedDaysByEmp);
      allocateLeaveUsage(rows, usageRecords, empId, contracts, employees);

      const 총발생 = Math.round(rows.reduce((a,r)=>a+r.발생, 0) * 100) / 100;
      const 총사용 = Math.round(rows.reduce((a,r)=>a+r.사용, 0) * 100) / 100;
      const 총잔여 = Math.round((총발생 - 총사용) * 100) / 100;

      const text = '📌 *[연차현황 안내]* ' + yyyymm + '\n' +
        '안녕하세요, 피플팀입니다.\n\n' +
        '👤 *' + emp.이름 + '*\n' +
        '• 발생: ' + 총발생 + '시간\n' +
        '• 사용: ' + 총사용 + '시간\n' +
        '• 잔여: ' + 총잔여 + '시간\n\n' +
        '※ 자세한 내역은 관제센터 프로그램 > 연차현황에서 확인하실 수 있습니다.';

      if(_postSlackDM(slackId, text)) sent++; else skipped++;
      Utilities.sleep(350); // Slack API 연속 호출 완충
    });

    Logger.log('연차현황 주간 발송 완료 — 발송 ' + sent + '건, 스킵 ' + skipped + '건');
  }

  // ── 트리거 등록: "한 번" 실행 ── 이미 등록된 동일 트리거가 있으면 지우고 새로 등록(중복 실행 방지)
  function setupTrigger(){
    ScriptApp.getProjectTriggers().forEach(t=>{
      if(t.getHandlerFunction()===TRIGGER_FN) ScriptApp.deleteTrigger(t);
    });
    ScriptApp.newTrigger(TRIGGER_FN)
      .timeBased()
      .onWeekDay(ScriptApp.WeekDay.MONDAY)
      .atHour(9)
      .create();
    Logger.log('매주 월요일 09시 트리거 등록 완료');
  }

  function removeTrigger(){
    ScriptApp.getProjectTriggers().forEach(t=>{
      if(t.getHandlerFunction()===TRIGGER_FN) ScriptApp.deleteTrigger(t);
    });
    Logger.log('트리거 삭제 완료');
  }

  return { setSlackToken, send, setupTrigger, removeTrigger };
})();

// ── 프로젝트 최상위(실행/트리거 드롭다운)에 노출되는 진입점 4개뿐입니다 ──
function YeonchaWeekly_setSlackToken(token){ YeonchaWeekly.setSlackToken(token); }
function YeonchaWeekly_send(){ YeonchaWeekly.send(); }
function YeonchaWeekly_setupTrigger(){ YeonchaWeekly.setupTrigger(); }
function YeonchaWeekly_removeTrigger(){ YeonchaWeekly.removeTrigger(); }
