# 03 — API Planı

## 1. Katmanlar

```
UI (Server Component / Client form)
   │  useActionState
   ▼
Server Action (src/app/actions/*)   ← zod doğrulama, safeAction(), revalidate/redirect
   │
   ▼
Service (src/server/services/*)     ← assertCan(ctx, permission), iş kuralı, audit
   │
   ▼
tenantDb(ctx) / jobs / ai / providers
```

- **Server Actions** UI mutasyonları içindir (form gönderimi). Her action `requireTenant()` ile bağlamı **sunucuda** çözer.
- **Route Handlers** (`/api/*`) yalnızca UI dışı ihtiyaçlar içindir: iş durumu sorgulama, sağlık kontrolü, (Faz 3) e-posta webhook'ları, unsubscribe linki.
- Tüm hatalar `AppError(code, türkçeMesaj)` → kullanıcıya anlaşılır mesaj; diğer hatalar loglanır, genel mesaj döner.

## 2. Faz 1 — Server Actions

| Action | Yetki | Açıklama |
|---|---|---|
| `registerAction` | — | Kullanıcı + şirket + OWNER + deneme kredisi |
| `loginAction` / `logoutAction` | — | Hız sınırı: IP+e-posta başına 5/dk |
| `switchCompanyAction` | üyelik | Aktif şirket değiştirme |
| `analyzeWebsiteAction` | company.analyze | 2 kredi, iş kuyruğa |
| `saveCompanyInfoAction` … `saveExclusionsAction` | company.update | Onboarding adımları (`returnTo` destekli) |
| `addCompetitorAction` / `deleteCompetitorAction` | company.update | |
| `completeOnboardingAction` | company.update | |
| `verifyFactsAction` / `correctFactAction` / `rejectFactsAction` | facts.review | Onayla / Düzelt / Reddet |
| `verifySummaryAction` / `correctSummaryAction` | facts.review | "Firmayı böyle anladım" |
| `promoteFactAction` | product.write | Bulgudan ürün oluştur |
| `saveProductAction` / `verifyProductsAction` / `toggleProductAction` / `deleteProductAction` | product.write | |
| `uploadDocumentAction` | knowledge.write | 5 kredi (AI varsa), iş kuyruğa |
| `setDocumentVerifiedAction` / `deleteDocumentAction` | knowledge.write | "Satışta kullan" onayı |
| `addMemoryAction` / `setMemoryStatusAction` | memory.write | Şirket hafızası |
| `addMemberAction` / `removeMemberAction` | member.manage | |

## 3. Route Handlers

| Yol | Metot | Açıklama |
|---|---|---|
| `/api/jobs/[id]` | GET | İş durumu (status, progress, error) — yalnızca aktif şirketin işleri |
| `/api/health` | GET | DB bağlantısı dahil canlılık |

### Faz 2+ planlanan
| Yol | Açıklama |
|---|---|
| `POST /api/webhooks/email/[provider]` | delivered / bounced / complaint / reply — imza doğrulamalı |
| `GET /u/[token]` | Tek tıkla ret (unsubscribe) → SuppressionRecord (RFC 8058 List-Unsubscribe-Post dahil) |
| `POST /api/webhooks/whatsapp` | WhatsApp Business API (resmi) |
| `POST /api/v1/…` | Dış entegrasyonlar için API anahtarlı REST (Faz 5) |

## 4. Arka plan işleri

| Tip | Tetikleyen | Faz |
|---|---|---|
| `website.analyze` | analyzeWebsiteAction | 1 |
| `document.ingest` | uploadDocumentAction | 1 |
| `lead.search`, `lead.enrich`, `lead.score`, `lead.refresh` | kampanya / cron | 2 |
| `campaign.generate_messages`, `email.send`, `followup.run` | onay / cron | 3 |
| `conversation.classify`, `report.weekly`, `competitor.monitor` | webhook / cron | 4–5 |

Sözleşme: `enqueue(type, payload, { companyId })` → `Job` kaydı → sürücü (inline / BullMQ) → `runJob()` → handler.
Retry: 3 deneme, exponential backoff. `PermanentJobError` ve AI dışı `AppError` tekrar denenmez. Son hatada `onFailure` (ör. kredi iadesi).

## 5. Sağlayıcı sözleşmeleri

- `AIProvider` — `src/server/ai/types.ts` (Anthropic / OpenAI / Gemini)
- `EmbeddingProvider` — OpenAI / Gemini / Voyage
- `LeadSourceProvider` — `src/server/providers/lead-source/types.ts` (Apify, CSV, Manual — Faz 2)
- `EmailProvider` — `src/server/providers/email/types.ts` (SMTP, Resend, Brevo, SendGrid — Faz 3)
- `StorageProvider` — local / S3
