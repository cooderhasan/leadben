/**
 * Mesaj kalite ve "uydurma iddia" kontrolü (spec §42, §81). Saf fonksiyon — AI kullanılmaz.
 *
 * "block" seviyesindeki sorunlar düzeltilmeden mesaj onaylanamaz.
 */
import { normalizeForMatch } from "./evidence";

export interface QualityIssue {
  severity: "block" | "warn";
  code: string;
  text: string;
}

export interface QualityResult {
  score: number;
  issues: QualityIssue[];
  blocked: boolean;
}

const PLACEHOLDER = /\[[^\]\n]{1,40}\]|\{\{|\}\}|<(?:ad|isim|firma|name|company)[^>]*>/i;

/** Doğrulanmış bilgide geçmesi gereken iddia kalıpları */
const CLAIM_PATTERNS: Array<{ code: string; label: string; re: RegExp }> = [
  { code: "price", label: "Fiyat / tutar", re: /(?:₺|\$|€)\s?\d[\d.,]*|\d[\d.,]*\s?(?:TL|₺|USD|EUR|€|\$|dolar|avro|euro)\b/gi },
  { code: "percent", label: "Yüzde", re: /%\s?\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s?%/g },
  { code: "cert", label: "Sertifika", re: /\b(?:ISO\s?\d{4,5}(?::\d{4})?|IATF\s?16949|AS\s?9100|TS\s?EN\s?\d+|CE\s(?:belgeli|sertifikal[ıi])|TSE\s(?:belgeli|sertifikal[ıi]))/gi },
  { code: "years", label: "Tecrübe yılı", re: /\b\d{1,3}\s?(?:yıllık|yıldır|yılı aşkın|yılı aşan)\b/gi },
  { code: "capacity", label: "Kapasite / adet", re: /\b\d[\d.,]*\s?(?:adet|ton|m²|m2|metrekare)\s?(?:\/|\s)?(?:gün|ay|yıl|günlük|aylık|yıllık)\b/gi },
  { code: "delivery", label: "Teslim süresi", re: /\b\d{1,3}\s?(?:iş\s)?(?:gün|hafta)\s?(?:içinde|içerisinde)\s?teslim/gi },
];

const GUARANTEE = /\b(?:garanti(?:li|liyoruz|ediyoruz)?|kesin(?:likle)? (?:sonuç|kazanç)|%\s?100)\b/i;
const SPAMMY = /(?:!!+|ÜCRETSİZ|BEDAVA|KAÇIRMAYIN|son fırsat|acil yanıt|hemen tıklayın)/i;
const PRIOR_RELATION = /\b(?:geçen görüşmemiz|daha önce görüştüğümüz|konuştuğumuz gibi|siparişiniz için teşekkür)/i;

function uppercaseRatio(s: string): number {
  const letters = s.replace(/[^\p{L}]/gu, "");
  if (letters.length < 8) return 0;
  const upper = letters.replace(/[^\p{Lu}]/gu, "");
  return upper.length / letters.length;
}

/**
 * @param verifiedCorpus Satıcının doğrulanmış bilgileri + ürünleri + gönderici bilgisi (düz metin/JSON).
 * @param leadCorpus Lead hakkında bilinenler (kişiselleştirme kontrolü için; rakamlar buradan da gelebilir).
 */
export function checkMessageQuality(
  msg: { subject: string; body: string },
  verifiedCorpus: string,
  leadCorpus = "",
): QualityResult {
  const issues: QualityIssue[] = [];
  const text = `${msg.subject}\n${msg.body}`;
  const known = normalizeForMatch(`${verifiedCorpus}\n${leadCorpus}`);
  // normalize "500.000"ı "500 000" yapar → binlik gruplarını birleştir: " 500000 "
  const knownDigits = ` ${known.replace(/(\d)\s(?=\d{3}\b)/g, "$1")} `;

  if (PLACEHOLDER.test(text)) issues.push({ severity: "block", code: "placeholder", text: "Doldurulmamış yer tutucu var (ör. [Ad], {{firma}})." });

  const seen = new Set<string>();
  for (const p of CLAIM_PATTERNS) {
    for (const m of text.matchAll(p.re)) {
      const claim = m[0].trim();
      const key = `${p.code}:${claim.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Rakam kısmı + birim doğrulanmış bilgide geçmeli
      const norm = normalizeForMatch(claim);
      const digits = claim.replace(/[^\d]/g, "");
      const found =
        (norm.length > 0 && known.includes(norm)) || (p.code !== "cert" && digits.length > 0 && knownDigits.includes(` ${digits} `));
      if (!found) {
        issues.push({ severity: "block", code: `unverified_${p.code}`, text: `Doğrulanmamış iddia (${p.label}): "${claim}". Doğrulanmış bilgilerinizde yok — çıkarın veya önce bilgiyi onaylayın.` });
      }
    }
  }

  if (PRIOR_RELATION.test(text)) issues.push({ severity: "block", code: "fake_relation", text: "Daha önce görüşülmüş gibi yazılmış; ilk temasta bu yanıltıcıdır." });
  if (GUARANTEE.test(text)) issues.push({ severity: "warn", code: "guarantee", text: "Garanti / kesin sonuç ifadesi var; satış sonucu garanti edilmemeli." });
  if (SPAMMY.test(text)) issues.push({ severity: "warn", code: "spammy", text: "Spam filtrelerini tetikleyebilecek ifade var." });
  if (uppercaseRatio(msg.subject) > 0.5) issues.push({ severity: "warn", code: "caps", text: "Konu satırında çok fazla büyük harf var." });
  if (msg.subject.length > 90) issues.push({ severity: "warn", code: "subject_long", text: "Konu satırı çok uzun (90 karakterden fazla)." });
  const words = msg.body.split(/\s+/).filter(Boolean).length;
  if (words > 220) issues.push({ severity: "warn", code: "body_long", text: `Mesaj uzun (${words} kelime); ilk temasta 150 kelimenin altı önerilir.` });
  if (words < 25) issues.push({ severity: "warn", code: "body_short", text: "Mesaj çok kısa; alıcı neden yazdığınızı anlamayabilir." });
  const links = (msg.body.match(/https?:\/\//g) ?? []).length;
  if (links > 2) issues.push({ severity: "warn", code: "links", text: "İkiden fazla bağlantı teslim edilebilirliği düşürür." });
  if (/abonelikten çık|listeden çık|unsubscribe/i.test(msg.body)) {
    issues.push({ severity: "warn", code: "own_unsubscribe", text: "Ret metni sistem tarafından otomatik eklenir; gövdeden çıkarın." });
  }

  const blocks = issues.filter((i) => i.severity === "block").length;
  const warns = issues.length - blocks;
  return { score: Math.max(0, 100 - blocks * 30 - warns * 10), issues, blocked: blocks > 0 };
}
