# 04 — Arayüz Planı (UI Plan)

## İlkeler
- Premium, sade, veri odaklı B2B SaaS. Nötr gri zemin + tek vurgu rengi (indigo). Açık/koyu tema (sistem tercihine göre).
- **Mobile-first**: tüm sayfalar 390 px genişlikte yatay taşma olmadan test edildi; mobilde kenar menü çekmeceye dönüşür.
- Ana CTA her zaman **Yeni Satış Kampanyası**.
- **Sahte sayı yok.** Dashboard sayıları gerçek veriden gelir; veri yoksa 0 ve açıklama gösterilir. Sonraki fazların ekranları "Faz N" etiketiyle dürüst yer tutucudur.
- Her AI çıktısı yanında kaynağı ve durumu (Onay bekliyor / Onaylandı / AI çıkarımı / Kaynakta doğrulanamadı) görünür.

## Sayfa haritası

| Yol | Faz | İçerik |
|---|---|---|
| `/login`, `/register` | 1 | Split ekran, değer önerisi |
| `/onboarding?step=…` | 1 | **"Önce şirketini tanıyalım."** 8 adım: web sitesi → firma → ürün/üretim → hedef müşteri → satış → rakipler → istenmeyen müşteriler → özet |
| `/dashboard` | 1 | Bu ay hunisi, AI önerisi (duruma dayalı), profil tamamlanma, son etkinlik |
| `/company` | 1 | "Firmayı böyle anladım" + onay bekleyen bulgular (grup grup Onayla / Düzelt / Reddet) + profil bölümleri + onaylı bilgiler |
| `/products`, `/products/new`, `/products/[id]` | 1 | Liste, dokümandan gelen onay bekleyenler, "Düzelt ve onayla" |
| `/knowledge` | 1 | Doküman yükleme, işlenme ilerlemesi, "Satışta kullan" onayı, arama testi |
| `/competitors` | 1 | Rakip listesi (izleme Faz 5) |
| `/settings` (+ team, memory, usage, integrations) | 1 | Genel, ekip, şirket hafızası, kredi/AI maliyeti, entegrasyon durumu |
| `/admin` | 1 | Platform yöneticisi: şirketler, AI maliyeti, başarısız işler, audit |
| `/leads`, `/signals` | 2 | Lead tablosu (spec §91 kolonları), lead detay, "Neden bu lead?" |
| `/campaigns`, `/messages` | 3 | Kampanya sihirbazı, strateji onayı, kampanya önizleme, onay kuyruğu |
| `/pipeline`, `/tasks`, `/analytics`, `/reports`, `/assistant` | 4 | Kanban CRM, "Bugün ne yapmalıyım?", AI Chat |

## Bileşenler
`components/ui.tsx` (Button, Card, Badge, Field, Input, Select, Textarea, EmptyState, Stat, Alert, PageHeader) ·
`components/forms.tsx` (ActionForm, SubmitButton, FormMessage) · `app-shell.tsx` (kenar menü + mobil çekmece) ·
`fact-review.tsx` (Firmayı böyle anladım + bulgu inceleme) · `job-poller.tsx` (arka plan işi ilerlemesi) · `coming-soon.tsx`

## Faz 2+ ekran notları
- **Lead detay**: skor kartı (alt skorlar /30 /20 /15 /20 /15), "Doğrulanmış" vs "AI varsayımı" iki sütun, kaynak rozetleri, sinyal zaman çizelgesi, CTA "AI ile Analiz Et".
- **Kampanya önizleme**: kaç lead / e-posta / inceleme gerekli / suppressed / yüksek skor + örnek mesajlar + **Kampanyayı Onayla**.
- **AI Insight kartı**: yalnızca `AIInsight.dataBasis` doluysa gösterilir.
