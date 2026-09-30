# 05 — AI Araç Planı (AI Tool Plan)

## 1. Tek giriş noktası: `ai(ctx)` → `AIService`

| Metot | Kullanım |
|---|---|
| `generateText` | Serbest metin (mesaj taslağı, özet) |
| `extract(schema, shape, instructions, input)` | Zod şemalı yapılandırılmış çıktı; geçersizse 1 kez onarım denemesi |
| `classify(text, labels)` | Cevap sınıflandırma (Faz 4) |
| `summarize` | Kısa özet (hızlı model) |
| `embed` | Vektör (yapılandırıldıysa) |
| `score` | Faz 2'de `extract` üzerine: alt skorlar + gerekçe + varsayımlar |

Her çağrı: **SAFETY_RULES** sistem prompt'una eklenir → retry (429/5xx) → fallback sağlayıcı → `AIUsageLog`.
Dış içerik (web sayfası, doküman, gelen e-posta) daima `untrusted()` bloğuna sarılır — içindeki talimatlar yok sayılır (prompt injection).

## 2. Halüsinasyon önleme — katmanlı

1. **Prompt**: "Yalnızca kaynakta yazanı çıkar; her öğe için kelimesi kelimesine kanıt alıntısı ver; çıkarımları `inferred: true` işaretle."
2. **Programatik kanıt kontrolü** (`services/evidence.ts`): Alıntı kaynak metinde geçmiyorsa güven 0.3; **sertifika, üretim kapasitesi, fiyat, MOQ, teslim süresi** kaynakta yoksa **tamamen atılır** (testlerle doğrulandı).
3. **İnsan onayı**: AI çıktısı `PENDING`; satış bağlamı (`buildVerifiedCompanyContext`) yalnızca `VERIFIED` bilgileri okur.
4. **Kaynak şeffaflığı**: her bilginin `source` + `sourceRef` alanı UI'da gösterilir.

## 3. Faz 1 prompt'ları
- `prompts/website-analysis.ts` — şirket sitesi → özet + ürün + sektör + kabiliyet + sertifika (kanıtlı)
- `prompts/document-extraction.ts` — katalog/teknik doküman → ürün kartları + şirket bilgileri (kanıtlı)

## 4. AI Action Commands (Faz 4 — spec §80)

Tool calling ile, her araç `can(ctx, permission)` + kredi kontrolü + audit log'dan geçer. Riskli araçlar **taslak üretir, insan onaylar**.

| Araç | Yetki | Onay | Not |
|---|---|---|---|
| `find_leads` | lead.write | kredi özeti gösterilir | LeadSourceProvider üzerinden |
| `research_company` / `analyze_lead` / `score_lead` | lead.write | — | Varsayım/doğrulanmış ayrımı zorunlu |
| `refresh_lead` | lead.write | — | |
| `create_campaign` | campaign.write | strateji onayı | |
| `generate_message` | campaign.write | **mesaj onayı** | Yalnızca VERIFIED bağlam; kalite skoru |
| `schedule_followup` | campaign.write | — | Ret/olumsuz cevapta durur |
| `create_task` / `create_opportunity` | lead.write | — | |
| `generate_quote` | proposal.approve | **zorunlu** | Birim fiyat AI tarafından doldurulmaz |
| `analyze_campaign` / `generate_report` | lead.read | — | Yalnızca gerçek veriden; `dataBasis` zorunlu |
| `analyze_competitor` | lead.read | — | Yalnızca kamuya açık kaynak |
| `suppress_lead` | lead.write | — | Geri alınamaz uyarısı |

**AI'ın asla sahip olmayacağı araçlar**: onaysız toplu gönderim, fiyat/indirim verme, sözleşme, suppression kaldırma, başka şirket verisine erişim.

## 5. Company Memory → Sales Rule Engine (Faz 3)
Kullanıcı kuralı doğal dilde yazar → AI `structured` biçime çevirir (ör. `{country:"DE", minQuantity:5000, effect:"deprioritize"}`) →
**kullanıcı onaylar** → kural motoru lead skorlama ve mesaj üretiminde uygular. AI öğrenme döngüsü kritik kuralları kendiliğinden değiştiremez.

## 6. Maliyet kontrolü
- İşlem başına kredi tablosu (`usage/credits.ts`), işlem **öncesi** atomik düşüm, hata durumunda otomatik iade.
- Hızlı/ucuz model (`AI_FAST_MODEL`) sınıflandırma ve kısa özetlerde.
- Admin paneli: şirket başına 30 günlük AI maliyeti ve çağrı sayısı.
