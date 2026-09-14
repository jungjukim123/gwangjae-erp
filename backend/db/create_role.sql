-- ============================================================
-- hr_cx_manage 전용 최소권한 DB 계정 생성
-- postgres 슈퍼유저나 다른 프로젝트(hr_system 등)와 공용으로 쓰는 계정을 쓰지 않기 위해,
-- 이 프로젝트 전용 role을 새로 만듭니다. pgAdmin4에서 postgres(또는 관리자) 계정으로
-- 접속한 상태로 실행하세요. 비밀번호는 반드시 아래 'CHANGE_ME'를 실제 값으로 바꾼 뒤 실행하고,
-- 그 값을 backend/.env의 PGPASSWORD에 넣으세요(이 SQL 파일 자체는 커밋해도 되지만, 실행 전
-- CHANGE_ME를 실제 비밀번호로 바꾼 "실행한 버전"은 어디에도 저장/커밋하지 마세요).
-- ============================================================

CREATE ROLE hr_cx_manage_app WITH LOGIN PASSWORD 'CHANGE_ME';

-- hr_cx_manage_de(개발), hr_cx_manage(운영, 나중에) 각각에 대해 접속 후 아래 2줄을 실행
GRANT CONNECT ON DATABASE hr_cx_manage_de TO hr_cx_manage_app;
-- 해당 DB에 접속한 상태로:
GRANT USAGE ON SCHEMA public TO hr_cx_manage_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hr_cx_manage_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hr_cx_manage_app;
-- 이후 schema.sql로 새로 생기는 테이블에도 자동으로 권한이 적용되도록
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hr_cx_manage_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO hr_cx_manage_app;

-- 운영 DB(hr_cx_manage)에도 동일하게 반복 (DB 생성 후)
-- GRANT CONNECT ON DATABASE hr_cx_manage TO hr_cx_manage_app; ... (위와 동일)
