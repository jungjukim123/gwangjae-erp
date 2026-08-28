// ============================================================
// 근태소명 안내 DM의 "내 근태현황 보기 / 잔여연차 확인" 버튼 처리 (Google Apps Script)
// ============================================================
// 근태소명관리에서 직원 개인에게 발송하는 슬랙 DM 하단에 버튼 2개가 붙습니다
// (gwangjae_v222.html의 _somyungActionBlocks 참고).
//   ① 잔여연차 확인 → 버튼 클릭(doPost) → 슬랙 DM으로 발생/사용/잔여(시간) 안내
//   ② 내 근태현황 보기 → url 버튼 → "나의 근태현황" 읽기전용 웹페이지로 바로 이동
//      (사번 + 휴대폰 뒷자리 4자리로 본인인증, 관리자 메뉴 없음, 수정 불가, 새로고침 시 항상 최신 반영)
//
// ★ 이 프로젝트 안 다른 스크립트와 이름이 겹치지 않도록, 모든 내부 로직을
//   SomyungBtn 이라는 이름 하나 아래에 몰아넣었습니다.
//
// ── 설치 방법 ──
// 1) 기존 "근태연동 GAS" 프로젝트(gwangjae_v222.html의 SLK_POST_GAS_URL이 가리키는 그 프로젝트,
//    YeonchaWeekly.gs를 추가했던 것과 동일한 프로젝트)를 엽니다.
// 2) 이 파일 전체를 새 스크립트 파일로 추가합니다 (파일 이름 자유, 예: SomyungBtn.gs)
// 3) ★★ 이 프로젝트에 이미 최상위 doPost(e) 함수가 있다면 그대로 두면 안 되고(중복 정의 시 오류),
//    기존 doPost 안에서 SomyungBtn.handlePost(e)를 호출하도록 병합해주세요.
//    없다면 이 파일 맨 아래 doPost(e)를 그대로 두면 됩니다.
// 4) 기존 doGet(e)의 slack_post 분기를 blocks 파라미터도 지원하도록 수정해야 합니다.
//    gwangjae_v222.html의 _sendSlackMsg 함수 바로 위 주석(doGet 수정 안내)을 참고해 반영해주세요.
// 5) ★★ 기존 doGet(e) 맨 앞에 "나의 근태현황" 페이지 분기도 추가해야 합니다.
//    이 파일 맨 아래 주석(doGet 수정 안내 2)을 참고해 반영해주세요.
// 6) Slack 앱 설정(https://api.slack.com/apps → 해당 앱 선택)
//    → Interactivity & Shortcuts 켜기 → Request URL에 "배포된 웹 앱 URL"
//    (SLK_POST_GAS_URL과 동일한 exec 주소)을 입력 후 저장
//    ※ 코드를 바꿨다면 배포 → 배포관리 → 수정 → 새 버전으로 재배포해야 반영됩니다.
// 7) 프로젝트 속성에 SLACK_BOT_TOKEN이 이미 등록되어 있어야 합니다(기존 근태소명 발송과 동일 토큰).
// 8) "나의 근태현황" 페이지 로그인은 계약기간관리에 등록된 휴대폰 번호(contracts.phone)의
//    뒷자리 4자리를 사용합니다. 등록이 안 된 직원은 로그인할 수 없습니다.
//
// ── 주의 (알려진 제약) ──
// Google Apps Script Web App은 doPost(e)에서 요청 헤더를 읽을 수 없어 Slack의
// X-Slack-Signature 서명 검증을 할 수 없습니다. Request URL 자체가 추측하기 어려운
// 긴 exec 주소이므로 사내용으로는 허용 가능한 리스크로 보고 진행합니다.
// "사번+휴대폰 뒷자리 4자리" 로그인은 편의성 우선 방식이라 원천적으로 강한 인증은 아닙니다.
// 6시간 내 5회 실패 시 잠그는 정도의 무차별 대입 방지만 걸어뒀습니다.
//
// ── 근태현황 데이터 범위 ──
// gwangjae_v222.html의 ③근태관리 화면과 동일한 컬럼(S출근~AB휴일연장 포함)을 계산해서 보여줍니다.
// 단, "월별 스케줄 등록(sched_saved)" 월단위 override는 이식하지 않았습니다 — 그 기능으로
// 개별 조정된 날짜가 있다면 화면 숫자가 관제센터 프로그램과 다를 수 있습니다. 그 외(비고/연장승인/
// 셀단위 수기입력/주휴 개근판정 등)는 화면과 동일한 로직으로, Supabase를 매번 직접 조회해서
// 계산하므로 관제센터 프로그램에서 수정한 내용이 새로고침 즉시 반영됩니다.
// ============================================================

const SomyungBtn = (function(){
  const SB_URL = 'https://dcvitbydqidndwbqqprm.supabase.co';
  const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRjdml0YnlkcWlkbmR3YnFxcHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyMDE1ODMsImV4cCI6MjA5Nzc3NzU4M30.xHDxj8-0jTTOrWTErOMPQB4EvyKhuOsgkPAjAB2txmc';
  const DOW_KEYS = ['sun','mon','tue','wed','thu','fri','sat'];
  const DOW_LABEL = ['일','월','화','수','목','금','토'];

  // ★ "내 근태현황 보기" 버튼이 여는 페이지 — GAS exec URL을 직접 열면 브라우저의 서드파티 쿠키
  //   차단으로 인해 Google Apps Script의 콘텐츠 iframe이 로드되지 않아 빈 화면이 뜨는 문제가 있어,
  //   별도로 배포한 정적 페이지(GitHub Pages)를 열도록 분리했습니다. 실제 데이터는 그 페이지가
  //   handleMyAttApi(JSONP)를 호출해서 받아옵니다.
  const MY_ATT_PAGE_URL = 'https://jungjukim123.github.io/gwangjae-my-attendance/';

  function _getSlackToken(){
    const token = PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
    if(!token) throw new Error('스크립트 속성에 SLACK_BOT_TOKEN이 등록되어 있지 않습니다. 프로젝트 설정(⚙) → 스크립트 속성에서 등록해주세요.');
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

  // ── 날짜 유틸 (연차현황 스크립트와 동일) ──
  function dim(y,m){ return new Date(y, m, 0).getDate(); }
  function dStr(y,m,d){ return y+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0'); }
  function addDaysStr(ds,n){ const d=new Date(ds+'T00:00:00'); d.setDate(d.getDate()+n); return dStr(d.getFullYear(), d.getMonth()+1, d.getDate()); }
  function addMonthsClamped(ds,n){
    const p=ds.split('-').map(Number), y=p[0], m=p[1], d=p[2];
    const t=(m-1)+n, ny=y+Math.floor(t/12), nm=((t%12)+12)%12+1;
    return dStr(ny, nm, Math.min(d, dim(ny,nm)));
  }
  function addYearsClamped(ds,n){ return addMonthsClamped(ds, n*12); }

  // ── 계약/직원 조회 (연차현황 스크립트와 동일 로직) ──
  function getJoinDate(empId, employees, contracts){
    const cons=contracts.filter(c=>c.사번===empId && c.cs).sort((a,b)=>new Date(a.cs)-new Date(b.cs));
    const emp=employees.find(e=>e.사번===empId);
    const fromCon=cons[0] && (cons[0].입사 || cons[0].cs);
    return (emp && emp.입사) || fromCon || '';
  }
  function getQuitDate(empId, employees, contracts){
    const hasCon=contracts.some(c=>c.사번===empId);
    if(hasCon){
      const exitCon=contracts.filter(c=>c.사번===empId && c.구분==='퇴사' && c.퇴사).sort((a,b)=>new Date(b.퇴사)-new Date(a.퇴사))[0];
      if(exitCon) return exitCon.퇴사;
      const latestCon=contracts.filter(c=>c.사번===empId && c.구분!=='퇴사').sort((a,b)=>new Date(b.cs)-new Date(a.cs))[0];
      return (latestCon && latestCon.퇴사) || '';
    }
    const emp=employees.find(e=>e.사번===empId);
    return (emp && emp.퇴사) || '';
  }
  function getLatestConEnd(empId, contracts){
    const cons=contracts.filter(c=>c.사번===empId && c.구분!=='퇴사' && c.ce);
    if(!cons.length) return '';
    return cons.reduce((max,c)=>c.ce>max?c.ce:max, cons[0].ce);
  }
  function getWeekSojeong(empId, ds, contracts, employees){
    const m=contracts.filter(c=>c.사번===empId && c.구분!=='퇴사' && c.cs<=ds && c.ce>=ds).sort((a,b)=>new Date(b.cs)-new Date(a.cs));
    if(m.length) return Number(m[0].소정) || 40;
    const e=employees.find(x=>x.사번===empId);
    return Number(e && e.소정) || 40;
  }
  function getSchedSojeong(empId, ds, contracts, employees){
    const dow=new Date(ds+'T00:00:00').getDay(), key=DOW_KEYS[dow];
    const m=contracts.filter(c=>c.사번===empId && c.구분!=='퇴사' && c.cs<=ds && c.ce>=ds).sort((a,b)=>new Date(b.cs)-new Date(a.cs));
    if(!m.length){
      const e=employees.find(x=>x.사번===empId);
      if(e && e.cs<=ds && e.ce>=ds) return 8;
      return 0;
    }
    const h=m[0][key];
    if(h==='주휴') return '주휴';
    return Number(h)||0;
  }
  function getConWorkDaysCount(empId, ds, contracts){
    const m=contracts.filter(c=>c.사번===empId && c.구분!=='퇴사' && c.cs<=ds && c.ce>=ds).sort((a,b)=>new Date(b.cs)-new Date(a.cs));
    if(!m.length) return 5;
    const con=m[0];
    const cnt=DOW_KEYS.filter(k=>con[k]!=='주휴' && Number(con[k])>0).length;
    return cnt>0?cnt:5;
  }
  function getLeaveSojeong(empId, ds, contracts, employees){
    const raw=getSchedSojeong(empId, ds, contracts, employees);
    const v=typeof raw==='number'?raw:0;
    if(v>0) return v;
    return Math.round((getWeekSojeong(empId, ds, contracts, employees)/getConWorkDaysCount(empId, ds, contracts))*100)/100;
  }
  function getLeaveHourPerDay(empId, ds, contracts, employees){
    const wk=getWeekSojeong(empId, ds, contracts, employees);
    return Math.round((wk/40)*8*100)/100;
  }
  function getLeaveTypeFactor(gubun){
    if(gubun==='반차') return 0.5;
    if(gubun==='반반차') return 0.25;
    if(gubun==='결근'||gubun==='공가') return 0;
    return 1;
  }
  function getLeaveUsageRecords(empId, leaveUsageList, hrSavedDaysByEmp){
    const list=[];
    (hrSavedDaysByEmp[empId]||[]).forEach(d=>{
      if(d.bigo==='연차'||d.bigo==='반차'||d.bigo==='결근') list.push({사번:empId, 구분:d.bigo, 사용일:d.date, source:'auto'});
      else if(d.bigo==='월차') list.push({사번:empId, 구분:'연차', 사용일:d.date, source:'auto'});
    });
    leaveUsageList.forEach(u=>{ if(u.사번===empId) list.push(Object.assign({}, u, {source:'manual'})); });
    const seen={};
    return list.filter(u=>{
      const k=u.사번+'_'+u.사용일+'_'+u.구분;
      if(seen[k]) return u.source==='auto';
      seen[k]=true; return true;
    });
  }
  function buildLeaveAccrualRows(empId, contracts, employees, leaveUsageList, hrSavedDaysByEmp, today){
    const join=getJoinDate(empId, employees, contracts);
    if(!join) return [];
    const quit=getQuitDate(empId, employees, contracts);
    const latestConEnd=getLatestConEnd(empId, contracts);
    const asOf=(quit && quit<today)?quit:((latestConEnd && latestConEnd<today)?latestConEnd:today);
    const absences=getLeaveUsageRecords(empId, leaveUsageList, hrSavedDaysByEmp).filter(u=>u.구분==='결근').map(u=>u.사용일);
    const rows=[];
    let 발생시간합=0;
    for(let n=1; n<=11; n++){
      const winStart=addMonthsClamped(join, n-1);
      if(winStart>asOf) break;
      const creditDate=addMonthsClamped(join, n);
      const winEnd=addDaysStr(creditDate, -1);
      const 결근일자=absences.filter(d=>d>=winStart && d<=winEnd);
      const weekSojeong=getWeekSojeong(empId, creditDate, contracts, employees);
      if(creditDate<=asOf && weekSojeong>=15 && 결근일자.length===0){
        발생시간합 += getLeaveHourPerDay(empId, creditDate, contracts, employees);
      }
    }
    const bucket0CeFull=addDaysStr(addYearsClamped(join,1), -1);
    const bucket0Ce=asOf<bucket0CeFull?asOf:bucket0CeFull;
    rows.push({구분:'1년미만연차', cs:join, ce:bucket0Ce, 발생: Math.round(발생시간합*100)/100});
    let n=1;
    while(n<=60){
      const bStart=addYearsClamped(join, n);
      if(bStart>asOf) break;
      const bEnd=addDaysStr(addYearsClamped(join, n+1), -1);
      const under15=getWeekSojeong(empId, bStart, contracts, employees) < 15;
      const days=under15?0:Math.min(15+Math.floor((n-1)/2), 25);
      const hourPerDay=getLeaveHourPerDay(empId, bStart, contracts, employees);
      rows.push({구분:'1년이상연차', cs:bStart, ce:bEnd, 발생: under15?0:Math.round(days*hourPerDay*100)/100});
      n++;
    }
    return rows;
  }
  function allocateLeaveUsage(rows, usageRecords, empId, contracts, employees){
    rows.forEach(r=>{ r.사용=0; });
    usageRecords.forEach(u=>{
      const factor=getLeaveTypeFactor(u.구분);
      if(factor<=0) return;
      let remain=Math.round(factor*getLeaveSojeong(empId, u.사용일, contracts, employees)*100)/100;
      let lastEligible=null;
      for(let i=0;i<rows.length;i++){
        const r=rows[i];
        if(u.사용일<r.cs) continue;
        lastEligible=r;
        const avail=r.발생-r.사용;
        if(avail<=0) continue;
        const take=Math.min(avail, remain);
        r.사용+=take; remain-=take;
        if(remain<=0) break;
      }
      if(remain>0 && lastEligible) lastEligible.사용+=remain;
    });
    rows.forEach(r=>{
      r.사용=Math.round(r.사용*100)/100;
      r.잔여=Math.round((r.발생-r.사용)*100)/100;
    });
  }

  // ── 공용 조회 ──
  function _loadBase(){
    return { employees: sbSelect('employees'), contracts: sbSelect('contracts') };
  }
  function _findEidBySlackId(slackId, contracts){
    const con=contracts.filter(c=>c.slackId===slackId && c.구분!=='퇴사').sort((a,b)=>new Date(b.cs)-new Date(a.cs))[0];
    return con ? con.사번 : '';
  }

  // ── 슬랙 DM 발송 ──
  function _postSlackDM(slackId, text, blocks){
    const token=_getSlackToken();
    const payload={ channel:slackId, text:text, mrkdwn:true };
    if(blocks) payload.blocks=blocks;
    const res=UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
      method:'post', contentType:'application/json',
      headers:{ Authorization:'Bearer '+token },
      payload: JSON.stringify(payload),
      muteHttpExceptions:true
    });
    const json=JSON.parse(res.getContentText());
    if(!json.ok) Logger.log('Slack 발송 실패 ('+slackId+'): '+json.error);
    return json.ok;
  }

  // 근태소명 DM과 동일한 "내 근태현황 보기 / 잔여연차 확인" 버튼
  // ★ "내 근태현황 보기"는 이제 이메일이 아니라 본인인증(사번+휴대폰 뒷자리) 후 보는
  //   읽기전용 웹페이지로 바로 열립니다(url 버튼 — 클릭해도 doPost를 거치지 않음).
  function _myAttUrl(){
    return MY_ATT_PAGE_URL;
  }
  function _actionBlocks(eid, text){
    return [
      {type:'section', text:{type:'mrkdwn', text:text}},
      {type:'actions', elements:[
        {type:'button', text:{type:'plain_text', text:'📊 내 근태현황 보기', emoji:true}, url:_myAttUrl()},
        {type:'button', text:{type:'plain_text', text:'🌴 잔여연차 확인', emoji:true}, action_id:'somyung_view_leave', value:eid},
        {type:'button', text:{type:'plain_text', text:'🔢 사번 확인', emoji:true}, action_id:'somyung_view_eid', value:eid}
      ]}
    ];
  }

  // ── ① 잔여연차 확인 ──
  function handleViewLeave(slackUserId){
    const {employees, contracts} = _loadBase();
    const eid=_findEidBySlackId(slackUserId, contracts);
    if(!eid){ _postSlackDM(slackUserId, '⚠️ 계약기간관리에 등록된 SlackID를 찾을 수 없습니다. 담당자(@김정주)에게 문의해주세요.'); return; }
    const emp=employees.find(e=>e.사번===eid);
    const metaRows=sbSelect('meta', 'key=eq.leaveUsage');
    const leaveUsageList=(metaRows.length && metaRows[0].value) ? JSON.parse(metaRows[0].value) : [];
    const hrSavedRows=sbSelect('hr_saved', 'emp_id=eq.'+encodeURIComponent(eid));
    const hrSavedDaysByEmp={};
    hrSavedRows.forEach(r=>{
      const days=JSON.parse(r.days_json||'[]');
      if(!hrSavedDaysByEmp[eid]) hrSavedDaysByEmp[eid]=[];
      hrSavedDaysByEmp[eid]=hrSavedDaysByEmp[eid].concat(days);
    });
    const now=new Date();
    const today=dStr(now.getFullYear(), now.getMonth()+1, now.getDate());
    const rows=buildLeaveAccrualRows(eid, contracts, employees, leaveUsageList, hrSavedDaysByEmp, today);
    if(!rows.length){ _postSlackDM(slackUserId, '⚠️ 연차 계산에 필요한 입사일 정보가 없습니다. 담당자(@김정주)에게 문의해주세요.'); return; }
    const usageRecords=getLeaveUsageRecords(eid, leaveUsageList, hrSavedDaysByEmp);
    allocateLeaveUsage(rows, usageRecords, eid, contracts, employees);
    const bucket0=rows.find(r=>r.구분==='1년미만연차');
    const over1Rows=rows.filter(r=>r.구분==='1년이상연차');
    const under1Text=bucket0
      ? ('• 발생: '+bucket0.발생+'시간\n• 사용: '+bucket0.사용+'시간\n• 잔여: '+bucket0.잔여+'시간')
      : '없음';
    let over1Text='없음';
    if(over1Rows.length){
      const 발생1=Math.round(over1Rows.reduce((a,r)=>a+r.발생,0)*100)/100;
      const 사용1=Math.round(over1Rows.reduce((a,r)=>a+r.사용,0)*100)/100;
      const 잔여1=Math.round((발생1-사용1)*100)/100;
      over1Text='• 발생: '+발생1+'시간\n• 사용: '+사용1+'시간\n• 잔여: '+잔여1+'시간';
    }
    const usageLines=usageRecords
      .filter(u=>getLeaveTypeFactor(u.구분)>0)
      .sort((a,b)=>a.사용일.localeCompare(b.사용일))
      .map(u=>{
        const hrs=Math.round(getLeaveTypeFactor(u.구분)*getLeaveSojeong(eid, u.사용일, contracts, employees)*100)/100;
        return '• '+u.사용일.replace(/-/g,'.')+'  '+hrs+'시간';
      }).join('\n') || '사용 내역 없음';
    const DIV='────────────────────────────';
    const text='안녕하세요, 피플팀입니다 😊\n\n'
      +'*'+(emp?emp.이름:eid)+'*님이 요청하신 잔여연차 현황을 안내드립니다.\n\n'
      +DIV+'\n📌 *[잔여연차 안내]* '+now.getFullYear()+'년 '+String(now.getMonth()+1).padStart(2,'0')+'월 기준\n\n'
      +'🔹 *1년이상연차*\n'+over1Text+'\n\n'
      +'🔹 *1년미만연차* (사용기간: 입사일로부터 1년)\n'+under1Text+'\n\n'
      +'📋 사용내역\n'+usageLines+'\n\n'
      +'※ 아직 승인되지 않은 연차의 경우 사용내역에 반영되지 않을 수 있습니다.\n'
      +DIV+'\n\n궁금하신 점은 담당자(@김정주)에게 편하게 연락 주세요!\n\n'
      +'감사합니다.\n피플팀 드림';
    _postSlackDM(slackUserId, text, _actionBlocks(eid, text));
  }

  // ── ⓪ 사번 확인 ──
  function handleViewEid(slackUserId){
    const {employees, contracts} = _loadBase();
    const eid=_findEidBySlackId(slackUserId, contracts);
    if(!eid){ _postSlackDM(slackUserId, '⚠️ 계약기간관리에 등록된 SlackID를 찾을 수 없습니다. 담당자(@김정주)에게 문의해주세요.'); return; }
    const emp=employees.find(e=>e.사번===eid);
    const text='안녕하세요, 피플팀입니다 😊\n\n🔢 *'+(emp?emp.이름:eid)+'*님의 사번은 *'+eid+'* 입니다.';
    _postSlackDM(slackUserId, text, _actionBlocks(eid, text));
  }

  // ── ② 내 근태현황 보기 계산 로직 (화면 ③근태관리와 동일 컬럼) ──
  // ★ gwangjae_v222.html의 tH/cU/cV/cW/cX/cY/cAA/cAB/calcJuhyu 등 계산 로직을 그대로 이식.
  //   단, "월별 스케줄 등록(sched_saved)" 월단위 override는 이식하지 않음(드물게 쓰이는 관리자 조작이라 생략) —
  //   그 기능으로 변경된 날짜는 화면 숫자와 다를 수 있음. 그 외(비고/연장승인/셀단위 수기입력 등)는 모두 반영됨.
  const KR_HOLIDAYS_ATT=new Set([
    '2026-01-01','2026-03-01','2026-05-05','2026-06-06',
    '2026-08-15','2026-10-03','2026-10-09','2026-12-25',
    '2026-08-17', // 광복절 대체공휴일 (8/15가 토요일이라 8/17 월요일 대체)
    '2026-01-27','2026-01-28','2026-01-29','2026-01-30',
    '2026-05-24','2026-06-03',
    '2026-10-05','2026-10-06','2026-10-07','2026-10-08',
  ]);
  function _attTH(t){ if(!t||t===''||t==='-') return null; const p=t.split(':').map(Number); return p[0]+p[1]/60; }
  function _attGetLatestCon(empId, contracts){
    const list=contracts.filter(c=>c.사번===empId && c.구분!=='퇴사').sort((a,b)=>new Date(b.cs)-new Date(a.cs));
    return list[0]||null;
  }
  function _attGetMergedEmp(e, contracts){
    const con=_attGetLatestCon(e.사번, contracts);
    if(!con) return e;
    return Object.assign({}, e, {
      임금: con.임금||e.임금,
      시급: (con.임금||e.임금)==='시급직' ? (Number(con.시급)||e.시급||0) : 0,
      기본: Number(con.기본)||e.기본||0,
      식대: Number(con.식대)||e.식대||0,
      직책: Number(con.직책)||e.직책||0,
      소정: Number(con.소정)||e.소정||40,
      월소정: e.월소정||209,
      소속: con.소속||e.소속||''
    });
  }
  function _attRate(e, contracts){
    const m=_attGetMergedEmp(e, contracts);
    return m.임금==='시급직' ? m.시급 : ((m.기본||0)+(m.식대||0)+(m.직책||0))/(m.월소정||209);
  }
  function _attGetSched(empId, ds, contracts, employees){
    const dow=new Date(ds+'T00:00:00').getDay(), key=DOW_KEYS[dow];
    const m=contracts.filter(c=>c.사번===empId && c.구분!=='퇴사' && c.cs<=ds && c.ce>=ds).sort((a,b)=>new Date(b.cs)-new Date(a.cs));
    if(!m.length){
      const e=employees.find(x=>x.사번===empId);
      if(e && e.cs<=ds && e.ce>=ds) return 8;
      return '계약기간 없음';
    }
    const h=m[0][key];
    if(h==='주휴') return '주휴';
    return Number(h)||0;
  }
  function _attGetSchedSojeong(empId, ds, contracts, employees){
    const dow=new Date(ds+'T00:00:00').getDay(), key=DOW_KEYS[dow];
    const m=contracts.filter(c=>c.사번===empId && c.구분!=='퇴사' && c.cs<=ds && c.ce>=ds).sort((a,b)=>new Date(b.cs)-new Date(a.cs));
    if(!m.length){
      const e=employees.find(x=>x.사번===empId);
      if(e && e.cs<=ds && e.ce>=ds) return 8;
      return '계약기간 없음';
    }
    const h=m[0][key];
    if(h==='주휴') return '주휴';
    return Number(h)||0;
  }
  function _attGetConTimes(empId, ds, contracts, employees){
    const m=contracts.filter(c=>c.사번===empId && c.구분!=='퇴사' && c.cs<=ds && c.ce>=ds).sort((a,b)=>new Date(b.cs)-new Date(a.cs));
    if(m.length) return {st:m[0].st||'', et:m[0].et||''};
    const e=employees.find(x=>x.사번===empId);
    return {st:(e&&e.st)||'', et:(e&&e.et)||''};
  }
  function _attGetWeekSojeong(empId, ds, contracts, employees){
    const m=contracts.filter(c=>c.사번===empId && c.구분!=='퇴사' && c.cs<=ds && c.ce>=ds).sort((a,b)=>new Date(b.cs)-new Date(a.cs));
    if(m.length) return Number(m[0].소정)||40;
    const e=employees.find(x=>x.사번===empId);
    return Number(e&&e.소정)||40;
  }
  function _attGetAtt(ds, attByDate, slackByDate){
    const a=attByDate[ds];
    if(a && a.locked) return a;
    const s=slackByDate[ds];
    if(s) return {in:s.in||'', out:s.out||''};
    return a || {in:'', out:''};
  }
  function _deriveGbnSojeong(eid, ds, contracts, employees){
    const emp=employees.find(e=>e.사번===eid);
    const sched=_attGetSched(eid, ds, contracts, employees);
    const sojeong=_attGetSchedSojeong(eid, ds, contracts, employees);
    const afterQuit = emp && emp.퇴사 && emp.퇴사!=='' && ds>emp.퇴사;
    if(afterQuit) return {gbn:'계약기간 없음', 소정:'계약기간 없음'};
    if(sched==='계약기간 없음') return {gbn:'계약기간 없음', 소정:'계약기간 없음'};
    if(sched==='주휴' || sojeong==='주휴') return {gbn:'주휴일', 소정:0};
    if(sched===0) return {gbn:'무급휴일', 소정:0};
    return { gbn: KR_HOLIDAYS_ATT.has(ds) ? '공휴일' : '평일', 소정: (typeof sojeong==='number' ? sojeong : sched) };
  }
  function _cU(i,o){ if(i===null||o===null) return 0; let d=o-i; if(d<=0) d+=24; d-=1; if(d>=4&&d<8) return 0.5; if(d>=8) return 1; return 0; }
  function _cV(emp, ds, gbn, 소정, i, o, U, bigo, otApproved, contracts, employees){
    if(new Date(emp.입사)>new Date(ds)) return 0;
    if(emp.퇴사 && emp.퇴사!=='' && ds>emp.퇴사) return 0;
    if(gbn==='무급휴일'){
      if(otApproved && i!==null && o!==null){
        const o24=o<=i?o+24:o;
        return Math.max(0, o24-i-U);
      }
      return 0;
    }
    if(bigo==='연차') return typeof 소정==='number' ? 소정 : 0;
    if(bigo==='월차'){ const wk=_attGetWeekSojeong(emp.사번, ds, contracts, employees); return (wk/40)*8; }
    if(bigo==='반차'){
      const half = typeof 소정==='number' ? 소정/2 : 0;
      if(i!==null && o!==null){
        const o24=o<=i?o+24:o, X2=o24>22?o24-22:0;
        const worked = o24<=24 ? Math.max(0,o24-i-U) : Math.max(0,18-i-U-X2);
        return half+worked;
      }
      return half;
    }
    if(bigo==='결근') return 0;
    if(gbn==='주휴일'){
      if(i!==null && o!==null){
        const o24=o<=i?o+24:o, X=o24>22?o24-22:0;
        return o24<=24 ? Math.max(0,o24-i-U) : Math.max(0,18-i-U-X);
      }
      return 0;
    }
    if(i===null||o===null||소정==='휴일'||소정==='계약기간 없음') return 0;
    const o24=o<=i?o+24:o, X=o24>22?o24-22:0;
    if(o24<=24) return Math.max(0,o24-i-U);
    return Math.max(0,18-i-U-X);
  }
  function _cW(V, 소정){ return Math.min(V, typeof 소정==='number'?소정:0); }
  function _cX(i,o){
    if(o===null||i===null) return 0;
    const o2=o<6?o+24:o, i2=i<6?i+24:i;
    const effectiveStart = i2>22?i2:22;
    const raw = o2>effectiveStart ? Math.max(0,o2-effectiveStart) : 0;
    return Math.floor(raw*2)/2;
  }
  function _cY(gbn, V, 소정, 확인){
    if(gbn==='휴일'||gbn==='주휴일'||gbn==='공휴일') return 0;
    if(gbn==='무급휴일') return 확인==='연장근무' ? Math.max(0,V) : 0;
    const s=typeof 소정==='number'?소정:0;
    if(V-s>0 && 확인==='연장근무') return Math.max(0,V-s);
    return 0;
  }
  function _cAA(i,o,U,X,gbn){
    if(i===null||o===null) return 0;
    if(gbn!=='휴일'&&gbn!=='주휴일'&&gbn!=='무급휴일'&&gbn!=='공휴일') return 0;
    if(gbn==='무급휴일') return 0;
    const o24=o<=i?o+24:o;
    if(o24<=24) return Math.max(0,o24-i-U);
    return Math.max(0,18-i-U-X);
  }
  function _cAB(AA){ return Math.max(0, AA-8); }
  function _isFullAttendanceWeek(eid, ds, contracts, employees, bigoByDate, attByDate, slackByDate){
    const base=new Date(ds+'T00:00:00');
    const workDates=[];
    for(let k=7;k>=1;k--){
      const d=new Date(base); d.setDate(base.getDate()-k);
      workDates.push(dStr(d.getFullYear(), d.getMonth()+1, d.getDate()));
    }
    let hasWorkDay=false;
    for(let idx=0; idx<workDates.length; idx++){
      const wds=workDates[idx];
      const info=_deriveGbnSojeong(eid, wds, contracts, employees);
      if(info.gbn!=='평일' && info.gbn!=='공휴일') continue;
      if(!(typeof info.소정==='number' && info.소정>0)) continue;
      hasWorkDay=true;
      const bigo=bigoByDate[wds]||'';
      const att=_attGetAtt(wds, attByDate, slackByDate);
      const hasIn = att.in && att.in!=='';
      if(bigo==='연차') continue;
      if(bigo==='결근') return false;
      if(info.gbn==='공휴일' && !hasIn) continue;
      if(!hasIn) return false;
    }
    return hasWorkDay;
  }
  function _calcJuhyu(emp, ds, override, contracts, employees, bigoByDate, attByDate, slackByDate){
    if(emp.임금!=='시급직') return 0;
    if(override!==undefined && override!==null && override!=='') return Number(override)||0;
    if(!_isFullAttendanceWeek(emp.사번, ds, contracts, employees, bigoByDate, attByDate, slackByDate)) return 0;
    const week=_attGetWeekSojeong(emp.사번, ds, contracts, employees);
    return (week/40)*8;
  }
  function _gbnLabel(gbn){
    if(gbn==='주휴일') return '주휴';
    if(gbn==='무급휴일') return '무급';
    if(gbn==='공휴일') return '휴일';
    if(gbn==='계약기간 없음') return '계약외';
    return '평일';
  }
  function _fmtCell(v){ return (typeof v==='number' && v>0) ? Math.round(v*100)/100 : '-'; }
  function _fmtSum(v){ return Math.round((v||0)*100)/100; }

  // 근태 테이블 데이터 계산 (렌더링과 분리 — HTML 페이지에서 재사용)
  function _buildAttTableData(eid, yr, mo, employees, contracts){
    const emp=employees.find(e=>e.사번===eid);
    const con=contracts.filter(c=>c.사번===eid && c.구분!=='퇴사').sort((a,b)=>new Date(b.cs)-new Date(a.cs))[0];
    const dayCount=dim(yr,mo);
    const first=dStr(yr,mo,1), last=dStr(yr,mo,dayCount);
    const extFirst=addDaysStr(first,-7); // 주휴(개근) 판정을 위해 월초 이전 7일도 함께 조회

    const attRows=sbSelect('att_data', 'emp_id=eq.'+encodeURIComponent(eid)+'&date=gte.'+extFirst+'&date=lte.'+last);
    const attByDate={}; attRows.forEach(r=>{ attByDate[r.date]={in:r.in||'', out:r.out||'', locked:!!r.locked}; });
    const slackRows=sbSelect('slack_data', 'emp_id=eq.'+encodeURIComponent(eid)+'&date=gte.'+extFirst+'&date=lte.'+last);
    // 자정 넘김 보정: out이 00:01~05:59이면 전날 퇴근 + 시간 00:00으로 보정 (gwangjae_v222.html과 동일 로직)
    const slackByDate={};
    slackRows.forEach(r=>{
      let date=r.date, outVal=r.out||'';
      if(outVal){
        const t=outVal.split(':').map(Number), ohh=t[0], omm=t[1];
        if((ohh===0 && omm>=1) || (ohh>=1 && ohh<6)){
          date=addDaysStr(date, -1);
          outVal='00:00';
        }
      }
      slackByDate[date]={in:r.in||'', out:outVal};
    });

    const hrSavedRows=sbSelect('hr_saved', 'emp_id=eq.'+encodeURIComponent(eid)+'&yr=eq.'+yr+'&mo=eq.'+mo);
    const dayInfoByDate={};
    hrSavedRows.forEach(r=>{
      JSON.parse(r.days_json||'[]').forEach(d=>{ if(d.date) dayInfoByDate[d.date]=d; });
    });
    const bigoByDate={};
    Object.keys(dayInfoByDate).forEach(ds=>{ bigoByDate[ds]=dayInfoByDate[ds].bigo||''; });

    const rateVal=Math.round(_attRate(emp, contracts));
    const header=['NO','귀속년도','귀속월','사번','소속','급여종','이름','일자','요일','구분','연장승인','통상시급','시업','종료','비고','소정','S출근','T퇴근','U휴게','V총근무','W기본','주휴시간','X야간','Y연장','AA휴일','AB휴일연장'];
    const rows=[];
    let mU=0,mV=0,mW=0,mX=0,mY=0,mAA=0,mAB=0,mJH=0;

    for(let d=1; d<=dayCount; d++){
      const ds=dStr(yr,mo,d);
      const dow=new Date(ds+'T00:00:00').getDay();
      const base=_deriveGbnSojeong(eid, ds, contracts, employees);
      const sd=dayInfoByDate[ds]||{};
      let gbn=base.gbn, 소정=base.소정;
      if(sd.gbn수기){ gbn=sd.gbn수기; }
      else if(sd.소정수기!==undefined && sd.소정수기!==''){
        if(sd.소정수기==='주휴') gbn='주휴일';
        else if(base.gbn!=='계약기간 없음'){
          if(Number(sd.소정수기)===0) gbn='무급휴일';
          else if(Number(sd.소정수기)>0) gbn = KR_HOLIDAYS_ATT.has(ds) ? '공휴일' : '평일';
        }
      }
      if(sd.소정수기!==undefined && sd.소정수기!=='') 소정 = (sd.소정수기==='0' ? 0 : sd.소정수기);

      const bigo=sd.bigo||'';
      const 확인=sd.확인||'';
      const otApproved = sd.연장승인==='승인' || sd.연장인사==='승인' || 확인==='연장근무';

      const att=_attGetAtt(ds, attByDate, slackByDate);
      const i=_attTH(att.in), o=_attTH(att.out);

      const _U0=_cU(i,o);
      const U = sd.수기U!==undefined ? sd.수기U : _U0;
      const _V0=_cV(emp, ds, gbn, 소정, i, o, U, bigo, otApproved, contracts, employees);
      const isHolW = gbn==='공휴일' && typeof 소정==='number' && 소정>0;
      const V = sd.수기V!==undefined ? sd.수기V : _V0;
      const _X0=_cX(i,o);
      const _W0 = gbn==='주휴일' ? 0 : (isHolW ? 소정 : _cW(V, 소정));
      const _Y0=_cY(gbn, V, 소정, otApproved?'연장근무':확인);
      const _AA0=_cAA(i,o,U,_X0,gbn);
      const _AB0=_cAB(_AA0);
      const W = sd.수기W!==undefined ? sd.수기W : _W0;
      const X = sd.수기X!==undefined ? sd.수기X : _X0;
      const Y = sd.수기Y!==undefined ? sd.수기Y : _Y0;
      const AA = sd.수기AA!==undefined ? sd.수기AA : _AA0;
      const AB = sd.수기AB!==undefined ? sd.수기AB : _AB0;
      const juhyuH = gbn==='주휴일' ? _calcJuhyu(emp, ds, sd.주휴수기, contracts, employees, bigoByDate, attByDate, slackByDate) : 0;

      mU+=U; mV+=V; mW+=W; mX+=X; mY+=Y; mAA+=AA; mAB+=AB; mJH+=juhyuH;

      const conTimes=_attGetConTimes(eid, ds, contracts, employees);
      rows.push([
        d, yr, mo, eid, con&&con.소속||emp.소속||'-', emp.임금==='월급직'?'월급':'시급', emp.이름,
        ds, DOW_LABEL[dow], _gbnLabel(gbn), otApproved?'승인':'-',
        rateVal, conTimes.st||'-', conTimes.et||'-', bigo||'-',
        (typeof 소정==='number'?소정:소정),
        att.in||'-', att.out||'-', _fmtCell(U), _fmtCell(V), _fmtCell(W), _fmtCell(juhyuH), _fmtCell(X), _fmtCell(Y), _fmtCell(AA), _fmtCell(AB)
      ]);
    }

    const totalRow=new Array(header.length).fill('');
    totalRow[0]='합계';
    totalRow[18]=_fmtSum(mU); totalRow[19]=_fmtSum(mV); totalRow[20]=_fmtSum(mW); totalRow[21]=_fmtSum(mJH);
    totalRow[22]=_fmtSum(mX); totalRow[23]=_fmtSum(mY); totalRow[24]=_fmtSum(mAA); totalRow[25]=_fmtSum(mAB);

    return { header:header, rows:rows, totalRow:totalRow, emp:emp };
  }

  // ── "나의 근태현황" 읽기전용 웹페이지 (사번 + 휴대폰 뒷자리 4자리 인증) ──
  // ★ 관리자 메뉴 없음, 수정 폼 없음, 본인 데이터만 그때그때 Supabase에서 직접 조회해서 그리므로
  //   관제센터 프로그램에서 고친 내용이 새로고침 즉시 반영됩니다.
  function _esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function _loginAttemptsOk(eid){
    return Number(CacheService.getScriptCache().get('login_fail_'+eid) || 0) < 5;
  }
  function _recordLoginFail(eid){
    const cache=CacheService.getScriptCache();
    const cnt=Number(cache.get('login_fail_'+eid) || 0) + 1;
    cache.put('login_fail_'+eid, String(cnt), 21600); // 6시간 잠금
  }
  function _clearLoginFail(eid){
    CacheService.getScriptCache().remove('login_fail_'+eid);
  }
  function _loginPageHtml(errMsg){
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
      +'<title>나의 근태현황</title>'
      +'<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:340px;margin:60px auto;padding:0 20px;color:#222}'
      +'h2{text-align:center}input{width:100%;padding:10px;margin:8px 0;border:1px solid #ccc;border-radius:6px;box-sizing:border-box;font-size:15px}'
      +'button{width:100%;padding:12px;background:#2563EB;color:#fff;border:none;border-radius:6px;font-size:15px;font-weight:600;margin-top:8px}'
      +'.err{color:#DC2626;font-size:13px;text-align:center;margin-top:10px}</style></head><body>'
      +'<h2>🔒 나의 근태현황</h2>'
      +'<form method="get">'
      +'<input type="hidden" name="action" value="my_att">'
      +'<input type="text" name="eid" placeholder="사번" required>'
      +'<input type="text" name="phone4" placeholder="휴대폰 번호 뒷자리 4자리" maxlength="4" inputmode="numeric" pattern="[0-9]{4}" required>'
      +'<button type="submit">로그인</button>'
      +(errMsg ? '<div class="err">'+_esc(errMsg)+'</div>' : '')
      +'</form></body></html>';
  }
  function handleMyAttGet(e){
    const p=(e && e.parameter) || {};
    const eid=(p.eid||'').trim();
    const phone4=(p.phone4||'').trim();
    if(!eid || !phone4){
      return HtmlService.createHtmlOutput(_loginPageHtml('')).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }
    if(!_loginAttemptsOk(eid)){
      return HtmlService.createHtmlOutput(_loginPageHtml('로그인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.')).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }
    const {employees, contracts} = _loadBase();
    const emp=employees.find(x=>x.사번===eid);
    const con=contracts.filter(c=>c.사번===eid && c.구분!=='퇴사').sort((a,b)=>new Date(b.cs)-new Date(a.cs))[0];
    const phone=(con && con.phone) || (emp && emp.phone) || '';
    const digits=String(phone).replace(/[^0-9]/g,'');
    if(!emp || digits.slice(-4)!==phone4){
      _recordLoginFail(eid);
      return HtmlService.createHtmlOutput(_loginPageHtml('사번 또는 휴대폰 번호가 일치하지 않습니다.')).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }
    _clearLoginFail(eid);

    try{
      const now=new Date();
      const yr=Number(p.yr)||now.getFullYear();
      const mo=Number(p.mo)||(now.getMonth()+1);
      const built=_buildAttTableData(eid, yr, mo, employees, contracts);

      let yrOpts='';
      for(let y=now.getFullYear()-1; y<=now.getFullYear()+1; y++){
        yrOpts+='<option value="'+y+'"'+(y===yr?' selected':'')+'>'+y+'년</option>';
      }
      let moOpts='';
      for(let m=1; m<=12; m++){
        moOpts+='<option value="'+m+'"'+(m===mo?' selected':'')+'>'+m+'월</option>';
      }
      let rowsHtml='';
      built.rows.forEach(function(r){ rowsHtml+='<tr><td>'+r.map(_esc).join('</td><td>')+'</td></tr>'; });
      const totalHtml='<tr class="total"><td>'+built.totalRow.map(_esc).join('</td><td>')+'</td></tr>';

      const html='<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        +'<title>나의 근태현황</title>'
        +'<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:16px;color:#222}'
        +'h2{margin:0 0 4px}.sub{color:#666;font-size:13px;margin-bottom:12px}'
        +'form.f2{margin-bottom:12px}select{padding:6px;margin-right:6px}'
        +'button{padding:6px 14px;background:#2563EB;color:#fff;border:none;border-radius:6px}'
        +'.wrap{overflow-x:auto;border:1px solid #eee;border-radius:8px}'
        +'table{border-collapse:collapse;font-size:11px;white-space:nowrap;width:100%}'
        +'th,td{border:1px solid #eee;padding:4px 8px;text-align:center}'
        +'th{background:#F3F4F6;position:sticky;top:0}'
        +'tr.total td{font-weight:700;background:#F9FAFB}'
        +'.notice{color:#999;font-size:12px;margin-top:10px}</style></head><body>'
        +'<h2>👤 '+_esc(built.emp.이름)+'님의 근태현황</h2>'
        +'<div class="sub">본인만 조회 가능한 읽기전용 화면이며, 수정은 불가합니다.</div>'
        +'<form class="f2" method="get">'
        +'<input type="hidden" name="action" value="my_att">'
        +'<input type="hidden" name="eid" value="'+_esc(eid)+'">'
        +'<input type="hidden" name="phone4" value="'+_esc(phone4)+'">'
        +'<select name="yr">'+yrOpts+'</select>'
        +'<select name="mo">'+moOpts+'</select>'
        +'<button type="submit">조회</button>'
        +'</form>'
        +'<div class="wrap"><table><thead><tr><th>'+built.header.map(_esc).join('</th><th>')+'</th></tr></thead>'
        +'<tbody>'+rowsHtml+totalHtml+'</tbody></table></div>'
        +'<div class="notice">※ 월별 스케줄 등록으로 개별 조정된 날짜는 반영되지 않을 수 있습니다.</div>'
        +'</body></html>';
      return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }catch(err){
      // 🔧 임시 디버그 — 원인 파악 후 제거 예정. 화면에 에러를 그대로 띄워서 바로 확인.
      const msg='표를 만드는 중 오류가 발생했습니다.\n\n'+String(err)+'\n\n'+(err && err.stack || '');
      return HtmlService.createHtmlOutput('<pre style="white-space:pre-wrap;font-size:13px;padding:20px;color:#DC2626">'+_esc(msg)+'</pre>').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    }
  }

  // ── "나의 근태현황" JSON API (JSONP) ──
  // ★ 별도 정적 페이지(MY_ATT_PAGE_URL)가 이 엔드포인트를 <script> 태그로 호출해서 데이터만 받아갑니다.
  //   handleMyAttGet과 로그인/조회 로직은 동일하고, HTML 대신 JSON을 콜백으로 감싸서 반환합니다.
  function _jsonp(cb, obj){
    return ContentService.createTextOutput(cb+'('+JSON.stringify(obj)+')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  function handleMyAttApi(e){
    const p=(e && e.parameter) || {};
    const cb=p.callback || 'callback';
    const eid=(p.eid||'').trim();
    const phone4=(p.phone4||'').trim();
    if(!eid || !phone4){
      return _jsonp(cb, {ok:false, error:'사번과 휴대폰 뒷자리를 입력해주세요.'});
    }
    if(!_loginAttemptsOk(eid)){
      return _jsonp(cb, {ok:false, error:'로그인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.'});
    }
    const {employees, contracts} = _loadBase();
    const emp=employees.find(x=>x.사번===eid);
    const con=contracts.filter(c=>c.사번===eid && c.구분!=='퇴사').sort((a,b)=>new Date(b.cs)-new Date(a.cs))[0];
    const phone=(con && con.phone) || (emp && emp.phone) || '';
    const digits=String(phone).replace(/[^0-9]/g,'');
    if(!emp || digits.slice(-4)!==phone4){
      _recordLoginFail(eid);
      return _jsonp(cb, {ok:false, error:'사번 또는 휴대폰 번호가 일치하지 않습니다.'});
    }
    _clearLoginFail(eid);
    try{
      const now=new Date();
      const yr=Number(p.yr)||now.getFullYear();
      const mo=Number(p.mo)||(now.getMonth()+1);
      const built=_buildAttTableData(eid, yr, mo, employees, contracts);
      return _jsonp(cb, {ok:true, name:built.emp.이름, yr:yr, mo:mo, header:built.header, rows:built.rows, totalRow:built.totalRow});
    }catch(err){
      return _jsonp(cb, {ok:false, error:'표를 만드는 중 오류가 발생했습니다: '+String(err)});
    }
  }

  // ── Slack Interactivity 진입점 ── (잔여연차 확인/사번 확인 버튼 처리 — 내 근태현황 보기는 url 버튼이라 여길 안 거침)
  function handlePost(e){
    try{
      const payload=JSON.parse(e.parameter.payload);
      if(payload.type!=='block_actions') return ContentService.createTextOutput('');
      const action=payload.actions && payload.actions[0];
      if(!action) return ContentService.createTextOutput('');
      const slackUserId=payload.user && payload.user.id;
      if(action.action_id==='somyung_view_leave'){
        handleViewLeave(slackUserId);
      }else if(action.action_id==='somyung_view_eid'){
        handleViewEid(slackUserId);
      }
    }catch(err){
      Logger.log('SomyungBtn doPost 오류: '+err);
    }
    return ContentService.createTextOutput('');
  }

  return { handlePost, handleMyAttGet, handleMyAttApi };
})();

// ── 프로젝트 최상위 진입점 ──
// ★ 이미 프로젝트에 doPost(e)가 있다면, 아래 한 줄을 그 함수 안으로 옮겨 병합하세요.
function doPost(e){
  return SomyungBtn.handlePost(e);
}
// ★ 기존 doGet(e)의 맨 앞에 아래 분기를 추가하세요 (slack_post 분기보다 위든 아래든 상관없습니다):
//   if(e.parameter.action==='my_att'){
//     return SomyungBtn.handleMyAttGet(e);
//   }
//   if(e.parameter.action==='my_att_api'){
//     return SomyungBtn.handleMyAttApi(e);
//   }
