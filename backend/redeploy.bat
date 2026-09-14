@echo off
setlocal
cd /d "%~dp0.."

echo ============================================
echo [1/5] 최신 코드 받는 중...
echo ============================================
git pull
if errorlevel 1 (
  echo.
  echo git pull 실패 - 위 메시지를 확인해주세요.
  pause
  exit /b 1
)

echo.
echo ============================================
echo [2/5] 기존 백엔드 종료 중...
echo ============================================
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :4000 ^| findstr LISTENING') do (
  echo 종료: PID %%p
  taskkill /PID %%p /F >nul 2>&1
)
timeout /t 2 /nobreak >nul

echo.
echo ============================================
echo [3/5] 패키지 확인 중...
echo ============================================
cd backend
call npm install --silent

echo.
echo ============================================
echo [4/5] 백엔드 재시작 중...
echo ============================================
wscript.exe start-backend-hidden.vbs
timeout /t 3 /nobreak >nul

echo.
echo ============================================
echo [5/5] 상태 확인 중...
echo ============================================
powershell -NoProfile -Command "try { $r = Invoke-RestMethod http://localhost:4000/healthz -TimeoutSec 5; Write-Host '정상 기동됨:' ($r | ConvertTo-Json) } catch { Write-Host '실패 - backend-autostart.log 를 확인하세요.' }"

echo.
echo 완료.
pause
