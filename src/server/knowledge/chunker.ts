export interface Chunk {
  index: number;
  content: string;
  tokenCount: number;
}

/** Yaklaşık token sayısı (Türkçe/İngilizce karışık metin için ~4 karakter/token). */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

/**
 * Metni paragraf sınırlarına saygı göstererek parçalar.
 * Hedef ~1200 karakter, parçalar arası ~150 karakter örtüşme (bağlam kopmasın diye).
 */
export function chunkText(text: string, opts: { target?: number; overlap?: number; max?: number } = {}): Chunk[] {
  const target = opts.target ?? 1200;
  const overlap = opts.overlap ?? 150;
  const max = opts.max ?? target * 2;

  const normalized = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) return [];

  // Paragraflara, çok uzun paragrafları cümlelere böl
  const units: string[] = [];
  for (const para of normalized.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= max) {
      units.push(p);
      continue;
    }
    const sentences = p.split(/(?<=[.!?;])\s+/);
    let buf = "";
    for (const s of sentences) {
      if ((buf + " " + s).length > max && buf) {
        units.push(buf.trim());
        buf = "";
      }
      if (s.length > max) {
        for (let i = 0; i < s.length; i += max) units.push(s.slice(i, i + max));
      } else buf += " " + s;
    }
    if (buf.trim()) units.push(buf.trim());
  }

  const chunks: Chunk[] = [];
  let current = "";
  const flush = () => {
    const content = current.trim();
    if (!content) return;
    chunks.push({ index: chunks.length, content, tokenCount: estimateTokens(content) });
    current = content.length > overlap ? content.slice(-overlap) : "";
    // Örtüşmeyi kelime sınırından başlat
    const sp = current.indexOf(" ");
    if (sp > 0) current = current.slice(sp + 1);
  };

  for (const u of units) {
    if (current && (current + "\n\n" + u).length > target) flush();
    current = current ? `${current}\n\n${u}` : u;
  }
  flush();
  return chunks;
}
