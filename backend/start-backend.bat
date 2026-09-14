@echo off
cd /d "%~dp0"
call npm start >> "%~dp0backend-autostart.log" 2>&1
