// ============================================================
// 근태소명 안내 DM의 "내 근태현황 보기 / 잔여연차 확인" 버튼 처리 (Google Apps Script)
// ============================================================
// 근태소명관리에서 직원 개인에게 발송하는 슬랙 DM 하단에 버튼 2개가 붙습니다
// (gwangjae_v222.html의 _somyungActionBlocks 참고). 직원이 버튼을 누르면 Slack이
// 클릭 이벤트를 이 스크립트의 doPost로 보내주고, 여기서
//   ① 잔여연차 확인 → 슬랙 DM으로 발생/사용/잔여(시간) 안내
//   ② 내 근태현황 보기 → 해당 월 근태 요약을 PDF로 만들어 이메일 발송
// 을 처리합니다.
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
// 5) Slack 앱 설정(https://api.slack.com/apps → 해당 앱 선택)
//    → Interactivity & Shortcuts 켜기 → Request URL에 "배포된 웹 앱 URL"
//    (SLK_POST_GAS_URL과 동일한 exec 주소)을 입력 후 저장
//    ※ 코드를 바꿨다면 배포 → 배포관리 → 수정 → 새 버전으로 재배포해야 반영됩니다.
// 6) 프로젝트 속성에 SLACK_BOT_TOKEN이 이미 등록되어 있어야 합니다(기존 근태소명 발송과 동일 토큰).
// 7) "내 근태현황 보기" 이메일은 계약기간관리에 등록된 이메일(contracts.email)로 발송됩니다.
//    이메일이 비어있는 직원은 안내 메시지만 받고 이메일은 발송되지 않습니다.
// 8) 이메일은 이 스크립트를 실행하는 Google 계정(MailApp) 명의로 발송됩니다.
//
// ── 주의 (알려진 제약) ──
// Google Apps Script Web App은 doPost(e)에서 요청 헤더를 읽을 수 없어 Slack의
// X-Slack-Signature 서명 검증을 할 수 없습니다. Request URL 자체가 추측하기 어려운
// 긴 exec 주소이므로 사내용으로는 허용 가능한 리스크로 보고 진행합니다.
//
// ── 근태현황 이메일 범위 (간략 요약) ──
// 날짜/요일/구분(정상·주휴·연차·반차·결근 등)/출근/퇴근/소정(시간)만 담습니다.
// 야간·연장·휴일연장 등 세부 가산 컬럼은 포함하지 않습니다(화면의 전체 컬럼과 다름).
// ============================================================

const SomyungBtn = (function(){
  const SB_URL = 'https://dcvitbydqidndwbqqprm.supabase.co';
  const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRjdml0YnlkcWlkbmR3YnFxcHJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyMDE1ODMsImV4cCI6MjA5Nzc3NzU4M30.xHDxj8-0jTTOrWTErOMPQB4EvyKhuOsgkPAjAB2txmc';
  const DOW_KEYS = ['sun','mon','tue','wed','thu','fri','sat'];
  const DOW_LABEL = ['일','월','화','수','목','금','토'];

  function _getSlackToken(){
    return PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN') || '';
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
  function _postSlackDM(slackId, text){
    const token=_getSlackToken();
    const res=UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
      method:'post', contentType:'application/json',
      headers:{ Authorization:'Bearer '+token },
      payload: JSON.stringify({ channel:slackId, text:text, mrkdwn:true }),
      muteHttpExceptions:true
    });
    const json=JSON.parse(res.getContentText());
    if(!json.ok) Logger.log('Slack 발송 실패 ('+slackId+'): '+json.error);
    return json.ok;
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
    const 총발생=Math.round(rows.reduce((a,r)=>a+r.발생,0)*100)/100;
    const 총사용=Math.round(rows.reduce((a,r)=>a+r.사용,0)*100)/100;
    const 총잔여=Math.round((총발생-총사용)*100)/100;
    const DIV='────────────────────────────';
    const text='안녕하세요, 피플팀입니다 😊\n\n'
      +'*'+(emp?emp.이름:eid)+'*님이 요청하신 잔여연차 현황을 안내드립니다.\n\n'
      +DIV+'\n📌 *[잔여연차 안내]* '+now.getFullYear()+'년 '+String(now.getMonth()+1).padStart(2,'0')+'월 기준\n\n'
      +'• 발생: '+총발생+'시간\n'
      +'• 사용: '+총사용+'시간\n'
      +'• 잔여: '+총잔여+'시간\n'
      +DIV+'\n\n※ 상세 내역은 관제센터 프로그램 > 연차현황에서 확인하실 수 있습니다.\n'
      +'궁금하신 점은 담당자(@김정주)에게 편하게 연락 주세요!\n\n'
      +'감사합니다.\n피플팀 드림';
    _postSlackDM(slackUserId, text);
  }

  // ── ② 내 근태현황 보기 (이메일 PDF, 간략 요약) ──
  function handleViewAttendance(eid, ck, slackUserId){
    const [yrStr, moStr] = (ck||'').split('_');
    const yr=Number(yrStr), mo=Number(moStr);
    if(!yr || !mo){ _postSlackDM(slackUserId, '⚠️ 조회할 월 정보를 확인할 수 없습니다. 담당자(@김정주)에게 문의해주세요.'); return; }
    const {employees, contracts} = _loadBase();
    const emp=employees.find(e=>e.사번===eid);
    const con=contracts.filter(c=>c.사번===eid && c.구분!=='퇴사').sort((a,b)=>new Date(b.cs)-new Date(a.cs))[0];
    if(!emp){ _postSlackDM(slackUserId, '⚠️ 직원 정보를 찾을 수 없습니다. 담당자(@김정주)에게 문의해주세요.'); return; }
    const email=(con && con.email) || emp.email || '';
    if(!email){ _postSlackDM(slackUserId, '⚠️ 등록된 이메일이 없어 발송하지 못했습니다.\n② 계약기간관리에 이메일 등록 후 다시 시도해주세요.\n담당자(@김정주)에게 문의해주세요.'); return; }

    const first=dStr(yr,mo,1), last=dStr(yr,mo,dim(yr,mo));
    const attRows=sbSelect('att_data', 'emp_id=eq.'+encodeURIComponent(eid)+'&date=gte.'+first+'&date=lte.'+last);
    const attByDate={}; attRows.forEach(r=>{ attByDate[r.date]=r; });
    const hrSavedRows=sbSelect('hr_saved', 'emp_id=eq.'+encodeURIComponent(eid)+'&yr=eq.'+yr+'&mo=eq.'+mo);
    const bigoByDate={};
    hrSavedRows.forEach(r=>{
      JSON.parse(r.days_json||'[]').forEach(d=>{ if(d.date) bigoByDate[d.date]=d.bigo||''; });
    });

    const dayCount=dim(yr,mo);
    const table=[['날짜','요일','구분','출근','퇴근','소정(시간)']];
    for(let d=1; d<=dayCount; d++){
      const ds=dStr(yr,mo,d);
      const dow=new Date(ds+'T00:00:00').getDay();
      const att=attByDate[ds];
      const bigo=bigoByDate[ds]||'';
      const sched=getSchedSojeong(eid, ds, contracts, employees);
      const gubun=bigo || (sched==='주휴' ? '주휴' : '정상');
      table.push([ds, DOW_LABEL[dow], gubun, (att&&att.in)||'-', (att&&att.out)||'-', sched==='주휴'?'주휴':sched]);
    }

    const title=emp.이름+' '+yr+'년 '+mo+'월 근태현황';
    const pdfBlob=_buildPdf(title, table);
    MailApp.sendEmail({
      to: email,
      subject: '['+yr+'년 '+mo+'월] '+emp.이름+'님 근태현황',
      body: emp.이름+'님, 안녕하세요. 피플팀입니다.\n\n요청하신 '+yr+'년 '+mo+'월 근태현황을 첨부파일로 보내드립니다.\n(간략 요약본이며, 세부 가산 내역은 관제센터 프로그램에서 확인해주세요)\n\n감사합니다.\n피플팀 드림',
      attachments: [pdfBlob]
    });
    _postSlackDM(slackUserId, '📧 '+yr+'년 '+mo+'월 근태현황을 '+email+'로 발송했습니다. 확인 부탁드립니다!');
  }

  // 표 데이터를 임시 Google Sheet로 만들어 PDF Blob으로 변환 후 시트는 삭제
  function _buildPdf(title, table){
    const ss=SpreadsheetApp.create('tmp_'+title+'_'+Date.now());
    const sheet=ss.getSheets()[0];
    sheet.getRange(1,1,table.length,table[0].length).setValues(table);
    sheet.getRange(1,1,1,table[0].length).setFontWeight('bold');
    sheet.autoResizeColumns(1, table[0].length);
    SpreadsheetApp.flush();
    const url=ss.getUrl().replace(/edit$/,'')
      +'export?format=pdf&size=A4&portrait=true&fitw=true&gridlines=true&printtitle=false&sheetnames=false&pagenumbers=false&gid='+sheet.getSheetId();
    const token=ScriptApp.getOAuthToken();
    const res=UrlFetchApp.fetch(url, { headers:{ Authorization:'Bearer '+token } });
    const blob=res.getBlob().setName(title+'.pdf');
    DriveApp.getFileById(ss.getId()).setTrashed(true); // 임시 시트 삭제
    return blob;
  }

  // ── Slack Interactivity 진입점 ──
  function handlePost(e){
    try{
      const payload=JSON.parse(e.parameter.payload);
      if(payload.type!=='block_actions') return ContentService.createTextOutput('');
      const action=payload.actions && payload.actions[0];
      if(!action) return ContentService.createTextOutput('');
      const slackUserId=payload.user && payload.user.id;
      if(action.action_id==='somyung_view_leave'){
        handleViewLeave(slackUserId);
      }else if(action.action_id==='somyung_view_att'){
        const [eid, ck]=(action.value||'').split('|');
        handleViewAttendance(eid, ck, slackUserId);
      }
    }catch(err){
      Logger.log('SomyungBtn doPost 오류: '+err);
    }
    return ContentService.createTextOutput('');
  }

  return { handlePost };
})();

// ── 프로젝트 최상위 진입점 ──
// ★ 이미 프로젝트에 doPost(e)가 있다면, 아래 한 줄을 그 함수 안으로 옮겨 병합하세요.
function doPost(e){
  return SomyungBtn.handlePost(e);
}
