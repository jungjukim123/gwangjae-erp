// 7개 테이블의 컬럼/PK/JSON컬럼 화이트리스트.
// GET/POST/DELETE 핸들러가 여기 없는 테이블명·컬럼명은 전부 거부한다(SQL 인젝션 방지 + 오타 방지).
// 2단계 계획서(backend/db/schema.sql)와 반드시 1:1로 맞춰서 유지할 것.

const TABLES = {
  employees: {
    pk: '사번',
    columns: ['사번','no','gbu','구분','경로','이름','소속','입사','퇴사','임금',
      '시급','기본','식대','직책','cs','ce','st','et','소정','휴게','월소정','updated'],
    json: [],
  },
  contracts: {
    pk: 'no',
    columns: ['no','key','사번','이름','구분','발송','type','소속','직책구분','입사','퇴사',
      '임금','시급','기본','식대','직책','야간','cs','ce','st','et','소정','휴게',
      'mon','tue','wed','thu','fri','sat','sun','email','phone','slackId','updated'],
    json: [],
  },
  att_data: {
    pk: 'key',
    columns: ['key','emp_id','date','in','out','source','locked','updated'],
    json: [],
  },
  slack_data: {
    pk: 'key',
    columns: ['key','emp_id','date','in','out','updated'],
    json: [],
  },
  hr_saved: {
    pk: 'key',
    columns: ['key','emp_id','yr','mo','days_json','updated'],
    json: ['days_json'],
  },
  meta: {
    pk: 'key',
    columns: ['key','value','updated'],
    json: ['value'],
  },
  sched_saved: {
    pk: 'key',
    columns: ['key','emp_id','yr','mo','days_json','updated'],
    json: ['days_json'],
  },
};

module.exports = { TABLES };
