import "server-only";
import { rawDb } from "@/server/db";
import { AppError } from "@/lib/errors";
import type { UserContext } from "@/server/tenancy/types";

export function assertPlatformAdmin(user: UserContext | null): asserts user is UserContext {
  if (!user?.isPlatformAdmin) throw new AppError("FORBIDDEN", "Bu sayfa yalnızca platform yöneticileri içindir.");
}

/** Platform yöneticisi paneli (spec §66): şirketler, kullanım, AI maliyeti, başarısız işler, audit. */
export async function getPlatformOverview() {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [companies, users, aiByCompany, aiTotal, failedJobs, recentAudit] = await Promise.all([
    rawDb.company.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        name: true,
        creditBalance: true,
        onboardingCompletedAt: true,
        createdAt: true,
        subscription: { select: { plan: true, status: true } },
        _count: { select: { members: true, products: true, documents: true, leads: true } },
      },
    }),
    rawDb.user.count(),
    rawDb.aIUsageLog.groupBy({
      by: ["companyId"],
      where: { createdAt: { gte: since } },
      _sum: { estimatedCostUsd: true, inputTokens: true, outputTokens: true },
      _count: true,
    }),
    rawDb.aIUsageLog.aggregate({
      where: { createdAt: { gte: since } },
      _sum: { estimatedCostUsd: true },
      _count: true,
    }),
    rawDb.job.findMany({
      where: { status: "FAILED" },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { id: true, type: true, companyId: true, error: true, attempts: true, createdAt: true },
    }),
    rawDb.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, action: true, actorType: true, companyId: true, userId: true, createdAt: true },
    }),
  ]);
  const aiMap = new Map(aiByCompany.map((a) => [a.companyId, a]));
  return {
    users,
    companies: companies.map((c) => ({
      ...c,
      aiCostUsd30d: Number(aiMap.get(c.id)?._sum.estimatedCostUsd ?? 0),
      aiCalls30d: aiMap.get(c.id)?._count ?? 0,
    })),
    aiTotal: { costUsd: Number(aiTotal._sum.estimatedCostUsd ?? 0), calls: aiTotal._count },
    failedJobs,
    recentAudit,
  };
}
