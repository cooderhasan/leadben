import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { assertCan } from "@/server/tenancy/permissions";
import type { TenantContext } from "@/server/tenancy/types";
import { ai, isAIConfigured } from "@/server/ai";
import { untrusted } from "@/server/ai/guardrails";
import {
  COMPETITOR_CHANGES_INSTRUCTIONS,
  COMPETITOR_CHANGES_SHAPE,
  COMPETITOR_PROFILE_INSTRUCTIONS,
  COMPETITOR_PROFILE_SHAPE,
  competitorChangesSchema,
  competitorProfileSchema,
} from "@/server/ai/prompts/competitor";
import { crawlSite, FetchBlockedError, type CrawlResult } from "@/server/web/fetch-site";
import { allowPrivateFetch, crawlToPrompt } from "@/server/jobs/handlers/website-analyze";
import { enqueue } from "@/server/jobs/queue";
import { consumeCredits, refundCredits } from "@/server/usage/credits";
import { audit } from "@/server/audit/audit";
import { AppError } from "@/lib/errors";
import { evidenceFound } from "./evidence";

/** Tarama sayfa kaydı: metin hem karşılaştırma hem kanıt doğrulaması için saklanır (sayfa başına sınırlı). */
interface StoredPage {
  url: string;
  title: string;
  hash: string;
  text: string;
}

const MAX_STORED_CHARS = 20_000;

/** Metni cümle / satır birimlerine böler (fark hesabı için). */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length >= 12);
}

/**
 * Önceki taramaya göre YENİ eklenen metin. Önceden var olan cümleler dahil edilmez; böylece AI
 * eskiden beri sitede olan bir bilgiyi "yeni gelişme" diye raporlayamaz.
 */
export function addedText(prev: StoredPage[], next: StoredPage[]): Array<{ url: string; added: string }> {
  const before = new Set(prev.flatMap((p) => sentences(p.text)));
  const prevHash = new Map(prev.map((p) => [p.url, p.hash]));
  const out: Array<{ url: string; added: string }> = [];
  for (const page of next) {
    if (prevHash.get(page.url) === page.hash) continue;
    const added = sentences(page.text).filter((s) => !before.has(s));
    if (added.length) out.push({ url: page.url, added: added.join("\n").slice(0, 8000) });
  }
  return out;
}

function toStored(crawl: CrawlResult): StoredPage[] {
  return crawl.pages.map((p) => {
    const text = [p.title, p.metaDescription, p.headings.join("\n"), p.text].filter(Boolean).join("\n").slice(0, MAX_STORED_CHARS);
    return { url: p.url, title: p.title, hash: createHash("sha256").update(text).digest("hex").slice(0, 32), text };
  });
}

// ── Okuma / ayarlar ────────────────────────────────────────────────────

export async function listCompetitors(ctx: TenantContext) {
  assertCan(ctx, "company.read");
  const db = tenantDb(ctx);
  const competitors = await db.competitor.findMany({
    orderBy: { createdAt: "asc" },
    include: { signals: { orderBy: { detectedAt: "desc" }, take: 10 } },
  });
  const analyses = await db.websiteAnalysis.findMany({
    where: { target: "COMPETITOR", targetId: { in: competitors.map((c) => c.id) }, status: "COMPLETED" },
    orderBy: { createdAt: "desc" },
    select: { targetId: true, summary: true, result: true, completedAt: true },
  });
  const latest = new Map<string, (typeof analyses)[number]>();
  for (const a of analyses) if (a.targetId && !latest.has(a.targetId)) latest.set(a.targetId, a);
  return competitors.map((c) => ({ ...c, lastScan: latest.get(c.id) ?? null }));
}

export async function setCompetitorMonitoring(ctx: TenantContext, id: string, monitoring: boolean) {
  assertCan(ctx, "company.update");
  const res = await tenantDb(ctx).competitor.updateMany({ where: { id }, data: { monitoring } });
  if (res.count === 0) throw new AppError("NOT_FOUND", "Rakip bulunamadı.");
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: monitoring ? "competitor.monitoring_on" : "competitor.monitoring_off", entityType: "Competitor", entityId: id });
}

/** Elle tarama (2 kredi). Değişiklik yoksa AI çağrılmaz ve kredi iade edilir. */
export async function startCompetitorScan(ctx: TenantContext, id: string) {
  assertCan(ctx, "company.analyze");
  if (!isAIConfigured()) throw new AppError("AI_UNAVAILABLE", "AI sağlayıcısı yapılandırılmamış (.env → ANTHROPIC_API_KEY).");
  const db = tenantDb(ctx);
  const c = await db.competitor.findUnique({ where: { id }, select: { website: true } });
  if (!c) throw new AppError("NOT_FOUND", "Rakip bulunamadı.");
  if (!c.website) throw new AppError("VALIDATION", "Rakibin web sitesi girilmemiş.");
  const running = await db.job.findFirst({ where: { type: "competitor.scan", status: { in: ["QUEUED", "RUNNING"] }, payload: { path: ["competitorId"], equals: id } }, select: { id: true } });
  if (running) return { jobId: running.id };
  const { usageId } = await consumeCredits({ companyId: ctx.companyId, operation: "website.analyze", userId: ctx.userId, refType: "Competitor", refId: id });
  try {
    return { jobId: await enqueue("competitor.scan", { competitorId: id, usageId }, { companyId: ctx.companyId, createdById: ctx.userId }) };
  } catch (err) {
    await refundCredits(usageId, "competitor.scan.enqueue_failed");
    throw err;
  }
}

// ── Tarama (iş içinden) ────────────────────────────────────────────────

export interface ScanResult {
  firstScan: boolean;
  changedPages: number;
  signals: number;
  aiUsed: boolean;
}

export async function scanCompetitor(companyId: string, competitorId: string): Promise<ScanResult> {
  const db = tenantDb({ companyId });
  const c = await db.competitor.findUnique({ where: { id: competitorId } });
  if (!c?.website) throw new AppError("VALIDATION", "Rakip veya web sitesi bulunamadı.");

  let crawl: CrawlResult;
  try {
    crawl = await crawlSite(c.website, { maxPages: 5, allowPrivateHosts: allowPrivateFetch() });
  } catch (err) {
    if (err instanceof FetchBlockedError) throw new AppError("EXTERNAL_FETCH", err.message);
    throw new AppError("EXTERNAL_FETCH", `Rakip sitesine ulaşılamadı: ${(err as Error).message}`);
  }
  const pages = toStored(crawl);
  if (pages.reduce((s, p) => s + p.text.length, 0) < 150) throw new AppError("EXTERNAL_FETCH", "Rakip sitesinde okunabilir metin bulunamadı.");

  const prev = await db.websiteAnalysis.findFirst({
    where: { target: "COMPETITOR", targetId: competitorId, status: "COMPLETED" },
    orderBy: { createdAt: "desc" },
    select: { pages: true },
  });
  const prevPages = (Array.isArray(prev?.pages) ? prev.pages : []) as unknown as StoredPage[];
  const corpusNow = pages.map((p) => p.text).join("\n");
  const result: ScanResult = { firstScan: !prev, changedPages: 0, signals: 0, aiUsed: false };
  let summary: string | null = null;
  let profile: unknown = null;

  if (!prev) {
    // İlk tarama: profil (iddialar kanıtla doğrulanır)
    const { data } = await ai({ companyId, operation: "competitor.profile" }).extract({
      schema: competitorProfileSchema,
      instructions: COMPETITOR_PROFILE_INSTRUCTIONS,
      shape: COMPETITOR_PROFILE_SHAPE,
      input: `Rakip: ${c.name}\n\n${untrusted("competitor-website", crawlToPrompt(crawl, 30_000))}`,
      maxTokens: 2000,
    });
    result.aiUsed = true;
    summary = data.summary;
    profile = { products: data.products, claims: data.claims.filter((cl) => evidenceFound(cl.evidence, corpusNow)) };
  } else {
    const added = addedText(prevPages, pages);
    result.changedPages = added.length;
    if (added.length) {
      const addedCorpus = added.map((a) => a.added).join("\n");
      const { data } = await ai({ companyId, operation: "competitor.changes" }).extract({
        schema: competitorChangesSchema,
        tier: "fast",
        instructions: COMPETITOR_CHANGES_INSTRUCTIONS,
        shape: COMPETITOR_CHANGES_SHAPE,
        input: `Rakip: ${c.name}\n\nYENİ METİN:\n${untrusted("competitor-changes", added.map((a) => `### ${a.url}\n${a.added}`).join("\n\n"), 30_000)}`,
        maxTokens: 1500,
      });
      result.aiUsed = true;
      for (const s of data.signals) {
        // Kanıt yalnızca YENİ metinde aranır; eski içerik "yeni gelişme" sayılmaz
        if (!evidenceFound(s.evidence, addedCorpus)) continue;
        const dup = await db.competitorSignal.findFirst({ where: { competitorId, title: s.title }, select: { id: true } });
        if (dup) continue;
        await db.competitorSignal.create({
          data: {
            companyId,
            competitorId,
            type: s.type,
            title: s.title,
            description: [s.description, `Kaynak: "${s.evidence.slice(0, 300)}"`].filter(Boolean).join("\n"),
            sourceUrl: s.sourceUrl ?? added[0]!.url,
          },
        });
        result.signals++;
      }
    }
  }

  await db.websiteAnalysis.create({
    data: {
      companyId,
      target: "COMPETITOR",
      targetId: competitorId,
      url: c.website,
      status: "COMPLETED",
      pages: pages as unknown as Prisma.InputJsonValue,
      summary,
      result: (profile ?? undefined) as Prisma.InputJsonValue | undefined,
      completedAt: new Date(),
    },
  });
  await audit({ companyId, actorType: "SYSTEM", action: "competitor.scanned", entityType: "Competitor", entityId: competitorId, metadata: { ...result } });
  return result;
}
