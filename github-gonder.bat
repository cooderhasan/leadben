@echo off
chcp 65001 >nul
cd /d "%~dp0"
title AI Sales OS - GitHub'a gonder
echo.
echo Kod GitHub'a gonderiliyor (cooderhasan/lead)...
echo.
where git >nul 2>&1
if errorlevel 1 (
  echo [HATA] Git bulunamadi. https://git-scm.com adresinden kurun.
  pause
  exit /b 1
)
if exist "ai-sales-os.bundle" (
  if not exist ".git" (
    git init -q -b main
    git remote add origin https://github.com/cooderhasan/lead.git
  )
  git fetch -q ai-sales-os.bundle main
  git reset -q --hard FETCH_HEAD
  del ai-sales-os.bundle
)
git remote get-url origin >nul 2>&1 || git remote add origin https://github.com/cooderhasan/lead.git
git push -u origin main
if errorlevel 1 (
  echo.
  echo [HATA] Gonderilemedi. GitHub giris penceresi acildiysa giris yapip tekrar deneyin.
  echo        Depoda baska commit varsa bu pencerenin ekran goruntusunu Claude'a gonderin.
  pause
  exit /b 1
)
echo.
echo TAMAM - kod GitHub'da. Simdi Coolify'da deploy edebilirsiniz.
pause
