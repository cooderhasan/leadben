import "server-only";
import { researchLead, scoreLead } from "@/server/services/lead-intelligence";
import { refundCredits } from "@/server/usage/credits";
import { audit } from "@/server/audit/audit";
import { isAppError } from "@/lib/errors";
import { PermanentJobError, type JobHandler, type JobPayloads } from "../types";

/** "AI ile Analiz Et": web sitesi araştırması → doğrulama → puanlama (tek kredi kalemi). */
export const enrichLeadJob: JobHandler<"lead.enrich"> = async ({ leadId }, h) => {
  if (!h.companyId) throw new PermanentJobError("Şirket bağlamı yok.");
  await h.progress(5);
  let research;
  try {
    research = await researchLead(h.companyId, leadId, h.progress);
  } catch (err) {
    // Site erişilemez / okunamaz → tekrar denemenin anlamı yok
    if (isAppError(err) && err.code !== "AI_UNAVAILABLE") throw new PermanentJobError(err.message);
    throw err;
  }
  await h.progress(75);
  const score = await scoreLead(h.companyId, leadId);

  await audit({
    companyId: h.companyId,
    userId: h.createdById,
    actorType: "AI",
    action: "lead.research.completed",
    entityType: "Lead",
    entityId: leadId,
    metadata: { ...research, score: score.total },
  });
  return { ...research, score: score.total };
};

export async function onLeadEnrichFailure(payload: JobPayloads["lead.enrich"]) {
  if (payload.usageId) await refundCredits(payload.usageId, "lead.enrich.failed");
}
