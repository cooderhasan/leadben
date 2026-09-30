import "server-only";
import { scoreLeads } from "@/server/services/lead-intelligence";
import { refundCredits, CREDIT_COSTS } from "@/server/usage/credits";
import { audit } from "@/server/audit/audit";
import { PermanentJobError, type JobHandler, type JobPayloads } from "../types";

export const scoreLeadsJob: JobHandler<"lead.score"> = async ({ leadIds, usageId }, h) => {
  if (!h.companyId) throw new PermanentJobError("Şirket bağlamı yok.");
  const res = await scoreLeads(h.companyId, leadIds, h.progress);
  // Puanlanamayan lead'lerin kredisi iade edilir
  if (usageId && res.failed > 0) await refundCredits(usageId, "lead.score.partial", res.failed * CREDIT_COSTS["lead.score"]);
  await audit({
    companyId: h.companyId,
    userId: h.createdById,
    actorType: "AI",
    action: "lead.scoring.completed",
    metadata: res,
  });
  return res;
};

export async function onLeadScoreFailure(payload: JobPayloads["lead.score"]) {
  if (payload.usageId) await refundCredits(payload.usageId, "lead.score.failed");
}
