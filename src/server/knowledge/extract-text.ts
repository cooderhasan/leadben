import "server-only";

export const ALLOWED_UPLOAD_TYPES: Record<string, string> = {
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
};

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Dosya tipini uzantıdan belirler (tarayıcının bildirdiği tip güvenilir değildir).
 * PDF'ler ayrıca içerik imzasıyla doğrulanır (looksLikePdf).
 */
export function detectMimeType(filename: string): string | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const byExt: Record<string, string> = { pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv" };
  return byExt[ext] ?? null;
}

/** PDF imzası kontrolü — uzantısı .pdf olup içeriği farklı dosyaları reddeder. */
export function looksLikePdf(buf: Buffer): boolean {
  return buf.subarray(0, 5).toString("latin1") === "%PDF-";
}

export async function extractText(buf: Buffer, mimeType: string): Promise<{ text: string; pageCount: number | null }> {
  if (mimeType === "application/pdf") {
    if (!looksLikePdf(buf)) throw new Error("Dosya geçerli bir PDF değil.");
    const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { totalPages, text } = await pdfText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [text];
    return { text: pages.map((t, i) => `[Sayfa ${i + 1}]\n${t}`).join("\n\n"), pageCount: totalPages };
  }
  return { text: buf.toString("utf8"), pageCount: null };
}
