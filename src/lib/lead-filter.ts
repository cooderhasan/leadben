import type { LeadStatus } from "@prisma/client";
import { LEAD_STATUSES } from "./validation";

export type LeadSourceKey = "maps" | "web" | "directory" | "csv" | "manual";
const SOURCES: LeadSourceKey[] = ["maps", "web", "directory", "csv", "manual"];

export const LEAD_PAGE_SIZES = [50, 100, 200] as const;
export const LEAD_SORT_KEYS = ["score", "new", "name"] as const;
export type LeadSortKey = (typeof LEAD_SORT_KEYS)[number];

export interface ParsedLeadFilter {
  q?: string;
  status?: LeadStatus;
  minScore?: number;
  source?: LeadSourceKey;
  email?: "yes" | "no";
  /** "me" (oturumdaki kullanıcı), "none" (atanmamış) veya kullanıcı kimliği */
  owner?: string;
  listId?: string;
  campaign?: "in" | "out";
  sort?: LeadSortKey;
  per?: number;
}

/** URL parametrelerinden / form alanlarından lead filtresi (sayfa ve toplu işlem aynı filtreyi kullanır) */
export function parseLeadFilter(get: (k: string) => string | null | undefined): ParsedLeadFilter {
  const q = get("q")?.trim() || undefined;
  const statusRaw = get("status") ?? "";
  const status = (LEAD_STATUSES as readonly string[]).includes(statusRaw) ? (statusRaw as LeadStatus) : undefined;
  const minRaw = get("min");
  const minScore = minRaw ? Math.max(0, Math.min(100, Number(minRaw) || 0)) : undefined;
  const sourceRaw = get("source") ?? "";
  const source = (SOURCES as string[]).includes(sourceRaw) ? (sourceRaw as LeadSourceKey) : undefined;
  const emailRaw = get("email");
  const email = emailRaw === "yes" || emailRaw === "no" ? emailRaw : undefined;
  const owner = get("owner")?.trim() || undefined;
  const listId = get("list")?.trim() || undefined;
  const campaignRaw = get("campaign");
  const campaign = campaignRaw === "in" || campaignRaw === "out" ? campaignRaw : undefined;
  const sortRaw = get("sort") ?? "";
  const sort = (LEAD_SORT_KEYS as readonly string[]).includes(sortRaw) ? (sortRaw as LeadSortKey) : undefined;
  const perRaw = Number(get("per"));
  const per = (LEAD_PAGE_SIZES as readonly number[]).includes(perRaw) ? perRaw : undefined;
  return { q, status, minScore, source, email, owner, listId, campaign, sort, per };
}
