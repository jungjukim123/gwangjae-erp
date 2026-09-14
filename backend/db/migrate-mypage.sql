-- MYPAGE(구성원 자가서비스) 기능 추가용 증분 마이그레이션.
-- 이미 서비스 중인 두 DB(hr_cx_manage_de, hr_cx_manage) 모두에 pgAdmin4 Query Tool에서
-- 이 파일 전체를 실행하세요. schema.sql은 새 DB를 처음 만들 때만 쓰고, 기존 DB에는
-- 이 파일만 추가로 실행하면 됩니다(이미 있는 테이블을 다시 만들지 않음).

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

CREATE TABLE login_fails (
 "id" TEXT PRIMARY KEY,
 "fail_count" INTEGER NOT NULL DEFAULT 0,
 "locked_until" TIMESTAMPTZ,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
