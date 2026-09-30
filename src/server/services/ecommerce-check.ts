import "server-only";
import type { EcommerceStatus } from "@prisma/client";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { assertCan } from "@/server/tenancy/permissions";
import type { TenantContext } from "@/server/tenancy/types";
import { enqueue } from "@/server/jobs/queue";
import { allowPrivateFetch } from "@/server/jobs/handlers/website-analyze";
import { audit } from "@/server/audit/audit";
import { crawlSite, FetchBlockedError } from "@/server/web/fetch-site";
import { classifyFromSignals, classifyWithoutFetch, type EcommerceVerdict } from "@/server/web/ecommerce";
import { AppError } from "@/lib/errors";

/**
 * E-ticaret durumu kontrolü: lead'in sitesini açar (ana sayfa + 2 iç sayfa) ve e-ticaret / eski site
 * işaretlerine bakar. AI ve ücretli API kullanmaz → kredi düşmez. robots.txt'ye uyulur.
 */
export const ECOMMERCE_CHECK_MAX = 100;

// ── Ayar: e-ticaret fırsatı modu ───────────────────────────────────────

export async function getEcommerceProspecting(ctx: Pick<TenantContext, "companyId">): Promise<boolean> {
  const c = await tenantDb(ctx).company.findUnique({ where: { id: ctx.companyId }, select: { ecommerceProspecting: true } });
  return Boolean(c?.ecommerceProspecting);
}

export async function setEcommerceProspecting(ctx: TenantContext, on: boolean) {
  assertCan(ctx, "company.update");
  await tenantDb(ctx).company.update({ where: { id: ctx.companyId }, data: { ecommerceProspecting: on } });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "company.ecommerce_prospecting", metadata: { on } });
}

// ── Başlatma ───────────────────────────────────────────────────────────

export async function startEcommerceCheck(ctx: TenantContext, leadIds: string[]) {
  assertCan(ctx, "lead.write");
  const db = tenantDb(ctx);
  const ids = [...new Set(leadIds)].slice(0, 500);
  const targets = await db.lead.findMany({ where: { id: { in: ids } }, select: { id: true }, take: ECOMMERCE_CHECK_MAX });
  if (targets.length === 0) throw new AppError("VALIDATION", "Kontrol edilecek firma seçin.");
  const running = await db.job.findFirst({ where: { type: "lead.check_ecommerce", status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true } });
  if (running) throw new AppError("CONFLICT", "Site kontrolü zaten sürüyor. Bitince tekrar deneyin.");

  const jobId = await enqueue("lead.check_ecommerce", { leadIds: targets.map((t) => t.id) }, { companyId: ctx.companyId, createdById: ctx.userId, maxAttempts: 1 });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "lead.ecommerce_check.started", metadata: { count: targets.length } });
  return { jobId, count: targets.length, capped: ids.length > targets.length };
}

/**
 * Arama bittikten sonra (iş içinden) çağrılır: mod açıksa bulunan firmaların sitesi otomatik kontrol edilir.
 * Hata aramayı başarısız saymaz.
 */
export async function queueEcommerceCheckAfterImport(companyId: string, leadIds: string[], createdById: string | null) {
  if (leadIds.length === 0) return null;
  try {
    if (!(await getEcommerceProspecting({ companyId }))) return null;
    return await enqueue("lead.check_ecommerce", { leadIds: leadIds.slice(0, ECOMMERCE_CHECK_MAX) }, { companyId, createdById, maxAttempts: 1 });
  } catch (err) {
    console.error("[ecommerce-check] otomatik kontrol kuyruğa alınamadı", err);
    return null;
  }
}

// ── Çalıştırma (iş içinden) ────────────────────────────────────────────

export type EcommerceCheckOutcome = "classified" | "blocked";
export interface EcommerceCheckItem {
  leadId: string;
  name: string;
  outcome: EcommerceCheckOutcome;
  status?: EcommerceStatus;
  evidence: string;
}

/** Bir lead'in sitesini kontrol eder. robots.txt yasağında karar verilmez (null). */
export async function checkLeadSite(website: string | null): Promise<EcommerceVerdict | null> {
  const quick = classifyWithoutFetch(website);
  if (quick) return quick;
  try {
    const crawl = await crawlSite(website!, { maxPages: 3, allowPrivateHosts: allowPrivateFetch() });
    return classifyFromSignals(crawl.pages.map((p) => p.shop));
  } catch (err) {
    if (err instanceof FetchBlockedError) return null;
    return { status: "SITE_DOWN", platform: null, marketplaces: [], issues: [], evidence: `Site açılmıyor: ${(err as Error).message.slice(0, 160)}` };
  }
}

export async function checkLeadsEcommerce(companyId: string, leadIds: string[], progress?: (pct: number) => Promise<void>) {
  const db = tenantDb({ companyId });
  const items: EcommerceCheckItem[] = [];
  for (const [i, leadId] of leadIds.entries()) {
    const lead = await db.lead.findUnique({ where: { id: leadId }, select: { id: true, companyName: true, website: true } });
    if (lead) {
      const verdict = await checkLeadSite(lead.website);
      if (verdict) {
        await db.lead.updateMany({
          // Kontrol sürerken site adresi elle değiştirildiyse eski sonuç yazılmaz
          where: { id: leadId, website: lead.website },
          data: {
            ecommerceStatus: verdict.status,
            ecommercePlatform: verdict.platform,
            marketplaces: verdict.marketplaces,
            siteIssues: verdict.issues,
            ecommerceCheckedAt: new Date(),
          },
        });
        items.push({ leadId, name: lead.companyName, outcome: "classified", status: verdict.status, evidence: verdict.evidence });
      } else {
        items.push({ leadId, name: lead.companyName, outcome: "blocked", evidence: "Site robots.txt ile otomatik taramayı yasaklıyor; siteye kendiniz bakın." });
      }
    }
    await progress?.(Math.round(((i + 1) / leadIds.length) * 100));
  }
  const counts: Partial<Record<EcommerceStatus, number>> = {};
  for (const it of items) if (it.status) counts[it.status] = (counts[it.status] ?? 0) + 1;
  return { total: items.length, blocked: items.filter((x) => x.outcome === "blocked").length, counts, items };
}

/** Son 24 saatteki kontrol (liste üstünde özet / ilerleme için) */
export async function getLastEcommerceCheck(ctx: TenantContext) {
  assertCan(ctx, "lead.read");
  const job = await tenantDb(ctx).job.findFirst({
    where: { type: "lead.check_ecommerce", createdAt: { gte: new Date(Date.now() - 86_400_000) } },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, payload: true, result: true, error: true, finishedAt: true },
  });
  if (!job) return null;
  const r = (job.result ?? {}) as Partial<Awaited<ReturnType<typeof checkLeadsEcommerce>>>;
  return {
    id: job.id,
    status: job.status,
    error: job.error,
    finishedAt: job.finishedAt,
    total: ((job.payload as { leadIds?: string[] } | null)?.leadIds ?? []).length,
    blocked: r.blocked ?? 0,
    counts: r.counts ?? {},
    items: r.items ?? [],
  };
}
