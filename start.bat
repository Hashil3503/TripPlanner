@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js가 필요합니다. https://nodejs.org 에서 Node.js 22.13 이상^(권장 24^)을 설치한 뒤 다시 실행하세요.
  pause
  exit /b 1
)

rem ---- 카카오 키: 사용자 환경변수에 한 번만 등록하면 이후 자동으로 사용 ----
if not defined TP_KAKAO_JS_KEY call :askkey TP_KAKAO_JS_KEY "카카오 JavaScript 키(지도·장소 검색)"
if not defined TP_KAKAO_REST_KEY call :askkey TP_KAKAO_REST_KEY "카카오 REST API 키(대중교통 경로·요금)"

echo 여행 플래너를 http://localhost:8000 에서 실행합니다. 종료하려면 이 창을 닫거나 Ctrl+C를 누르세요.
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:8000"
node server.js
if errorlevel 1 pause
exit /b

:askkey
echo.
echo [%~1] %~2 가 설정되어 있지 않습니다.
echo   카카오 개발자 콘솔 ^> 앱 ^> 플랫폼 키 에서 복사해 붙여 넣으세요. 비워 두면 이번에는 키 없이 실행합니다.
set "KEYVAL="
set /p "KEYVAL=  키 입력: "
if not defined KEYVAL exit /b
rem 현재 실행에 바로 적용하고(set), 다음 실행부터도 쓰이도록 사용자 환경변수에 저장(setx)
set "%~1=%KEYVAL%"
setx %~1 "%KEYVAL%" >nul
echo   저장했습니다. 키를 바꾸려면 이 명령을 다시 쓰거나 Windows 환경 변수 설정에서 수정하세요: setx %~1 "새 키"
set "KEYVAL="
exit /b
