-- ============================================================
-- 관제센터 ERP (hr_cx_manage / hr_cx_manage_de) 스키마
-- 2단계 계획서 기준. pgAdmin4 Query Tool에서 대상 DB(먼저 hr_cx_manage_de)에
-- 접속한 상태로 이 파일 전체를 실행하세요. CREATE DATABASE는 포함하지 않았습니다
-- (DB 자체는 pgAdmin에서 먼저 만들어 두세요 — hr_cx_manage_de, 나중에 hr_cx_manage).
-- ============================================================

-- updated_at 자동 갱신 트리거 함수 (모든 테이블 공용)
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
 NEW.updated_at = now();
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ------------------------------------------------------------
-- employees
-- ------------------------------------------------------------
CREATE TABLE employees (
 "사번" TEXT PRIMARY KEY,
 "no" INTEGER NOT NULL,
 "gbu" TEXT NOT NULL DEFAULT '근로소득',
 "구분" TEXT,
 "경로" TEXT,
 "이름" TEXT NOT NULL,
 "소속" TEXT,
 "입사" TEXT,
 "퇴사" TEXT,
 "임금" TEXT,
 "시급" INTEGER NOT NULL DEFAULT 0,
 "기본" INTEGER NOT NULL DEFAULT 0,
 "식대" INTEGER NOT NULL DEFAULT 0,
 "직책" INTEGER NOT NULL DEFAULT 0,
 "cs" TEXT,
 "ce" TEXT,
 "st" TEXT NOT NULL DEFAULT '09:00',
 "et" TEXT NOT NULL DEFAULT '18:00',
 "소정" NUMERIC(5,2) NOT NULL DEFAULT 40,
 "휴게" NUMERIC(4,2) NOT NULL DEFAULT 1,
 "월소정" NUMERIC(6,2) NOT NULL DEFAULT 209,
 "updated" TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_employees_updated_at BEFORE UPDATE ON employees
 FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- contracts — PK를 no(정수)로 채택 (2단계 계획서 1-2절 근거: meta.docLinks/quitReasons가
-- 이미 no를 식별자로 참조 중, 사번이 나중에 부여돼도 no는 불변이라 _dbKey 추적 불필요해짐)
-- ------------------------------------------------------------
CREATE TABLE contracts (
 "no" INTEGER PRIMARY KEY,
 "key" TEXT NOT NULL, -- 구 PK 호환용 일반 컬럼(디버깅/조회 편의), UNIQUE 아님
 "사번" TEXT,
 "이름" TEXT NOT NULL,
 "구분" TEXT,
 "발송" TEXT,
 "type" TEXT,
 "소속" TEXT,
 "직책구분" TEXT NOT NULL DEFAULT '구성원',
 "입사" TEXT,
 "퇴사" TEXT,
 "임금" TEXT,
 "시급" INTEGER,
 "기본" INTEGER NOT NULL DEFAULT 0,
 "식대" INTEGER NOT NULL DEFAULT 0,
 "직책" INTEGER NOT NULL DEFAULT 0,
 "야간" INTEGER NOT NULL DEFAULT 0,
 "cs" TEXT,
 "ce" TEXT,
 "st" TEXT NOT NULL DEFAULT '09:00',
 "et" TEXT NOT NULL DEFAULT '18:00',
 "소정" NUMERIC(5,2) NOT NULL DEFAULT 40,
 "휴게" NUMERIC(4,2) NOT NULL DEFAULT 1,
 "mon" TEXT, "tue" TEXT, "wed" TEXT, "thu" TEXT, "fri" TEXT, "sat" TEXT, "sun" TEXT,
 "email" TEXT,
 "phone" TEXT,
 "slackId" TEXT,
 "updated" TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_contracts_사번 ON contracts ("사번");
CREATE TRIGGER trg_contracts_updated_at BEFORE UPDATE ON contracts
 FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- att_data
-- ------------------------------------------------------------
CREATE TABLE att_data (
 "key" TEXT PRIMARY KEY, -- "사번_YYYY-MM-DD"
 "emp_id" TEXT NOT NULL,
 "date" TEXT NOT NULL,
 "in" TEXT,
 "out" TEXT,
 "source" TEXT,
 "locked" BOOLEAN NOT NULL DEFAULT false,
 "updated" TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_att_data_emp_id ON att_data ("emp_id");
CREATE INDEX idx_att_data_date ON att_data ("date");
CREATE TRIGGER trg_att_data_updated_at BEFORE UPDATE ON att_data
 FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- slack_data (원본 데이터 — 절대 삭제하지 않는 테이블)
-- ------------------------------------------------------------
CREATE TABLE slack_data (
 "key" TEXT PRIMARY KEY,
 "emp_id" TEXT NOT NULL,
 "date" TEXT NOT NULL,
 "in" TEXT,
 "out" TEXT,
 "updated" TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_slack_data_emp_date ON slack_data ("emp_id", "date");
CREATE TRIGGER trg_slack_data_updated_at BEFORE UPDATE ON slack_data
 FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- hr_saved
-- ------------------------------------------------------------
CREATE TABLE hr_saved (
 "key" TEXT PRIMARY KEY, -- "사번_YYYY_MM"
 "emp_id" TEXT NOT NULL,
 "yr" INTEGER NOT NULL,
 "mo" INTEGER NOT NULL,
 "days_json" JSONB NOT NULL,
 "updated" TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_hr_saved_yr_mo ON hr_saved ("yr", "mo");
CREATE TRIGGER trg_hr_saved_updated_at BEFORE UPDATE ON hr_saved
 FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- meta (key-value, value는 JSONB — API가 응답 시 문자열로 재직렬화해서 내려줌)
-- ------------------------------------------------------------
CREATE TABLE meta (
 "key" TEXT PRIMARY KEY,
 "value" JSONB NOT NULL,
 "updated" TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_meta_updated_at BEFORE UPDATE ON meta
 FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- sched_saved
-- ------------------------------------------------------------
CREATE TABLE sched_saved (
 "key" TEXT PRIMARY KEY, -- "사번_YYYY_MM"
 "emp_id" TEXT NOT NULL,
 "yr" INTEGER NOT NULL,
 "mo" INTEGER NOT NULL,
 "days_json" JSONB NOT NULL,
 "updated" TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sched_saved_yr_mo ON sched_saved ("yr", "mo");
CREATE TRIGGER trg_sched_saved_updated_at BEFORE UPDATE ON sched_saved
 FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- overtime_requests (MYPAGE 연장/휴일근무요청서 — 구성원 신청, HR 승인/거절)
-- ------------------------------------------------------------
CREATE TABLE overtime_requests (
 id BIGSERIAL PRIMARY KEY,
 "emp_id" TEXT NOT NULL,
 "emp_name" TEXT,
 "work_date" TEXT NOT NULL,
 "req_type" TEXT NOT NULL,
 "start_time" TEXT,
 "end_time" TEXT,
 "hours" NUMERIC(4,2),
 "reason" TEXT,
 "status" TEXT NOT NULL DEFAULT '대기중',
 "reviewed_by" TEXT,
 "reviewed_at" TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_overtime_requests_emp_id ON overtime_requests ("emp_id");
CREATE TRIGGER trg_overtime_requests_updated_at BEFORE UPDATE ON overtime_requests
 FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- login_fails (MYPAGE 사번+휴대폰 자가 로그인 계정 잠금 — 제네릭 /api/:table 화이트리스트에는
-- 절대 추가하지 않는다. auth.js 내부에서만 조회/갱신)
-- ------------------------------------------------------------
CREATE TABLE login_fails (
 "id" TEXT PRIMARY KEY,
 "fail_count" INTEGER NOT NULL DEFAULT 0,
 "locked_until" TIMESTAMPTZ,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- audit_log (2단계 계획서 2-6절 — 급여확정/해제, 계정 추가/삭제/권한변경,
-- 계약삭제, 근태확정/해제 최소 5개 액션 기록용)
-- ------------------------------------------------------------
CREATE TABLE audit_log (
 id BIGSERIAL PRIMARY KEY,
 actor_id TEXT,
 actor_name TEXT,
 action TEXT NOT NULL,
 target_type TEXT,
 target_id TEXT,
 detail JSONB,
 ip TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_log_action ON audit_log ("action");
CREATE INDEX idx_audit_log_created_at ON audit_log ("created_at");

-- ------------------------------------------------------------
-- session (express-session 저장소 — connect-pg-simple 공식 스키마 그대로)
-- ------------------------------------------------------------
CREATE TABLE "session" (
 "sid" VARCHAR NOT NULL COLLATE "default",
 "sess" JSON NOT NULL,
 "expire" TIMESTAMP(6) NOT NULL
);
ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX "IDX_session_expire" ON "session" ("expire");
