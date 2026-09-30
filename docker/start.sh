#!/bin/sh
# Konteyner açılışı: migration → (isteğe bağlı) demo verisi → uygulama
set -e
cd /app

echo "[start] Veritabanı migration'ları uygulanıyor…"
npx prisma migrate deploy

if [ "${SEED_ON_START:-true}" = "true" ]; then
  echo "[start] Demo verisi kontrol ediliyor (tekrar çalıştırılabilir)…"
  npx prisma db seed || echo "[start] UYARI: seed başarısız, uygulama yine de açılıyor."
fi

echo "[start] Uygulama başlıyor (port ${PORT:-3000})…"
exec npx next start -p "${PORT:-3000}" -H 0.0.0.0
