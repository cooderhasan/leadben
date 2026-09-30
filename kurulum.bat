@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title AI Sales OS - Kurulum
echo.
echo ============================================
echo    AI Sales OS - Kurulum
echo ============================================
echo.

echo [1/7] Gerekli programlar kontrol ediliyor...
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo [HATA] Node.js bulunamadi.
  echo        https://nodejs.org adresinden "LTS" surumunu kurun,
  echo        sonra bu dosyayi tekrar calistirin.
  goto :hata
)
where git >nul 2>&1
if errorlevel 1 (
  echo.
  echo [HATA] Git bulunamadi. https://git-scm.com adresinden kurun, sonra tekrar calistirin.
  goto :hata
)
where docker >nul 2>&1
if errorlevel 1 (
  echo.
  echo [HATA] Docker bulunamadi. "Docker Desktop" kurun, acin, sonra tekrar calistirin.
  goto :hata
)
docker info >nul 2>&1
if errorlevel 1 (
  echo.
  echo [HATA] Docker Desktop calismiyor. Docker Desktop'i acin,
  echo        "Engine running" yazana kadar bekleyin, sonra tekrar calistirin.
  goto :hata
)
for /f "delims=" %%v in ('node -v') do echo        Node %%v - tamam
echo        Git ve Docker - tamam
echo.

echo [2/7] Git gecmisi hazirlaniyor...
if exist "ai-sales-os.bundle" (
  if not exist ".git" (
    git init -q -b main
    git remote add origin https://github.com/cooderhasan/lead.git
  )
  git fetch -q ai-sales-os.bundle main
  git reset -q --hard FETCH_HEAD
  del ai-sales-os.bundle
  echo        Tamam.
) else (
  echo        Guncel, atlaniyor.
)
echo.

echo [3/7] Paketler yukleniyor (birkac dakika surebilir)...
call npm install
if errorlevel 1 goto :hata
echo.

echo [4/7] Ayar dosyasi (.env)...
if exist ".env" (
  echo        .env zaten var, dokunulmadi.
) else (
  copy /y ".env.example" ".env" >nul
  echo        .env olusturuldu.
)
rem Veritabani portu 55432 (eski .env dosyalarini da duzelt: 5432/5433 yerel Postgres ile cakisiyordu)
powershell -NoProfile -Command "$p='.env'; $t=[IO.File]::ReadAllText($p); $n=$t.Replace('localhost:5432/','localhost:55432/').Replace('localhost:5433/','localhost:55432/'); if ($n -ne $t) { [IO.File]::WriteAllText($p, $n); Write-Host '       Veritabani portu 55432 olarak guncellendi.' }"
echo.

echo [5/7] Veritabani baslatiliyor (Docker)...
docker compose up -d postgres redis
if errorlevel 1 goto :hata
echo        Veritabaninin hazir olmasi bekleniyor...
set /a tries=0
:bekle
set /a tries+=1
docker compose exec -T postgres pg_isready -U salesos >nul 2>&1
if not errorlevel 1 goto :hazir
if %tries% geq 60 (
  echo [HATA] Veritabani 2 dakikada hazir olmadi.
  goto :hata
)
timeout /t 2 /nobreak >nul
goto :bekle
:hazir
echo        Veritabani hazir.
echo.

echo [6/7] Tablolar ve demo verisi olusturuluyor...
call npm run db:deploy
if errorlevel 1 goto :hata
call npm run db:seed
if errorlevel 1 goto :hata
echo.

echo [7/7] AI anahtari...
findstr /C:"ANTHROPIC_API_KEY=\"\"" ".env" >nul 2>&1
if not errorlevel 1 (
  echo        Anthropic API anahtari henuz girilmemis.
  echo        Simdi Not Defteri acilacak: ANTHROPIC_API_KEY="" satirinda
  echo        tirnaklarin arasina anahtarinizi yapistirin, KAYDEDIN ve kapatin.
  echo        (Anahtarsiz da calisir; sadece AI analizleri kapali olur.)
  echo.
  pause
  notepad ".env"
) else (
  echo        Anahtar girilmis gorunuyor.
)
echo.

echo ============================================
echo    KURULUM TAMAMLANDI
echo ============================================
echo.
echo  Uygulamayi acmak icin:  baslat.bat  dosyasina cift tiklayin.
echo  Giris:  demo@aktifyay.local  /  AktifYay2026demo
echo.

set /p PUSH=Kodu simdi GitHub'a gondermek ister misiniz? (E/H): 
if /i "%PUSH%"=="E" (
  git push -u origin main
  if errorlevel 1 echo [UYARI] Gonderilemedi. GitHub girisi gerekebilir; sonra tekrar deneyin.
)
echo.
pause
exit /b 0

:hata
echo.
echo Kurulum yarida kaldi. Bu pencerenin ekran goruntusunu Claude'a gonderin.
pause
exit /b 1
