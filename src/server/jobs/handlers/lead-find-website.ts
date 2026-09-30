import "server-only";
import type { Prisma } from "@prisma/client";
import { rawDb } from "@/server/db";
import { runWebsiteDiscovery } from "@/server/services/lead-intelligence";
import { refundCredits } from "@/server/usage/credits";
import { audit } from "@/server/audit/audit";
import { PermanentJobError, type JobHandler, type JobPayloads } from "../types";

export const findWebsitesJob: JobHandler<"lead.find_website"> = async (payload, h) => {
  if (!h.companyId) throw new PermanentJobError("Şirket bağlamı yok.");
  const res = await runWebsiteDiscovery(h.companyId, payload, {
    progress: h.progress,
    // Tekrar denemede yeni (ücretli) arama başlatılmaz; aynı çalıştırmadan devam edilir
    saveRunId: async (runId) => {
      await rawDb.job.update({ where: { id: h.jobId }, data: { payload: { ...payload, runId } as unknown as Prisma.InputJsonValue } });
    },
  });
  await audit({
    companyId: h.companyId,
    userId: h.createdById,
    actorType: "SYSTEM",
    action: "lead.website_discovery.completed",
    metadata: { total: res.total, found: res.found, notFound: res.notFound },
  });
  return res;
};

export async function onFindWebsiteFailure(payload: JobPayloads["lead.find_website"]) {
  if (payload.usageId) await refundCredits(payload.usageId, "lead.find_website.failed");
}
