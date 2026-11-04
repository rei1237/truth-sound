@echo off
chcp 65001 >nul
title Truth Sound
cd /d "%~dp0"

where uv >nul 2>nul
if errorlevel 1 (
  echo uv가 설치되어 있지 않습니다. Truth Sound를 실행하려면 먼저 uv를 설치해야 합니다.
  echo PowerShell을 열고 아래 명령을 붙여 넣은 뒤, 이 창을 닫고 다시 실행하세요.
  echo.
  echo   powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
  echo.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo 처음 실행이라 필요한 프로그램을 설치합니다. 인터넷 연결이 필요하고 몇 분에서 수십 분 걸립니다.
  uv sync --frozen
  if errorlevel 1 (
    echo.
    echo 설치하지 못했습니다. 인터넷 연결과 디스크 빈 공간을 확인하고 다시 실행하세요.
    pause
    exit /b 1
  )
)

uv run --frozen python -m truth_sound
if errorlevel 1 (
  echo.
  echo Truth Sound가 오류로 멈췄습니다. 위 내용을 확인하세요.
  pause
)
