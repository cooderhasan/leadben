/**
 * Tahmini maliyet tablosu (USD / 1M token). Maliyet kontrolü ve admin paneli içindir,
 * faturalama için değil. Sağlayıcı fiyatları değiştiğinde güncellenmelidir.
 * Eşleşme model adının başlangıcına göre yapılır (en uzun önek kazanır).
 */
const PRICES: Array<[prefix: string, input: number, output: number]> = [
  ["claude-opus", 5, 25],
  ["claude-sonnet", 3, 15],
  ["claude-haiku", 1, 5],
  ["gpt-4.1-mini", 0.4, 1.6],
  ["gpt-4.1", 2, 8],
  ["gpt-4o-mini", 0.15, 0.6],
  ["gpt-4o", 2.5, 10],
  ["gpt-5-mini", 0.25, 2],
  ["gpt-5", 1.25, 10],
  ["gemini-2.5-flash-lite", 0.1, 0.4],
  ["gemini-2.5-flash", 0.3, 2.5],
  ["gemini-2.5-pro", 1.25, 10],
  ["text-embedding-3-small", 0.02, 0],
  ["text-embedding-3-large", 0.13, 0],
  ["voyage", 0.06, 0],
  ["gemini-embedding", 0.15, 0],
];

const DEFAULT_PRICE: [number, number] = [3, 15];

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  // OpenRouter vb.: "anthropic/claude-sonnet-4.5", "meta-llama/…:free" → sağlayıcı öneki atılır, ":free" ücretsizdir
  if (/:free$/i.test(model)) return 0;
  const name = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  const match = PRICES.filter(([p]) => name.startsWith(p)).sort((a, b) => b[0].length - a[0].length)[0];
  const [inPrice, outPrice] = match ? [match[1], match[2]] : DEFAULT_PRICE;
  return (inputTokens * inPrice + outputTokens * outPrice) / 1_000_000;
}
