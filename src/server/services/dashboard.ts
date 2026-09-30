import "server-only";
import { tenantDb } from "@/server/tenancy/tenant-db";
import type { TenantContext } from "@/server/tenancy/types";

/**
 * Dashboard sayıları. Tümü gerçek veriden hesaplanır — veri yoksa 0 gösterilir, asla örnek sayı uydurulmaz.
 */
export async function getFunnelThisMonth(ctx: TenantContext) {
  const db = tenantDb(ctx);
  const since = new Date();
  since.setDate(1);
  since.setHours(0, 0, 0, 0);

  const [potential, qualified, contacted, replies, interested, quotes, won] = await Promise.all([
    db.lead.count({ where: { discoveredAt: { gte: since } } }),
    db.lead.count({ where: { discoveredAt: { gte: since }, fitScore: { gte: 70 } } }),
    db.message.count({ where: { sentAt: { gte: since }, direction: "OUTBOUND" } }),
    db.conversationMessage.count({ where: { receivedAt: { gte: since }, direction: "INBOUND" } }),
    db.conversationMessage.count({
      where: { receivedAt: { gte: since }, direction: "INBOUND", category: { in: ["INTERESTED", "REQUEST_FOR_CALL", "REQUEST_FOR_QUOTE", "CATALOG_REQUEST"] } },
    }),
    db.opportunity.count({ where: { stage: { in: ["QUOTE", "NEGOTIATION"] } } }),
    db.opportunity.count({ where: { wonAt: { gte: since } } }),
  ]);
  return [
    { label: "Potansiyel müşteri", value: potential },
    { label: "Nitelikli lead", value: qualified },
    { label: "İletişim", value: contacted },
    { label: "Cevap", value: replies },
    { label: "Olumlu cevap", value: interested },
    { label: "Teklif", value: quotes },
    { label: "Satış", value: won },
  ];
}

export async function getRecentActivity(ctx: TenantContext, limit = 8) {
  return tenantDb(ctx).auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, action: true, actorType: true, createdAt: true, metadata: true },
  });
}

export async function getUsageSummary(ctx: TenantContext) {
  const db = tenantDb(ctx);
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [company, usage, ai] = await Promise.all([
    db.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { creditBalance: true } }),
    db.usageRecord.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
    db.aIUsageLog.aggregate({
      where: { createdAt: { gte: since } },
      _sum: { inputTokens: true, outputTokens: true, estimatedCostUsd: true },
      _count: true,
    }),
  ]);
  return {
    creditBalance: company.creditBalance,
    usage,
    ai30d: {
      calls: ai._count,
      inputTokens: ai._sum.inputTokens ?? 0,
      outputTokens: ai._sum.outputTokens ?? 0,
      costUsd: Number(ai._sum.estimatedCostUsd ?? 0),
    },
  };
}

export async function getJobStatus(ctx: TenantContext, jobId: string) {
  return tenantDb(ctx).job.findUnique({
    where: { id: jobId },
    select: { id: true, type: true, status: true, progress: true, error: true, finishedAt: true },
  });
}
