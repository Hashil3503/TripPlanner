@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js가 필요합니다. https://nodejs.org 에서 Node.js 22.13 이상^(권장 24^)을 설치한 뒤 다시 실행하세요.
  pause
  exit /b 1
)
echo 여행 플래너를 http://localhost:8000 에서 실행합니다. 종료하려면 이 창을 닫거나 Ctrl+C를 누르세요.
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:8000"
node server.js
if errorlevel 1 pause
