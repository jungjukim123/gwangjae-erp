@echo off
cd /d "%~dp0"
node dev-static-server.js >> "%~dp0static-server-autostart.log" 2>&1
