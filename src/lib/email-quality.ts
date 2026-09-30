import { normalizeEmail } from "./lead-normalize";

/** Tek kullanımlık / geçici e-posta servisleri — ticari iletide değeri yoktur, bounce üretir */
const DISPOSABLE = new Set([
  "mailinator.com", "10minutemail.com", "guerrillamail.com", "temp-mail.org", "tempmail.com", "yopmail.com",
  "sharklasers.com", "trashmail.com", "getnada.com", "dispostable.com", "maildrop.cc", "fakeinbox.com",
  "throwawaymail.com", "mytemp.email", "moakt.com", "emailfake.com", "tempr.email", "burnermail.io",
]);

/** Yaygın servislerin sık yapılan yazım hataları (bounce'ın en sık sebeplerinden) */
const TYPOS: Record<string, string> = {
  "gmial.com": "gmail.com",
  "gmai.com": "gmail.com",
  "gmail.co": "gmail.com",
  "gmailcom": "gmail.com",
  "gmaill.com": "gmail.com",
  "gmail.com.tr": "gmail.com",
  "hotmial.com": "hotmail.com",
  "hotmai.com": "hotmail.com",
  "hotmail.co": "hotmail.com",
  "outlok.com": "outlook.com",
  "outlook.co": "outlook.com",
  "yahooo.com": "yahoo.com",
  "yaho.com": "yahoo.com",
  "yandex.co": "yandex.com",
  "icloud.co": "icloud.com",
};

export type EmailQualityCode = "ok" | "invalid_syntax" | "typo" | "disposable" | "local_domain";

export interface EmailQuality {
  code: EmailQualityCode;
  /** Gönderim öncesi kesin engel mi (true) yoksa yalnızca uyarı mı */
  blocking: boolean;
  message?: string;
  /** "typo" durumunda önerilen düzeltme */
  suggestion?: string;
  domain: string | null;
}

/**
 * DNS gerektirmeyen adres kalite kontrolü (saf fonksiyon).
 * Amaç: gönderilmeden önce kesin geri dönecek adresleri ayıklamak — bounce oranı alan adı itibarını belirler.
 */
export function checkEmailQuality(input: string | null | undefined): EmailQuality {
  const email = normalizeEmail(input);
  if (!email) return { code: "invalid_syntax", blocking: true, message: "Adres biçimi geçersiz.", domain: null };
  const domain = email.split("@")[1] ?? "";
  if (!domain.includes(".") || domain.endsWith(".") || domain.includes("..")) {
    return { code: "invalid_syntax", blocking: true, message: "Alan adı geçersiz.", domain };
  }
  // Yalnızca yerel ağda geçerli adresler (localhost, .local) e-posta alamaz
  if (/(^|\.)(local|localhost|invalid|test|example)$/i.test(domain)) {
    return { code: "local_domain", blocking: true, message: "Bu alan adı internette e-posta alamaz.", domain };
  }
  if (DISPOSABLE.has(domain)) {
    return { code: "disposable", blocking: true, message: "Tek kullanımlık (geçici) e-posta servisi.", domain };
  }
  const fix = TYPOS[domain];
  if (fix) {
    return { code: "typo", blocking: true, message: `Alan adı yanlış yazılmış olabilir: ${domain} → ${fix}`, suggestion: email.replace(`@${domain}`, `@${fix}`), domain };
  }
  return { code: "ok", blocking: false, domain };
}
