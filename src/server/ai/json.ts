/**
 * Model çıktısından JSON nesnesi/dizisi çıkarır. Kod bloğu (```json) ve önündeki/arkasındaki
 * açıklama metnini tolere eder.
 */
export function parseJsonFromText(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // İlk { veya [ ile eşleşen son } veya ] arasını dene
    const startObj = candidate.indexOf("{");
    const startArr = candidate.indexOf("[");
    const start =
      startObj === -1 ? startArr : startArr === -1 ? startObj : Math.min(startObj, startArr);
    if (start === -1) throw new Error("Yanıtta JSON bulunamadı");
    const closing = candidate[start] === "{" ? "}" : "]";
    const end = candidate.lastIndexOf(closing);
    if (end <= start) throw new Error("Yanıtta geçerli JSON bulunamadı");
    return JSON.parse(candidate.slice(start, end + 1));
  }
}
