# gwangjae ERP 백엔드 (hr_cx_manage API)

관제센터 ERP(`gwangjae_v222.html`)가 지금 직접 호출하는 Supabase REST/Realtime을 대체하는
사내 API 서버. 2단계 계획서 기준으로 만들었고, PostgREST 필터 문법(`eq`/`like`/`in`)을 그대로
받아주도록 설계해서 프론트엔드 쪽 수정 범위를 최소화하는 것이 목표.

## 1. DB 준비 (pgAdmin4에서, 코드 실행 전에 사람이 직접 해야 하는 부분)

1. `10.10.70.115`의 PostgreSQL 18 서버에서 `hr_cx_manage_de` 데이터베이스를 새로 생성.
2. `db/create_role.sql`을 열어 `CHANGE_ME`를 실제 비밀번호로 바꾼 뒤 실행 (postgres 관리자 계정으로,
   `hr_cx_manage_de`에 접속한 상태에서). 이 프로젝트 전용 최소권한 계정 `hr_cx_manage_app`이 생김.
   **바꾼 비밀번호는 어디에도 커밋하지 말고, 아래 3번의 `.env`에만 넣으세요.**
3. `db/schema.sql`을 `hr_cx_manage_de`에 접속한 상태로 전체 실행 — 7개 테이블 + `audit_log` +
   `session`(로그인 세션 저장용) 테이블이 생성됨.
4. 운영 전환 시점에는 `hr_cx_manage`(dev 없는 이름)에도 1~3을 동일하게 반복.

## 2. 서버 설정

```bash
cd backend
cp .env.example .env
# .env를 열어 PGPASSWORD, SESSION_SECRET 등 실제 값 채우기
npm install
npm run dev   # nodemon으로 코드 변경 시 자동 재시작 (개발용)
# 또는
npm start     # 그냥 실행
```

`http://localhost:4000/healthz` 가 `{"ok":true}`를 반환하면 서버 자체는 정상 기동된 것.
(DB 연결/테이블은 아직 안 건드린 상태라, DB 관련 API는 위 1번을 마쳐야 정상 동작합니다.)

## 3. 계정 만들기 (최초 로그인용)

지금은 DB에 계정이 하나도 없는 상태라 로그인이 불가능합니다. 서버가 켜진 상태에서 최초 관리자
계정을 만드는 방법 두 가지:

- **A안(임시, 로컬에서 1회성으로)**: Node REPL이나 별도 스크립트로 `bcryptjs`를 이용해 비밀번호를
  해시한 뒤, `meta` 테이블의 `accounts` 키에 직접 INSERT (pgAdmin Query Tool에서).
- **B안(5단계 데이터 이관 때)**: Supabase의 기존 `meta.accounts`(평문 비밀번호)를 이관하면서
  일괄 bcrypt 해시로 변환하는 스크립트를 5단계에서 따로 준비합니다. 지금은 아직 하지 않았습니다.

## 4. 아직 안 되어 있는 것 (3단계 순서상 다음 할 일)

- `gwangjae_v222.html`의 `_sbSelect`/`_sbUpsert`/`_sbReplace`가 이 서버를 바라보도록 바꾸는 작업
  (3단계 순서의 (1)번) — 아직 시작 안 함.
- 1단계에서 찾은 직접 `fetch(SB_URL...)` 10곳을 이 서버의 `/api/:table` 형식으로 바꾸는 작업
  ((2)번) — 아직 시작 안 함.
- 실시간 동기화(WebSocket) — 이 백엔드는 아직 WebSocket을 안 띄움 ((3)번에서 추가 예정).
- `doLogin()`이 이 서버의 `/api/auth/login`을 호출하도록 바꾸는 작업 ((4)번) — 백엔드 쪽
  `/api/auth/login`·`/api/auth/logout`·`/api/auth/me`·`/api/auth/accounts`는 이미 구현됨.
- hr1~hr13 메뉴별 세부 접근권한 검증(지금은 로그인 여부만 확인, role별/메뉴별 세분화는 미구현).

## 5. 엔드포인트 요약

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/:table?col=eq.X` | 전체/조건 조회 (employees/contracts/att_data/slack_data/hr_saved/meta/sched_saved) |
| POST | `/api/:table` | upsert (body: 객체 또는 배열) |
| DELETE | `/api/:table?col=eq.X` | 조건부 삭제 (필터 없으면 400 — 전체삭제 방지) |
| POST | `/api/auth/login` | `{id, pw}` → 세션 쿠키 발급 |
| POST | `/api/auth/logout` | 세션 종료 |
| GET | `/api/auth/me` | 현재 로그인 사용자 확인 |
| POST | `/api/auth/accounts` | 계정 추가/수정 (HR 권한 필요, 비밀번호 서버측 bcrypt 해시) |
| DELETE | `/api/auth/accounts/:id` | 계정 삭제 (HR 권한 필요) |
| POST | `/api/audit-log` | 급여확정/해제·계약삭제·근태확정/해제 감사로그 기록 (로그인 필요) |

## 6. 사내망 IP 접근 제한

`.env`의 `ALLOWED_NETWORKS`(CIDR, 쉼표 구분, 예: `10.10.0.0/16`)에 해당하지 않는 IP는 화면 로딩부터
API까지 전부 403으로 차단된다(`src/middleware/ipAllowlist.js`, `src/server.js`, `src/realtime.js`
3곳에 적용). localhost(127.0.0.1/::1)와 GAS_API_KEY로 인증된 서버-서버 호출(GAS는 구글 클라우드에서
호출하므로 사내망 IP가 아님)은 예외. `ALLOWED_NETWORKS`를 비워두면 기존처럼 IP로는 막지 않는다.
