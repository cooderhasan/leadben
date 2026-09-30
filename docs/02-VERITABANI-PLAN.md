# 02 — Veritabanı Planı (Database Plan)

Kaynak: [`prisma/schema.prisma`](../prisma/schema.prisma) — **tüm fazları** kapsar; Faz 1 bu şemanın bir alt kümesini kullanır.
Migration: `prisma/migrations/*_init` (+ el ile eklenen tam metin arama GIN indeksi).

## 1. Temel kurallar

| Kural | Uygulama |
|---|---|
| Tenant izolasyonu | Müşteri verisi taşıyan **her** tabloda `companyId` + `@@index([companyId, …])`. `tenantDb()` her sorguya `companyId` ekler. Test: `tests/tenant-isolation.test.ts` DMMF'i tarar, listede eksik model varsa kırılır. |
| Silme | Şirket silinirse tüm verisi `onDelete: Cascade` ile gider (KVKK silme talebi için tek işlem). |
| Doğrulanmış bilgi | `CompanyFact.status`, `Product.status`, `CompanyProfile.aiSummaryStatus`, `Campaign.strategyStatus`: `PENDING → VERIFIED / REJECTED`. AI yalnızca `PENDING` üretir. |
| Kişisel veri ayrımı | Şirket genel iletişimi `Lead.genericEmail/phone`; kişisel iletişim `LeadContact` (ayrı tablo, `communicationBasis`, `consentStatus`, `optOut`). |
| Para | `Decimal(14,2)` + `currency` alanı. Float kullanılmaz. |
| Sırlar | `Integration.secretsEncrypted` (şifreli). Parola hash'i scrypt; oturum tokenı SHA-256 hash olarak. |

## 2. Model grupları

### Kimlik
`User` · `Account` (OAuth'a hazır) · `Session` (tokenHash, activeCompanyId, expiresAt)

### Şirket (tenant)
`Company` (creditBalance, onboardingStep) · `CompanyMember` (rol: OWNER/ADMIN/MEMBER/VIEWER) ·
`CompanyProfile` (onboarding alanları + "Firmayı böyle anladım" özeti) · `CompanyFact` (kaynaklı, onaylı/onaysız tekil bilgi) ·
`CompanyMemory` (kurallar/tercihler; `structured` alanı Faz 3 kural motoru için) · `TargetMarket` (`isExcluded=true` → istenmeyen müşteri)

### Ürün ve bilgi bankası
`ProductCategory` (ağaç) · `Product` · `ProductDocument` (ürün↔doküman) · `KnowledgeDocument` (`verified` = satışta kullanılabilir) ·
`KnowledgeChunk` (`embedding vector` — boyutsuz, `embeddingModel` ile eşleşme) · `WebsiteAnalysis` (kendi şirketi / lead / rakip) ·
`Industry` (global taksonomi, salt okunur)

### Lead (Faz 2)
`Lead` (dedupe için `normalizedName`, `domain`, `normalizedPhone` indeksli; `lastVerifiedAt`, `nextRefreshAt`) ·
`LeadContact` · `LeadSource` (çoklu kaynak) · `LeadSignal` (satış sinyali, `verified`) · `LeadScore` (alt skorlar + açıklama + varsayımlar)

### Kampanya ve iletişim (Faz 3)
`Campaign` (filters, strategy, strategyStatus, onay) · `CampaignLead` · `CampaignStep` (dayOffset, channel, variant) ·
`Message` (status akışı DRAFT→PENDING_APPROVAL→APPROVED→SENT…, qualityScore, complianceStatus) ·
`Conversation` · `ConversationMessage` (ReplyCategory)

### CRM (Faz 4)
`Opportunity` (stage, lostReason) · `Task` (createdByAI) · `FollowUp` · `Proposal` (items JSON; birim fiyatı yalnızca insan girer)

### Rakip ve içgörü
`Competitor` · `CompetitorSignal` · `AIInsight` (**`dataBasis` zorunlu** — veri yoksa içgörü üretilmez)

### Uyum
`ComplianceRecord` (kanal + adres başına SENDABLE / REVIEW_REQUIRED / DO_NOT_SEND + nedenler) ·
`SuppressionRecord` (`companyId = null` → platform geneli merkezi engel; `@@unique([companyId, type, value])`)

### Kullanım, maliyet, audit
`UsageRecord` (kredi hareketi, ±) · `AIUsageLog` (companyId, provider, model, operation, token, tahmini maliyet) ·
`AuditLog` (actorType USER/AI/SYSTEM) · `Subscription` (Stripe/iyzico/PayTR'a hazır) · `Integration` · `Job` (kuyruk bağımsız iş takibi)

## 3. Önemli indeksler

- `Lead(companyId, domain | normalizedPhone | normalizedName)` → dedupe (Faz 2)
- `Lead(companyId, fitScore)`, `Lead(companyId, status)` → lead tablosu filtreleri
- `Message(providerMessageId)` → e-posta webhook eşleştirme
- `FollowUp(status, scheduledAt)` → cron taraması
- `SuppressionRecord(type, value)` → gönderim öncesi hızlı kontrol
- `KnowledgeChunk`: `GIN(to_tsvector('simple', content))` — migration SQL'inde, Prisma'nın drift kontrolünü etkilemez (doğrulandı)
- `AIUsageLog(createdAt)`, `AuditLog(companyId, createdAt)` → admin raporları

## 4. Kredi tutarlılığı

`consumeCredits()` koşullu `UPDATE … WHERE creditBalance >= cost` ile atomiktir — eşzamanlı 30 istekte bakiye eksiye düşmez (test edildi).
İade (`refundCredits`) idempotenttir.

## 5. İleri sertleştirme (sonraki fazlar)

- Postgres Row Level Security (uygulama katmanı izolasyonuna ek savunma)
- `vector(N)` sabit boyut + HNSW indeksi (tek embedding modeli seçildiğinde)
- `AuditLog` / `AIUsageLog` için aylık partition
