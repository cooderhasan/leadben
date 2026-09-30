import "server-only";
import { env } from "@/server/env";
import { AppError } from "@/lib/errors";

const API_BASE = "https://api.apify.com/v2";
/** Sayfayı gerçek tarayıcıda açıp metnini döndüren actor. Ortam değişkeniyle değiştirilebilir. */
const DEFAULT_ACTOR = "apify~website-content-crawler";

export interface PageRenderer {
  /** Sayfayı JavaScript çalıştırarak açar ve düz metnini döndürür. */
  render(url: string): Promise<string>;
}

let override: PageRenderer | null = null;

/** Yalnızca testlerde kullanılır. */
export function __setRendererForTests(r: PageRenderer | null) {
  override = r;
}

export function isRenderConfigured(): boolean {
  return Boolean(override) || Boolean(env().APIFY_TOKEN);
}

interface CrawlItem {
  text?: string;
  markdown?: string;
  url?: string;
}

/**
 * Liste sayfaları (fuar katılımcıları, dernek üyeleri) satırları sonradan JavaScript ile
 * yüklüyorsa sunucudan gelen HTML boş olur. Bu sağlayıcı sayfayı gerçek tarayıcıda açtırır.
 *
 * robots.txt kontrolü çağıran tarafta (fetchListPage) yapılır — tarayıcıyla açmak
 * robots.txt'i geçersiz kılmaz.
 */
export class ApifyPageRenderer implements PageRenderer {
  constructor(
    private readonly token: string,
    private readonly actorId: string = DEFAULT_ACTOR,
  ) {}

  async render(url: string): Promise<string> {
    const res = await fetch(
      `${API_BASE}/acts/${this.actorId}/run-sync-get-dataset-items?token=${encodeURIComponent(this.token)}&format=json&clean=true&timeout=120`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          startUrls: [{ url }],
          crawlerType: "playwright:firefox",
          maxCrawlPages: 1,
          maxCrawlDepth: 0,
          maxResults: 1,
          // "none": okunabilir metne indirgeme kapalı — liste/tablo satırları korunsun
          htmlTransformer: "none",
          saveMarkdown: true,
          saveHtml: false,
        }),
        signal: AbortSignal.timeout(180_000),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new AppError("EXTERNAL_FETCH", `Sayfa tarayıcıyla açılamadı (${res.status}). ${body.slice(0, 200)}`);
    }
    const items = (await res.json()) as CrawlItem[];
    const item = items[0];
    const text = (item?.markdown ?? item?.text ?? "").trim();
    if (!text) throw new AppError("EXTERNAL_FETCH", "Sayfa tarayıcıyla açıldı ama içerik okunamadı.");
    return text;
  }
}

export function getPageRenderer(): PageRenderer {
  if (override) return override;
  const e = env();
  if (!e.APIFY_TOKEN) throw new AppError("VALIDATION", "Tarayıcıyla açma kapalı (APIFY_TOKEN tanımlı değil).");
  return new ApifyPageRenderer(e.APIFY_TOKEN, e.APIFY_RENDER_ACTOR);
}
