/**
 * AI'ın verdiği kanıt alıntısının gerçekten kaynak metinde geçip geçmediğini kontrol eder.
 * Boşluk, büyük/küçük harf ve Türkçe karakter farklarını tolere eder.
 */
export function normalizeForMatch(s: string): string {
  return s
    .toLocaleLowerCase("tr-TR")
    .replace(/[çğıöşü]/g, (c) => ({ ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" })[c] ?? c)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function evidenceFound(evidence: string | null | undefined, corpus: string): boolean {
  if (!evidence) return false;
  const e = normalizeForMatch(evidence);
  if (e.length < 3) return false;
  const c = normalizeForMatch(corpus);
  if (c.includes(e)) return true;
  // Uzun alıntılarda ufak farkları tolere et: kelimelerin %80'i ardışık pencerede geçmeli
  const words = e.split(" ").filter((w) => w.length > 2);
  if (words.length < 4) return false;
  const hits = words.filter((w) => c.includes(w)).length;
  return hits / words.length >= 0.8;
}

/** Değerin kendisinin kaynak metinde geçip geçmediği (ör. "ISO 9001"). */
export function valueFound(value: string, corpus: string): boolean {
  const v = normalizeForMatch(value);
  return v.length >= 2 && normalizeForMatch(corpus).includes(v);
}
