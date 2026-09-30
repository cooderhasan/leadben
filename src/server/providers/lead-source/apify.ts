import "server-only";
import { AppError } from "@/lib/errors";
import type { LeadSearchQuery, LeadSearchRun, LeadSourceProvider, RawLead } from "./types";

const API_BASE = "https://api.apify.com/v2";

/** Google Haritalar işletme verisi toplayan genel actor. Ortam değişkeni ile değiştirilebilir. */
const DEFAULT_ACTOR = "compass~crawler-google-places";

interface ApifyPlace {
  title?: string;
  website?: string;
  phone?: string;
  phoneUnformatted?: string;
  address?: string;
  city?: string;
  neighborhood?: string;
  countryCode?: string;
  categoryName?: string;
  placeId?: string;
  url?: string;
  emails?: string[];
  instagrams?: string[];
  linkedIns?: string[];
  facebooks?: string[];
  totalScore?: number;
  permanentlyClosed?: boolean;
  temporarilyClosed?: boolean;
}

/**
 * Apify üzerinden kamuya açık işletme dizinlerinden lead toplar (spec §94).
 *
 * Kurallar:
 * - Yalnızca kamuya açık işletme bilgisi toplanır; kişisel iletişim verisi ayrı alanda döner.
 * - Uzun süren çalıştırma asenkrondur: `startSearch` yalnızca başlatır, sonucu job worker toplar.
 */
export class ApifyLeadSourceProvider implements LeadSourceProvider {
  readonly name = "apify";
  readonly sourceType = "GOOGLE_MAPS" as const;

  constructor(
    private readonly token: string,
    private readonly actorId: string = DEFAULT_ACTOR,
  ) {
    if (!token) {
      throw new AppError(
        "VALIDATION",
        "Lead kaynağı yapılandırılmamış. Yöneticiniz .env dosyasına APIFY_TOKEN eklemeli.",
      );
    }
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${API_BASE}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(this.token)}`;
    const res = await fetch(url, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new AppError(
        "EXTERNAL_FETCH",
        `Lead kaynağına ulaşılamadı (${res.status}). ${body.slice(0, 200)}`,
      );
    }
    return (await res.json()) as T;
  }

  /** Doğal dil aramasından türetilmiş sorguyu actor girdisine çevirir. */
  buildInput(query: LeadSearchQuery): Record<string, unknown> {
    const locations = [...(query.districts ?? []), ...(query.cities ?? [])].filter(Boolean);
    const locationQuery = [locations.join(", "), query.country ?? "Türkiye"].filter(Boolean).join(", ");
    const searchStrings = query.keywords.length > 0 ? query.keywords : query.industries ?? [];
    return {
      searchStringsArray: searchStrings.slice(0, 10),
      locationQuery,
      maxCrawledPlacesPerSearch: Math.max(1, Math.ceil(query.limit / Math.max(1, searchStrings.length))),
      language: "tr",
      skipClosedPlaces: true,
      scrapeContacts: false,
    };
  }

  async startSearch(query: LeadSearchQuery): Promise<LeadSearchRun> {
    const run = await this.call<{ data: { id: string; status: string } }>(
      `/acts/${this.actorId}/runs`,
      { method: "POST", body: JSON.stringify(this.buildInput(query)) },
    );
    return { runId: run.data.id, provider: this.name, status: "RUNNING" };
  }

  async fetchResults(runId: string): Promise<{ status: LeadSearchRun["status"]; leads: RawLead[] }> {
    const run = await this.call<{ data: { status: string } }>(`/actor-runs/${runId}`);
    const status = run.data.status;
    if (status === "READY" || status === "RUNNING") return { status: "RUNNING", leads: [] };
    if (status !== "SUCCEEDED") return { status: "FAILED", leads: [] };

    const items = await this.call<ApifyPlace[]>(`/actor-runs/${runId}/dataset/items?clean=true&format=json`);
    return { status: "SUCCEEDED", leads: items.map((i) => this.toRawLead(i)).filter((l): l is RawLead => l !== null) };
  }

  toRawLead(place: ApifyPlace): RawLead | null {
    if (!place.title?.trim()) return null;
    if (place.permanentlyClosed) return null;
    const social: Record<string, string> = {};
    if (place.instagrams?.[0]) social.instagram = place.instagrams[0];
    if (place.linkedIns?.[0]) social.linkedin = place.linkedIns[0];
    if (place.facebooks?.[0]) social.facebook = place.facebooks[0];

    return {
      companyName: place.title.trim(),
      website: place.website ?? undefined,
      phone: place.phoneUnformatted ?? place.phone ?? undefined,
      genericEmail: place.emails?.[0],
      address: place.address ?? undefined,
      city: place.city ?? undefined,
      district: place.neighborhood ?? undefined,
      country: place.countryCode ?? undefined,
      category: place.categoryName ?? undefined,
      socialProfiles: Object.keys(social).length > 0 ? social : undefined,
      sourceType: "GOOGLE_MAPS",
      sourceUrl: place.url ?? undefined,
      externalId: place.placeId ?? undefined,
      raw: place,
    };
  }
}
