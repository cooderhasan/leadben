# AI Sales OS

> **Siz ürününüzü anlatın. Müşteriyi AI bulsun.**
> Çok kiracılı, AI destekli B2B satış operasyon platformu. İlk pilot firma: **Aktif Yay** (yalnızca demo verisi).

Bu depo **Faz 1**'i içerir: kimlik doğrulama, çok kiracılı veritabanı, "Önce şirketini tanıyalım" kurulumu,
web sitesi AI analizi ("Firmayı böyle anladım" → Onayla / Düzelt), ürün yönetimi, bilgi bankası (PDF/katalog),
şirket hafızası, kredi sistemi, audit log ve platform yönetici paneli. Veritabanı şeması 5 fazın tamamını kapsar.

Planlar: [Mimari](docs/01-MIMARI-PLAN.md) · [Veritabanı](docs/02-VERITABANI-PLAN.md) · [API](docs/03-API-PLAN.md) · [Arayüz](docs/04-UI-PLAN.md) · [AI araçları](docs/05-AI-TOOL-PLAN.md)

---

## Sunucuya kurulum (Coolify)

Bkz. **[COOLIFY.md](COOLIFY.md)** — `lead.aktifyay.com.tr` için adım adım.

## Yerel kurulum (Windows)

Gerekenler: **Node.js 20.9+** (22 önerilir), **Docker Desktop** (Postgres + Redis için), Git.

```powershell
# 1) Bağımlılıklar
npm install

# 2) Ortam dosyası
copy .env.example .env
#   .env içinde ANTHROPIC_API_KEY değerini doldurun (AI olmadan da çalışır; analiz adımları devre dışı kalır)

# 3) Veritabanı (Postgres + pgvector, Redis)
docker compose up -d

# 4) Tablolar + demo verisi
npm run db:deploy
npm run db:seed

# 5) Çalıştır
npm run dev
```

Tarayıcı: http://localhost:3000

| Hesap | E-posta | Parola |
|---|---|---|
| Demo (Aktif Yay) | `demo@aktifyay.local` | `AktifYay2026demo` |
| Platform yöneticisi | `admin@aisalesos.local` | `AdminSalesOS2026` |

> Production'da `SEED_DEMO_PASSWORD` / `SEED_ADMIN_PASSWORD` ortam değişkenleriyle değiştirin.

> Docker Postgres host portu **55432**'dir (5432/5433 yerel Postgres kurulumlarıyla çakışmasın diye).

Docker kullanmıyorsanız: Postgres 16 + [pgvector](https://github.com/pgvector/pgvector) kurup `DATABASE_URL` ve `TEST_DATABASE_URL`'i ayarlayın.
Redis gerekmez (`QUEUE_DRIVER=inline`).

## Komutlar

| Komut | Açıklama |
|---|---|
| `npm run dev` | Geliştirme sunucusu |
| `npm run build` / `npm start` | Production build / çalıştır |
| `npm run worker` | Arka plan worker'ı (`QUEUE_DRIVER=bullmq` iken) |
| `npm run typecheck` · `npm run lint` · `npm test` | Kontroller |
| `npm run check` | Hepsi + build (her faz sonunda) |
| `npm run db:migrate` | Şema değişikliğinden yeni migration |
| `npm run db:seed` | Demo verisi (tekrar çalıştırılabilir) |

`npm test` ayrı bir test veritabanı kullanır (`TEST_DATABASE_URL`, docker-compose bunu otomatik oluşturur) ve her çalıştırmada temizler.

## Yapılandırma

Tüm ayarlar `.env` — ayrıntı için [.env.example](.env.example).

- **AI**: `AI_PROVIDER=anthropic` (varsayılan) · `openai` · `gemini`. Model `AI_MODEL` ile değişir; koda gömülü değildir.
  Yedek sağlayıcı: `AI_FALLBACK_PROVIDER`.
- **Embedding**: Anthropic embedding sunmadığı için varsayılan `none` → bilgi bankası Postgres tam metin araması kullanır.
  `EMBEDDING_PROVIDER=voyage|openai|gemini` ile vektör araması eklenir.
- **Lead arama**: `APIFY_TOKEN` (Google Haritalar). Boşsa otomatik arama kapalıdır; CSV içe aktarma ve elle ekleme çalışır.
  Tek aramada en fazla `LEAD_SEARCH_MAX` lead (varsayılan 50). Yalnızca **yeni** eklenen lead ücretlendirilir (1 kredi);
  mevcut kayıtla eşleşen lead ücretsizdir, kullanılmayan kredi iade edilir.
- **Kuyruk**: `inline` (geliştirme) · `bullmq` (production; Redis + `npm run worker`).
- **Depolama**: `local` (./storage) · `s3` (MinIO / R2 / S3).

## Mimari özet

```
src/
  app/            Next.js sayfaları, server action'lar (app/actions), route handler'lar (app/api)
  server/
    auth/         scrypt parola, DB oturumu, hız sınırı
    tenancy/      tenantDb(ctx) — her sorguya companyId ekler; yetki tablosu (can)
    ai/           AIProvider soyutlaması, güvenlik kuralları, prompt'lar, maliyet kaydı
    services/     iş mantığı (şirket, bilgi onayı, ürün, bilgi bankası, hafıza…)
    jobs/         kuyruk (inline/BullMQ) + handler'lar
    web/          SSRF korumalı site tarayıcı (robots.txt'ye uyar)
    knowledge/    metin çıkarma, parçalama, arama (FTS + opsiyonel pgvector)
    providers/    Storage, LeadSource (Faz 2), Email (Faz 3) sözleşmeleri
  worker/         BullMQ worker süreci
prisma/           şema, migration, seed
tests/            birim + gerçek Postgres entegrasyon testleri
```

### Güvenlik ve uyum ilkeleri (koda gömülü)
- **Tenant izolasyonu**: servisler Prisma'ya yalnızca `tenantDb(ctx)` ile erişir (ESLint kuralı). Testler başka şirketin verisini okuma/yazma/silme girişimlerini doğrular.
- **AI uydurmaz**: AI çıktısı `PENDING` kaydedilir; kaynakta kanıtı olmayan sertifika/kapasite/fiyat atılır; satış bağlamı yalnızca onaylı bilgiyi kullanır.
- **Spam motoru değil**: toplu gönderim insan onaylı olacak; suppression listesi ve compliance durumu şemada hazır (Faz 3).
- Instagram/WhatsApp/LinkedIn şifresi hiçbir yerde istenmez.

## Yol haritası

| Faz | İçerik | Durum |
|---|---|---|
| 1 | Setup, auth, DB, multi-tenancy, onboarding, şirket profili, ürünler, bilgi bankası, web sitesi analizi | ✅ |
| 2 | Lead modeli, Apify provider, doğal dil lead arama, dedupe, enrichment, scoring, sinyaller, CSV içe aktarma | ✅ |
| 3 | Kampanya, AI strateji, mesaj üretimi, compliance, suppression, e-posta sağlayıcı, onay, gönderim | ✅ (hatırlatma adımları Faz 4) |
| 4 | Yanıt sınıflandırma, follow-up, CRM, görevler, analitik, AI rapor, AI asistan | ✅ |
| 5 | Teklif asistanı, rakip istihbaratı, WhatsApp Business (resmi API), REST API + webhook | ✅ |
