import "server-only";
import { env } from "@/server/env";
import { ApifyLeadSourceProvider } from "./apify";
import { ApifyWebSearchProvider } from "./apify-web";
import type { LeadSourceKind, LeadSourceProvider } from "./types";

let override: LeadSourceProvider | null = null;

/** Yalnızca testlerde kullanılır. Production kodu bunu çağırmaz. */
export function __setLeadSourceProviderForTests(p: LeadSourceProvider | null) {
  override = p;
}

export function isLeadSourceConfigured(): boolean {
  return Boolean(override) || Boolean(env().APIFY_TOKEN);
}

/** Otomatik lead arama sağlayıcısı (Google Haritalar veya web araması). Yapılandırılmamışsa anlaşılır Türkçe hata fırlatır. */
export function getLeadSourceProvider(kind: LeadSourceKind = "maps"): LeadSourceProvider {
  if (override) return override;
  const e = env();
  return kind === "web"
    ? new ApifyWebSearchProvider(e.APIFY_TOKEN ?? "", e.APIFY_WEB_SEARCH_ACTOR)
    : new ApifyLeadSourceProvider(e.APIFY_TOKEN ?? "", e.APIFY_GOOGLE_MAPS_ACTOR);
}

export interface WebSearchProvider {
  /** `lang`: arama motorunun ülke/dil ayarı — yurt dışı firmada "en" daha isabetli sonuç verir. */
  startRawSearch(queries: string[], opts?: { lang?: "tr" | "en" }): Promise<string>;
  fetchRawResults(runId: string): Promise<Map<string, Array<{ title: string; url: string }>> | null>;
}

let webOverride: WebSearchProvider | null = null;

/** Yalnızca testlerde kullanılır. */
export function __setWebSearchProviderForTests(p: WebSearchProvider | null) {
  webOverride = p;
}

export function isWebSearchConfigured(): boolean {
  return Boolean(webOverride) || Boolean(env().APIFY_TOKEN);
}

/** Firma adından site bulmak için ham web araması sağlayıcısı */
export function getWebSearchProvider(): WebSearchProvider {
  if (webOverride) return webOverride;
  const e = env();
  return new ApifyWebSearchProvider(e.APIFY_TOKEN ?? "", e.APIFY_WEB_SEARCH_ACTOR);
}

export const LEAD_SOURCE_LABELS: Record<LeadSourceKind, string> = { maps: "Google Haritalar", web: "Web araması" };
