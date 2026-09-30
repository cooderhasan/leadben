import "server-only";
import { runPreparation } from "@/server/services/lead-intelligence";
import { refundCredits } from "@/server/usage/credits";
import { audit } from "@/server/audit/audit";
import { PermanentJobError, type JobHandler, type JobPayloads } from "../types";

export const prepareLeadsJob: JobHandler<"lead.prepare"> = async (payload, h) => {
  if (!h.companyId) throw new PermanentJobError("Şirket bağlamı yok.");
  const res = await runPreparation(h.companyId, payload, h.progress);
  await audit({
    companyId: h.companyId,
    userId: h.createdById,
    actorType: "AI",
    action: "lead.prepare.completed",
    metadata: { total: res.total, researched: res.researched, scored: res.scored, emailsFound: res.emailsFound, failed: res.failed, refunded: res.refunded },
  });
  return res;
};

/** İş tamamen çökerse (ör. AI hiç erişilemez) önden ayrılan kredinin tamamı iade edilir */
export async function onPrepareFailure(payload: JobPayloads["lead.prepare"]) {
  if (payload.enrichUsageId) await refundCredits(payload.enrichUsageId, "lead.prepare.failed");
  if (payload.scoreUsageId) await refundCredits(payload.scoreUsageId, "lead.prepare.failed");
}
