// ============================================================
// 계약종료 예정자 월간 자동 발송 (Google Apps Script)
// ============================================================
// 매월 24일에, "다음 달"에 계약이 종료되는 인원 목록을 부산관제센터 - 입퇴사자관리
// Slack 채널로 자동 발송합니다(예: 8월 24일에 실행되면 9월 계약종료자를 안내).
//
// ★ 이 프로젝트 안 다른 스크립트와 이름이 겹치지 않도록, 모든 내부 로직을
//   ConEndMonthly 라는 이름 하나 아래에 몰아넣었습니다. 프로젝트 최상위에는
//   ConEndMonthly_로 시작하는 함수 4개만 노출되므로 다른 파일과 충돌하지 않습니다.
//
// ── 설치 방법 ──
// 1) 기존에 쓰고 계신 "근태연동 GAS" 프로젝트(SLK_POST_GAS_URL이 가리키는 그 프로젝트, 다른
//    gas_*.js 파일들과 동일한 프로젝트)를 엽니다.
// 2) 이 파일 전체를 새 스크립트 파일로 추가합니다 (파일 이름은 자유, 예: ConEndMonthly.gs)
// 3) Slack Bot Token은 이 파일에 하드코딩하지 않습니다(하드코딩하면 GitHub 푸시 보호에
//    걸립니다). 다른 스크립트(YeonchaWeekly, SomyungBtn 등)와 같은 스크립트 속성
//    (SLACK_BOT_TOKEN)을 그대로 공유해서 쓰므로, 그 스크립트들 중 하나라도 이미 설정해둔
//    적이 있다면 따로 등록할 필요는 없습니다 — 처음이라면 프로젝트 설정(⚙) → 스크립트 속성에
//    키: SLACK_BOT_TOKEN, 값: xoxb-로 시작하는 봇 토큰(③ 근태관리 화면과 동일)을 등록하세요.
// 4) 지금 바로 테스트해보고 싶으면 ConEndMonthly_sendTest 함수를 직접 실행해보세요.
//    → 실제 채널이 아니라 김정주님 개인 Slack DM(U03PLHYF126)으로만 보냅니다.
//    → 실제 데이터 기준 "다음 달" 계약종료자 목록으로 보내지므로, 채널로 나가는 것과
//      내용은 완전히 동일합니다(수신자만 다름).
// 5) 실제 채널 발송을 시작하려면 ConEndMonthly_setupTrigger 함수를 "한 번" 실행합니다.
//    - 최초 실행 시 Google 권한 승인 창이 뜨면 승인해주세요(외부 URL 호출 + 트리거 생성 권한).
//    - 이후 매월 24일 09:00에 자동 실행되어 실제 채널(C0BRRKFD43U)로 발송됩니다.
//
// ── 발송 대상 ──
// - 사번(없으면 이름) 그룹의 최신(계약시작일 기준) 계약이 구분≠퇴사이고, 아직 별도로
//   퇴사 처리(퇴사일 등록)되지 않았으며, 그 계약의 계약종료일(ce)이 "다음 달" 안에 속하는 인원.
// - 이 판정 로직은 관제센터 프로그램(gwangjae_v222.html)의 메인 대시보드 "계약종료 예정자"
//   (_dashContractsEndingInMonth)와 100% 동일하게 이식했습니다 — 그 화면에 뜨는 인원과
//   이 메시지에 뜨는 인원이 항상 일치해야 합니다. 프로그램 쪽 판정 로직이 바뀌면 이 스크립트도
//   함께 수정하세요.
// ============================================================

const ConEndMonthly = (function(){
  const SB_URL = 'https://dcvitbydqidndwbqqprm.supabase.co';
  const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRjdml0YnlkcWlkbmR3YnFxcHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyMDE1ODMsImV4cCI6MjA5Nzc3NzU4M30.xHDxj8-0jTTOrWTErOMPQB4EvyKhuOsgkPAjAB2txmc';
  const TRIGGER_FN = 'ConEndMonthly_send'; // 최상위 트리거 진입점(아래에서 export)
  const PROD_CHANNEL = 'C0BRRKFD43U'; // 부산관제센터 - 입퇴사자관리 채널
  const TEST_CHANNEL = 'U03PLHYF126'; // 테스트용 개인 DM(김정주)

  // 같은 GAS 프로젝트 안 다른 스크립트(YeonchaWeekly 등)와 스크립트 속성(SLACK_BOT_TOKEN)을
  // 그대로 공유해서 쓴다 — 이미 등록돼 있어야 하며, 이 파일에는 토큰을 하드코딩하지 않는다
  // (GitHub 푸시 보호에 걸림 — 토큰이 커밋에 그대로 남으면 원격 저장소로 올라갈 수 없다).
  function _getSlackToken(){
    const token = PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
    if(!token) throw new Error('스크립트 속성에 SLACK_BOT_TOKEN이 없습니다. 프로젝트 설정(⚙) → 스크립트 속성에서 등록해주세요(다른 gas_*.js와 동일한 값).');
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

  // ── 퇴사일 조회 (gas_연차현황_주간발송.js의 getQuitDate와 동일 로직) ──
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

  // ── 계약종료 예정자 목록 (gwangjae_v222.html의 _dashContractsEndingInMonth와 동일 로직) ──
  function contractsEndingInMonth(contracts, employees, ym){
    const groups = {};
    contracts.forEach(c=>{
      const k = c.사번 || ('__name__'+c.이름);
      if(!groups[k]) groups[k] = [];
      groups[k].push(c);
    });
    const result = [];
    Object.values(groups).forEach(g=>{
      g.sort((a,b)=>new Date(b.cs)-new Date(a.cs));
      const latest = g[0];
      if(!latest || !latest.ce || latest.구분==='퇴사') return;
      const quit = latest.사번 ? getQuitDate(latest.사번, employees, contracts) : '';
      if(quit && quit!=='') return;
      if(latest.ce.slice(0,7)===ym) result.push(latest);
    });
    result.sort((a,b)=>a.ce.localeCompare(b.ce));
    return result;
  }

  // "다음 달"(YYYY-MM) — 매월 24일에 실행되면 다음 달 종료자를 미리 안내하는 취지
  function nextYm(now){
    const y = now.getFullYear(), m = now.getMonth()+1; // m: 1~12(현재 달)
    const ty = m===12 ? y+1 : y;
    const tm = m===12 ? 1 : m+1;
    return ty + '-' + String(tm).padStart(2,'0');
  }

  function buildText(list){
    const dot = d => (d||'').replace(/-/g, '.');
    const lines = ['📅 [계약종료자 안내]'];
    list.forEach(c => lines.push('- ' + c.이름 + ' ~ ' + dot(c.ce)));
    return lines.join('\n');
  }

  function _postSlack(channel, text){
    const token = _getSlackToken();
    const res = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ channel: channel, text: text, mrkdwn: true }),
      muteHttpExceptions: true
    });
    const json = JSON.parse(res.getContentText());
    if(!json.ok) Logger.log('Slack 발송 실패 (' + channel + '): ' + json.error);
    return json.ok;
  }

  // ── 메인 실행: 매월 24일 트리거로 호출됨 → 실제 채널로 발송 ──
  function send(){
    const contracts = sbSelect('contracts');
    const employees = sbSelect('employees');
    const ym = nextYm(new Date());
    const list = contractsEndingInMonth(contracts, employees, ym);
    if(!list.length){
      Logger.log(ym + ' 계약종료자 없음 — 발송 생략');
      return;
    }
    const ok = _postSlack(PROD_CHANNEL, buildText(list));
    Logger.log(ym + ' 계약종료자 안내 발송 ' + (ok?'성공':'실패') + ' (' + list.length + '명)');
  }

  // ── 테스트 실행: 아무 때나 수동으로 돌려서 개인 DM으로만 확인 ──
  function sendTest(){
    const contracts = sbSelect('contracts');
    const employees = sbSelect('employees');
    const ym = nextYm(new Date());
    const list = contractsEndingInMonth(contracts, employees, ym);
    const text = '(테스트 발송)\n' + (list.length ? buildText(list) : '📅 [계약종료자 안내]\n(해당 없음)');
    const ok = _postSlack(TEST_CHANNEL, text);
    Logger.log('테스트 발송 ' + (ok?'성공':'실패') + ' → ' + TEST_CHANNEL);
  }

  // ── 트리거 등록: "한 번" 실행 ── 이미 등록된 동일 트리거가 있으면 지우고 새로 등록(중복 실행 방지)
  function setupTrigger(){
    ScriptApp.getProjectTriggers().forEach(t=>{
      if(t.getHandlerFunction()===TRIGGER_FN) ScriptApp.deleteTrigger(t);
    });
    ScriptApp.newTrigger(TRIGGER_FN)
      .timeBased()
      .onMonthDay(24)
      .atHour(9)
      .create();
    Logger.log('매월 24일 09시 트리거 등록 완료');
  }

  function removeTrigger(){
    ScriptApp.getProjectTriggers().forEach(t=>{
      if(t.getHandlerFunction()===TRIGGER_FN) ScriptApp.deleteTrigger(t);
    });
    Logger.log('트리거 삭제 완료');
  }

  return { send, sendTest, setupTrigger, removeTrigger };
})();

// ── 프로젝트 최상위(실행/트리거 드롭다운)에 노출되는 진입점 4개뿐입니다 ──
function ConEndMonthly_send(){ ConEndMonthly.send(); }
function ConEndMonthly_sendTest(){ ConEndMonthly.sendTest(); }
function ConEndMonthly_setupTrigger(){ ConEndMonthly.setupTrigger(); }
function ConEndMonthly_removeTrigger(){ ConEndMonthly.removeTrigger(); }
