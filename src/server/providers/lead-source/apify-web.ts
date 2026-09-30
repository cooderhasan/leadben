import "server-only";
import { AppError } from "@/lib/errors";
import { extractDomain } from "@/lib/lead-normalize";
import type { LeadSearchQuery, LeadSearchRun, LeadSourceProvider, RawLead } from "./types";

const API_BASE = "https://api.apify.com/v2";

/** Google arama sonuçlarını toplayan Apify actor'ı. Ortam değişkeni ile değiştirilebilir. */
const DEFAULT_ACTOR = "apify~google-search-scraper";
const RESULTS_PER_PAGE = 10;

export interface SerpItem {
  searchQuery?: { term?: string };
  organicResults?: Array<{ title?: string; url?: string; description?: string }>;
}

/**
 * Firma sitesi olamayacak alan adları: dizinler, pazaryerleri, sosyal medya, haber / ansiklopedi, kamu.
 * Bir dizin sayfası tek bir firma değildir; bu listeler "Liste sayfasından içe aktar" ile ayrıca işlenebilir.
 */
const NON_COMPANY_HOSTS = [
  "google.", "youtube.com", "facebook.com", "instagram.com", "linkedin.com", "twitter.com", "x.com", "tiktok.com", "pinterest.",
  "wikipedia.org", "eksisozluk.com", "quora.com", "reddit.com", "medium.com",
  "sahibinden.com", "trendyol.com", "hepsiburada.com", "n11.com", "amazon.", "alibaba.com", "aliexpress.", "ebay.", "etsy.com", "ciceksepeti.com",
  "yandex.", "bing.com", "yelp.", "foursquare.com", "tripadvisor.",
  "firmasec.com", "bulurum.com", "firmarehberi", "rehber", "kompass.", "europages.", "made-in-", "tradeindia.", "indiamart.", "turkishexporter", "exporthub", "globalpiyasa.com", "tobb.org.tr",
  // Yurt dışı firma dizinleri / veri satıcıları — firma sitesi değil
  "zoominfo.com", "dnb.com", "crunchbase.com", "opencorporates.com", "bloomberg.com", "thomasnet.com",
  "manta.com", "bbb.org", "yellowpages.", "yell.com", "glassdoor.", "companieshouse.gov.uk", "northdata.",
  "importyeti.com", "panjiva.com", "volza.com", "zauba.com", "trademo.com", "alibaba.",
  "bizapedia.com", "buzzfile.com", "corporationwiki.com", "owler.com", "zippia.com", "dandb.com",
  "apollo.io", "rocketreach.", "leadiq.com", "lusha.com", "signalhire.com", "hoovers.com",
  // Ticaret odası üye dizinleri: "chamber.org" / "chambermaster" — çıplak "chamber" YAZILMAZ,
  // gerçek firma adlarını eler (ör. Chamberlain Group garaj kapısı üreticisidir).
  "chamber.org", "chambermaster.com", "chamberofcommerce.com",
  // Kamu kurumları (TR dışı): eyalet/federal siteler firma sitesi değil
  ".gov", ".mil", ".gov.uk", ".gouv.fr",
  "hurriyet.com.tr", "milliyet.com.tr", "sabah.com.tr", "haberturk.com", "ntv.com.tr", "sozcu.com.tr", "dunya.com", "bloomberght.com", "aa.com.tr",
  "gov.tr", "edu.tr", "bel.tr", "sikayetvar.com", "kariyer.net", "yenibiris.com", "secretcv.com", "indeed.",
];

/** Dizin / pazaryeri / sosyal medya gibi firma sitesi olmayan alan adı mı? */
export function isNonCompanyHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return NON_COMPANY_HOSTS.some((x) => h.includes(x));
}

/** Başlıktan firma adını çıkarır: "Aktif Yay | Basma Yay Üretimi" → "Aktif Yay" (en anlamlı parça) */
export function companyNameFromTitle(title: string, domain: string): string {
  const parts = title
    .split(/\s[|–—-]\s|\s·\s/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2);
  const token = domain.split(".")[0]!.replace(/-/g, "").toLocaleLowerCase("tr");
  const norm = (s: string) => s.toLocaleLowerCase("tr").replace(/[^a-z0-9çğıöşü]/g, "");
  // Alan adıyla örtüşen parça firma adıdır; yoksa en kısa parça (slogan değil marka olması muhtemel)
  const match = parts.find((p) => norm(p).includes(token.slice(0, 5)) || token.includes(norm(p).slice(0, 5)));
  const pick = match ?? [...parts].sort((a, b) => a.length - b.length)[0] ?? title;
  return pick.slice(0, 200);
}

/**
 * Web araması (spec §94): Google organik sonuçlarından firma web sitelerini çıkarır.
 * Yalnızca alan adı + başlık + açıklama alınır; iletişim bilgisi sonra site taramasıyla (e-posta bul / AI analiz) gelir.
 */
export class ApifyWebSearchProvider implements LeadSourceProvider {
  readonly name = "apify-web";
  readonly sourceType = "WEB_SEARCH" as const;

  constructor(
    private readonly token: string,
    private readonly actorId: string = DEFAULT_ACTOR,
  ) {
    if (!token) throw new AppError("VALIDATION", "Lead kaynağı yapılandırılmamış. Yöneticiniz .env dosyasına APIFY_TOKEN eklemeli.");
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${API_BASE}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(this.token)}`;
    const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new AppError("EXTERNAL_FETCH", `Web araması kaynağına ulaşılamadı (${res.status}). ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }

  /** Her anahtar ifade + konum bir arama; sonuç sayısı hedef lead sayısına göre (sayfa başı 10, en fazla 3 sayfa) */
  buildInput(query: LeadSearchQuery): Record<string, unknown> {
    const place = [...(query.districts ?? []), ...(query.cities ?? [])].filter(Boolean).join(" ");
    const terms = (query.keywords.length ? query.keywords : query.industries ?? []).slice(0, 6);
    const queries = terms.map((k) => [k, place].filter(Boolean).join(" "));
    // Sonuçların önemli kısmı dizin / haber olup elenir → hedefin ~2 katı sonuç istenir
    const pages = Math.min(3, Math.max(1, Math.ceil((query.limit * 2) / (RESULTS_PER_PAGE * Math.max(1, queries.length)))));
    return { queries: queries.join("\n"), maxPagesPerQuery: pages, countryCode: "tr", languageCode: "tr", mobileResults: false };
  }

  /** Serbest sorgu listesi (her firma adı bir sorgu). Sonuçlar sorguya göre gruplanır. */
  async startRawSearch(queries: string[], opts?: { lang?: "tr" | "en" }): Promise<string> {
    // "en" istendiğinde ülke kısıtı değişir: yurt dışı firmanın sitesi TR sonuçlarında çıkmayabilir
    const locale = opts?.lang === "en" ? { countryCode: "us", languageCode: "en" } : { countryCode: "tr", languageCode: "tr" };
    const run = await this.call<{ data: { id: string } }>(`/acts/${this.actorId}/runs`, {
      method: "POST",
      body: JSON.stringify({ queries: queries.slice(0, 50).join("\n"), maxPagesPerQuery: 1, ...locale, mobileResults: false }),
    });
    return run.data.id;
  }

  /** Ham sonuçlar: { sorgu → [{title, url}] }. Çalışma bitmediyse null. */
  async fetchRawResults(runId: string): Promise<Map<string, Array<{ title: string; url: string }>> | null> {
    const run = await this.call<{ data: { status: string } }>(`/actor-runs/${runId}`);
    if (run.data.status === "READY" || run.data.status === "RUNNING") return null;
    if (run.data.status !== "SUCCEEDED") throw new AppError("EXTERNAL_FETCH", "Web araması tamamlanamadı.");
    const items = await this.call<SerpItem[]>(`/actor-runs/${runId}/dataset/items?clean=true&format=json`);
    const map = new Map<string, Array<{ title: string; url: string }>>();
    for (const item of items) {
      const term = item.searchQuery?.term ?? "";
      const list = map.get(term) ?? [];
      for (const r of item.organicResults ?? []) if (r.title && r.url) list.push({ title: r.title, url: r.url });
      map.set(term, list);
    }
    return map;
  }

  async startSearch(query: LeadSearchQuery): Promise<LeadSearchRun> {
    const run = await this.call<{ data: { id: string } }>(`/acts/${this.actorId}/runs`, { method: "POST", body: JSON.stringify(this.buildInput(query)) });
    return { runId: run.data.id, provider: this.name, status: "RUNNING" };
  }

  async fetchResults(runId: string): Promise<{ status: LeadSearchRun["status"]; leads: RawLead[] }> {
    const run = await this.call<{ data: { status: string } }>(`/actor-runs/${runId}`);
    const status = run.data.status;
    if (status === "READY" || status === "RUNNING") return { status: "RUNNING", leads: [] };
    if (status !== "SUCCEEDED") return { status: "FAILED", leads: [] };
    const items = await this.call<SerpItem[]>(`/actor-runs/${runId}/dataset/items?clean=true&format=json`);
    return { status: "SUCCEEDED", leads: this.toRawLeads(items) };
  }

  /** Sonuçları firma sitelerine indirger: firma olmayan alan adları elenir, aynı alan adı bir kez alınır */
  toRawLeads(items: SerpItem[]): RawLead[] {
    const seen = new Set<string>();
    const out: RawLead[] = [];
    for (const item of items) {
      for (const r of item.organicResults ?? []) {
        if (!r.url || !r.title) continue;
        let url: URL;
        try {
          url = new URL(r.url);
        } catch {
          continue;
        }
        const host = url.hostname.toLowerCase().replace(/^www\./, "");
        if (NON_COMPANY_HOSTS.some((h) => host.includes(h))) continue;
        const domain = extractDomain(host);
        if (!domain || seen.has(domain)) continue;
        seen.add(domain);
        out.push({
          companyName: companyNameFromTitle(r.title, domain),
          website: `${url.protocol}//${url.hostname}/`,
          category: item.searchQuery?.term?.slice(0, 200),
          sourceType: "WEB_SEARCH",
          sourceUrl: r.url,
          externalId: domain,
          raw: { title: r.title, description: r.description ?? null, query: item.searchQuery?.term ?? null },
        });
      }
    }
    return out;
  }
}
