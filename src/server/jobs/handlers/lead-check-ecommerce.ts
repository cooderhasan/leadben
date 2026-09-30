import "server-only";
import { checkLeadsEcommerce } from "@/server/services/ecommerce-check";
import { audit } from "@/server/audit/audit";
import { PermanentJobError, type JobHandler } from "../types";

export const checkEcommerceJob: JobHandler<"lead.check_ecommerce"> = async ({ leadIds }, h) => {
  if (!h.companyId) throw new PermanentJobError("Şirket bağlamı yok.");
  const res = await checkLeadsEcommerce(h.companyId, leadIds, h.progress);
  await audit({
    companyId: h.companyId,
    userId: h.createdById,
    actorType: "SYSTEM",
    action: "lead.ecommerce_check.completed",
    metadata: { total: res.total, blocked: res.blocked, counts: res.counts },
  });
  return res;
};
