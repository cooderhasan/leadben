import "server-only";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { assertCan } from "@/server/tenancy/permissions";
import type { TenantContext } from "@/server/tenancy/types";
import { consumeCredits } from "@/server/usage/credits";
import { enqueue } from "@/server/jobs/queue";
import { audit } from "@/server/audit/audit";
import { normalizeUrl } from "@/server/web/ssrf";
import { AppError } from "@/lib/errors";
import { isAIConfigured } from "@/server/ai";

/**
 * Kendi şirket sitesinin analizini başlatır. Kredi düşülür, iş kuyruğa alınır, hemen döner.
 */
export async function startOwnWebsiteAnalysis(ctx: TenantContext, rawUrl: string) {
  assertCan(ctx, "company.analyze");
  let url: URL;
  try {
    url = normalizeUrl(rawUrl);
  } catch (err) {
    throw new AppError("VALIDATION", (err as Error).message, { website: (err as Error).message });
  }

  if (!isAIConfigured()) {
    throw new AppError("AI_UNAVAILABLE", "AI sağlayıcısı yapılandırılmamış (.env → ANTHROPIC_API_KEY). Bu adımı atlayıp bilgileri elle girebilirsiniz.");
  }

  const db = tenantDb(ctx);
  const running = await db.websiteAnalysis.findFirst({
    where: { target: "OWN_COMPANY", status: { in: ["QUEUED", "RUNNING"] } },
    select: { id: true },
  });
  if (running) return { analysisId: running.id, alreadyRunning: true };

  const { usageId } = await consumeCredits({
    companyId: ctx.companyId,
    operation: "website.analyze",
    userId: ctx.userId,
    refType: "WebsiteAnalysis",
  });

  const analysis = await db.websiteAnalysis.create({
    data: { companyId: ctx.companyId, url: url.toString(), target: "OWN_COMPANY", createdById: ctx.userId },
  });
  await db.company.update({ where: { id: ctx.companyId }, data: { website: url.toString() } });

  const jobId = await enqueue("website.analyze", { analysisId: analysis.id, usageId }, { companyId: ctx.companyId, createdById: ctx.userId });
  await db.websiteAnalysis.update({ where: { id: analysis.id }, data: { jobId } });

  await audit({
    companyId: ctx.companyId,
    userId: ctx.userId,
    action: "company.website_analysis.started",
    entityType: "WebsiteAnalysis",
    entityId: analysis.id,
    metadata: { url: url.toString() },
  });
  return { analysisId: analysis.id, alreadyRunning: false };
}

export async function getLatestOwnAnalysis(ctx: TenantContext) {
  return tenantDb(ctx).websiteAnalysis.findFirst({
    where: { target: "OWN_COMPANY" },
    orderBy: { createdAt: "desc" },
    select: { id: true, url: true, status: true, error: true, summary: true, createdAt: true, completedAt: true, pages: true },
  });
}
