@echo off
chcp 65001 >nul
cd /d "%~dp0"
title AI Sales OS
docker info >nul 2>&1
if errorlevel 1 (
  echo [HATA] Docker Desktop calismiyor. Acin, bekleyin, sonra tekrar calistirin.
  pause
  exit /b 1
)
docker compose up -d postgres redis
echo.
echo Uygulama baslatiliyor... Tarayici birkac saniye icinde acilacak.
echo Kapatmak icin bu pencerede Ctrl+C yapin.
echo.
start "" cmd /c "timeout /t 12 /nobreak >nul & start http://localhost:3000"
call npm run dev
pause
