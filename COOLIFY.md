# Coolify ile yayına alma (lead.aktifyay.com.tr)

## 1) DNS
Alan adı panelinde (aktifyay.com.tr) bir **A kaydı** ekleyin:

| Tür | Ad | Değer |
|---|---|---|
| A | `lead` | Coolify sunucunuzun IP adresi |

## 2) Coolify'da uygulama
1. **Projects → (proje) → + New → Public/Private Repository** → `cooderhasan/lead`, branch `main`.
2. **Build Pack: Docker Compose** → Docker Compose Location: **`/docker-compose.coolify.yml`**.
3. **Domains** (app servisi): `https://lead.aktifyay.com.tr` — Coolify SSL sertifikasını otomatik alır.
   - **Internal port = `3000`** olmalı (Domains tablosunda ⚠ görünüyorsa ⚙ → port 3000; eski sürümlerde domain'i `https://lead.aktifyay.com.tr:3000` diye girin).
   - DNS kaydı olmayan ek domain (ör. `www.lead…`) eklemeyin; "DNS mismatch" olan domain SSL sertifikasının alınmasını engelleyebilir.
4. **Environment Variables**:
   - `ANTHROPIC_API_KEY` = Anthropic anahtarınız (**zorunlu**, "Is Secret" işaretleyin)
   - `ALLOW_SIGNUP` = `false` → yabancılar kayıt olup AI kredinizi harcayamaz (müşteriye hesap açmak için geçici `true` yapabilirsiniz)
   - `APIFY_TOKEN` = Apify API anahtarı (**isteğe bağlı**, "Is Secret") → Leads ekranında "AI ile lead bul" açılır. Boşsa CSV içe aktarma ve elle ekleme çalışır.
   - `LEAD_SEARCH_MAX` = tek aramada en fazla lead (varsayılan 50; her yeni lead 1 kredi)
   - **E-posta gönderimi (isteğe bağlı)**: `EMAIL_PROVIDER` = `resend` / `brevo` / `smtp` ve ilgili anahtar
     (`RESEND_API_KEY`, `BREVO_API_KEY` veya `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`). Boşsa kampanya ve mesaj onayı çalışır, gönderim kapalıdır.
     Gönderen alan adınızı sağlayıcı panelinde doğrulayın (SPF + DKIM), DNS'e DMARC ekleyin.
   - `EMAIL_DAILY_LIMIT` = şirket başına günlük gönderim sınırı (varsayılan 50; yeni alan adında düşük başlayın)
   - Diğer her şey otomatik: veritabanı şifresi, demo/admin parolaları, ret bağlantısı imza anahtarı (`SERVICE_PASSWORD_64_UNSUBSCRIBE`)
     ve webhook anahtarı (`SERVICE_PASSWORD_64_EMAILWEBHOOK`) Coolify tarafından üretilir.
   - Geri dönme / spam şikâyeti takibi: sağlayıcı panelinde webhook adresi olarak
     `https://lead.aktifyay.com.tr/api/webhooks/email/resend?token=<SERVICE_PASSWORD_64_EMAILWEBHOOK değeri>` (Brevo için `/brevo`) girin.
   - **Gelen yanıtlar (Faz 4)**: sağlayıcının gelen kutusu yönlendirmesini (Brevo → Inbound Parsing) şu adrese ayarlayın:
     `https://lead.aktifyay.com.tr/api/webhooks/email/inbound?token=<SERVICE_PASSWORD_64_EMAILWEBHOOK değeri>`.
     Webhook kurmadan da lead sayfasından yanıtı elle ekleyebilirsiniz; AI sınıflandırma ve görev/fırsat oluşturma aynı çalışır.
   - **WhatsApp Business (Faz 5)**: Uygulamada Ayarlar → WhatsApp ekranından Meta bilgilerini girin; ekrandaki Callback URL ve
     Verify token'ı Meta for Developers → WhatsApp → Configuration → Webhook'a yazın. Anahtarlar `ENCRYPTION_KEY` ile şifrelenir
     (Coolify otomatik üretir; **değiştirmeyin**, değişirse kayıtlı anahtarları yeniden girmeniz gerekir).
   - **REST API ve webhook (Faz 5)**: Ayarlar → API ve webhook. API adresi `https://lead.aktifyay.com.tr/api/v1`.
   - Hatırlatmalar: uygulama içi zamanlayıcı her 15 dakikada vakti gelen hatırlatmaların taslağını hazırlar (`SCHEDULER_ENABLED=true`).
5. **Deploy**. İlk açılışta tablolar ve Aktif Yay demo verisi otomatik kurulur (1–3 dk).

## 3) Giriş bilgileri
Coolify → uygulama → **Environment Variables** ekranında otomatik üretilen parolaları görürsünüz:

| Hesap | E-posta | Parola |
|---|---|---|
| Demo (Aktif Yay) | `demo@aktifyay.local` | `SERVICE_PASSWORD_DEMO` değeri |
| Platform yöneticisi | `admin@aisalesos.local` | `SERVICE_PASSWORD_ADMIN` değeri |

## 4) Güncelleme
Kod GitHub'a her gönderildiğinde Coolify'da **Redeploy** (veya otomatik deploy açıksa kendiliğinden).
Veritabanı ve yüklenen dosyalar kalıcı volume'larda durur; güncellemede silinmez.

## Notlar
- Yedekleme: Coolify → Postgres servisi → **Backups** ile günlük yedek açın.
- Sağlık kontrolü: `https://lead.aktifyay.com.tr/api/health` → `{"ok":true}`
- Sorun olursa: Coolify → app → **Logs** (açılışta `[start]` satırları görünür).
