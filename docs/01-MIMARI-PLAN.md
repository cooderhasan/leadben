# 01 — Mimari Plan (Architecture Plan)

> AI Sales OS — çok kiracılı (multi-tenant), AI destekli B2B satış operasyon platformu.
> İlk demo firma: **Aktif Yay** (yalnızca seed verisi; hiçbir özellik ona özel kodlanmaz).

## 1. Ürün döngüsü

```
BUL → ANALİZ ET → ÖNCELİKLENDİR → STRATEJİ GELİŞTİR → TASLAK HAZIRLA → (İNSAN ONAYI) → TAKİP ET → ÖĞREN → SATIŞ EKİBİNİ YÖNLENDİR
```

Sistemin kalbi e-posta değil; **lead intelligence + satış stratejisi + insan onaylı iletişim**.

## 2. Teknoloji seçimleri

| Katman | Seçim | Neden |
|---|---|---|
| Web | Next.js 15 (App Router), React 19, TypeScript 5.9 | Server Components + Server Actions ile tek kod tabanı |
| UI | Tailwind CSS 4, lucide-react ikonlar | Sade, hızlı, mobile-first |
| DB | PostgreSQL 16 + pgvector | İlişkisel veri + vektör arama tek yerde |
| ORM | Prisma 6 | Tip güvenliği, migration |
| Kuyruk | BullMQ + Redis (geliştirmede `inline` sürücü) | Uzun işler HTTP isteği içinde beklemez |
| Dosya | S3 uyumlu depolama (geliştirmede yerel disk sürücüsü) | MinIO / R2 / S3 |
| Doğrulama | zod | Tüm dış girdi ve AI çıktısı şema ile doğrulanır |
| Test | Vitest (birim + gerçek Postgres ile entegrasyon) | |
| AI | `AIProvider` arayüzü — Anthropic (varsayılan), OpenAI, Gemini | Model/sağlayıcı koda gömülmez, `.env` ile seçilir |

## 3. Katmanlar

```
src/
  app/                    → Next.js sayfaları (UI) + route handler'lar (/api)
    (auth)/               → giriş / kayıt
    (app)/                → oturum + aktif şirket gerektiren uygulama
    onboarding/           → "Önce şirketini tanıyalım."
    admin/                → platform yöneticisi
  server/                 → yalnızca sunucuda çalışan iş mantığı
    auth/                 → parola hash, oturum, yetki
    tenancy/              → aktif şirket çözümleme + tenant-scoped Prisma istemcisi
    services/             → domain servisleri (company, product, knowledge, analyzer…)
    ai/                   → AIProvider arayüzü, sağlayıcılar, prompt'lar, güvenlik kuralları
    providers/            → LeadSourceProvider, EmailProvider, StorageProvider
    jobs/                 → kuyruk soyutlaması + job handler'ları
    audit/ usage/         → audit log, kredi ve AI maliyet kaydı
  worker/                 → BullMQ worker süreci (ayrı process)
  components/             → UI bileşenleri
  lib/                    → paylaşılan yardımcılar (istemci+sunucu güvenli)
prisma/                   → schema, migration, seed (Aktif Yay)
```

Kural: **UI → Server Action / Route Handler → Service → tenant-scoped DB**. UI doğrudan Prisma çağırmaz.

## 4. Multi-tenancy ve izolasyon

1. Tüm müşteri verisi tablolarında `companyId` zorunlu alan + index.
2. Servisler Prisma'ya `tenantDb(ctx)` üzerinden erişir: bu Prisma extension'ı tenant modellerinde her `where`'e ve `data`'ya `companyId` ekler; `companyId` değiştirilmeye çalışılırsa hata fırlatır.
3. `ctx` (TenantContext) = `{ userId, companyId, role }` — oturumdan ve `CompanyMember` kaydından **sunucuda** çözülür; istemciden gelen companyId'ye asla güvenilmez.
4. AI prompt'larına yalnızca ilgili şirketin context'i girer (`buildCompanyContext(ctx)` tek giriş noktasıdır).
5. RAG araması SQL seviyesinde `companyId` filtresiyle çalışır.
6. Entegrasyon testi: A şirketi B'nin verisini okuyamaz / güncelleyemez / silemez.
7. İleri sertleştirme (Faz 2+): Postgres Row Level Security.

## 5. Yetkilendirme

- Şirket rolleri: `OWNER`, `ADMIN`, `MEMBER`, `VIEWER`.
- `can(ctx, action)` fonksiyonu tek yetki noktasıdır (ör. `product.write` → MEMBER+, `member.invite` → ADMIN+).
- Platform yöneticisi: `User.isPlatformAdmin`.
- AI tool'ları (Faz 2+) aynı `can()` kontrolünden geçer.

## 6. "Doğrulanmış bilgi" modeli (halüsinasyon önleme)

AI'ın ürettiği her şirket bilgisi **CompanyFact** olarak saklanır:

| alan | açıklama |
|---|---|
| `key` | ör. `certification`, `product_category`, `target_industry` |
| `value` | içerik |
| `source` | `WEBSITE` / `DOCUMENT` / `USER` / `SEED` |
| `sourceRef` | URL veya doküman ID |
| `status` | `PENDING` → `VERIFIED` / `REJECTED` |

- Web sitesi / doküman analizi yalnızca `PENDING` fact üretir.
- Kullanıcı "Onayla" / "Düzelt" der → `VERIFIED` (düzeltilmiş değer ile).
- Satış mesajı, teklif, AI cevap taslağı üreten her prompt **yalnızca VERIFIED fact + aktif ürünler + onaylı doküman parçaları** ile beslenir.
- Fiyat, sertifika, referans müşteri: ilgili VERIFIED fact yoksa AI "bilgi yok" demek zorundadır (sistem prompt'unda kural + çıktı doğrulaması).

## 7. Arka plan işleri

- `JobQueue` arayüzü: `enqueue(type, payload, { companyId })`.
- Sürücüler: `bullmq` (production) ve `inline` (geliştirme/test — aynı handler'ı süreç içinde çalıştırır).
- Her iş DB'de `Job` kaydı olarak izlenir (`QUEUED/RUNNING/SUCCEEDED/FAILED`, deneme sayısı, hata) → UI ilerlemeyi okur, admin başarısız işleri görür.
- Retry: exponential backoff (3 deneme).
- Faz 1 işleri: `website.analyze`, `document.ingest`.

## 8. AI katmanı

- `AIProvider` arayüzü: `generateText`, `extract` (zod şemalı JSON), `classify`, `summarize`, `score`, `embed`.
- Sağlayıcılar: `AnthropicProvider` (varsayılan), `OpenAIProvider`, `GeminiProvider`.
- `AI_PROVIDER`, `AI_MODEL`, `AI_FALLBACK_PROVIDER` ortam değişkenleri.
- Embedding ayrı ayarlanır (`EMBEDDING_PROVIDER=none|openai|gemini|voyage`). Anthropic embedding sunmadığı için varsayılan `none` → bilgi bankası Postgres tam metin araması ile çalışır; embedding açılınca hibrit arama.
- Her AI çağrısı `AIUsageLog`'a yazılır: `companyId, provider, model, operation, inputTokens, outputTokens, estimatedCostUsd, durationMs, success`.
- Hata: retry → fallback sağlayıcı → kullanıcıya anlaşılır Türkçe hata.
- Maliyet kontrolü: işlem öncesi kredi kontrolü (`UsageRecord` + `Company.creditBalance`).

## 9. Dış kaynak güvenliği

- Web sitesi çekme: yalnızca `http/https`, özel/yerel IP'ler engelli (SSRF koruması), boyut ve süre limiti, robots.txt'ye saygı, en fazla N sayfa.
- Yüklenen dosya: tip + boyut kontrolü, rastgele anahtar ile saklama.
- Parolalar: Node `crypto.scrypt` + salt; oturum tokenı DB'de SHA-256 hash olarak tutulur, httpOnly + SameSite=Lax cookie.
- Instagram/WhatsApp/LinkedIn şifresi hiçbir yerde istenmez (şemada alan bile yok).

## 10. Uyum (Compliance) ilkeleri — mimari etkileri

- Kişisel iletişim (`LeadContact`) ile şirket genel iletişimi (`Lead.genericEmail`, `Lead.phone`) ayrı tablolar.
- Her gönderim öncesi `ComplianceRecord` durumu: `SENDABLE / REVIEW_REQUIRED / DO_NOT_SEND`. Belirsizse `REVIEW_REQUIRED`.
- `SuppressionRecord` şirket bazlı; e-posta/domain/telefon normalize edilerek kontrol edilir; kampanya, follow-up, AI önerisi ve yeniden scraping bu listeyi atlayamaz.
- Sistem hukuki karar vermez; UI'da "İnsan incelemesi gerekli" etiketi.

## 11. Ortamlar

- `docker-compose.yml`: postgres (pgvector) + redis + minio.
- Geliştirme: `QUEUE_DRIVER=inline`, `STORAGE_DRIVER=local` ile Redis/MinIO olmadan da çalışır.
- Production: `QUEUE_DRIVER=bullmq`, `STORAGE_DRIVER=s3`, ayrı worker süreci (`npm run worker`).

## 12. Faz planı

| Faz | İçerik | Durum |
|---|---|---|
| 1 | Setup, auth, DB, multi-tenancy, onboarding, şirket profili, ürünler, bilgi bankası, web sitesi analizi | **Bu teslimat** |
| 2 | Lead modeli, Apify provider, doğal dil lead arama, dedupe, enrichment, scoring, sinyaller | Sonraki |
| 3 | Kampanya, AI strateji, mesaj üretimi, compliance engine, suppression, e-posta sağlayıcı, onay, gönderim | |
| 4 | Konuşma sınıflandırma, follow-up, CRM, görevler, satış koçu, analitik | |
| 5 | Teklif asistanı, rakip istihbaratı, WhatsApp Business API, entegrasyonlar | |

Veritabanı şeması **tüm fazları** kapsayacak şekilde baştan tasarlanır; Faz 1 yalnızca kendi tablolarını kullanır.

## 13. Geliştirme kuralı (her özellik öncesi)

1. DB modeli  2. Tenant izolasyonu  3. Yetki  4. Halüsinasyon riski  5. API maliyeti  6. Hata yönetimi  7. Audit log  8. Mobil görünüm
