import type { LeadSourceType } from "@prisma/client";

/**
 * Lead kaynağı sözleşmesi (spec §94). Kod doğrudan Apify SDK'ya bağımlı olmaz.
 * Uygulamalar (Faz 2): ApifyProvider (Google Maps / web actor'ları), CsvProvider, ManualProvider.
 *
 * Kural: Sağlayıcılar yalnızca kamuya açık / kullanım şartlarına uygun veri döndürür.
 * Kişisel iletişim bilgisi `personalContacts` alanında AYRI döner; şirket genel iletişiminden karıştırılmaz.
 */
/** Otomatik arama kaynağı: işletme dizini (Google Haritalar) veya web araması (Google sonuçları) */
export type LeadSourceKind = "maps" | "web";

export interface LeadSearchQuery {
  /** Doğal dilden türetilmiş arama ifadesi, ör. "otomotiv yan sanayi" */
  keywords: string[];
  country?: string;
  cities?: string[];
  districts?: string[];
  industries?: string[];
  limit: number;
}

export interface RawLead {
  companyName: string;
  website?: string;
  phone?: string;
  genericEmail?: string;
  address?: string;
  city?: string;
  district?: string;
  country?: string;
  category?: string;
  socialProfiles?: Record<string, string>;
  personalContacts?: Array<{ fullName?: string; title?: string; email?: string; phone?: string; sourceUrl?: string }>;
  sourceType: LeadSourceType;
  sourceUrl?: string;
  externalId?: string;
  raw?: unknown;
}

export interface LeadSearchRun {
  runId: string;
  provider: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED";
  estimatedCostUsd?: number;
}

export interface LeadSourceProvider {
  readonly name: string;
  readonly sourceType: LeadSourceType;
  /** Uzun süren aramalar asenkron başlar; sonuç job worker tarafından toplanır. */
  startSearch(query: LeadSearchQuery): Promise<LeadSearchRun>;
  fetchResults(runId: string): Promise<{ status: LeadSearchRun["status"]; leads: RawLead[] }>;
}
