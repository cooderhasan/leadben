# AI Sales OS — geliştirme kuralları

Dil: kullanıcı ile ve UI metinlerinde **Türkçe**. Kod tanımlayıcıları İngilizce.

## Her özellikten önce (spec §103)
1. DB modeli  2. Tenant izolasyonu  3. Yetki (`assertCan`)  4. AI halüsinasyon riski  5. API/AI maliyeti (kredi)  6. Hata yönetimi  7. Audit log  8. Mobil görünüm

## Kesin kurallar
- Müşteri verisine yalnızca `tenantDb(ctx)` ile eriş. `rawDb` sadece auth/tenancy/jobs/audit/usage/admin/seed (ESLint zorlar). Yeni `companyId`'li model → `TENANT_MODELS`'e ekle (test kırılır).
- İstemciden gelen `companyId`'ye asla güvenme; bağlam `requireTenant()` ile sunucuda çözülür.
- AI çıktısı `PENDING` kaydedilir; satış içeriği yalnızca `buildVerifiedCompanyContext()` (VERIFIED) ile üretilir. Fiyat/sertifika/referans uydurulamaz.
- Dış içerik prompt'a `untrusted()` ile girer. Tüm AI çağrıları `ai(ctx)` üzerinden (log + retry + guardrails).
- Uzun işler HTTP isteğinde beklenmez → `enqueue()`.
- Kredi harcayan işlem: önce `consumeCredits`, hata olursa `refundCredits`.
- Sahte lead / sahte sayı / sahte içgörü üretme; mock veri yalnızca açıkça demo/test için.
- Server action dosyalarında yalnızca `export async function` (fabrika fonksiyonu yok).

## Faz sonu
`npm run check` (typecheck + lint + test + build) temiz geçmeden sonraki faza geçme.
