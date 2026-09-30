import "server-only";
import { findLeadEmails } from "@/server/services/lead-intelligence";
import { audit } from "@/server/audit/audit";
import { PermanentJobError, type JobHandler } from "../types";

export const findEmailsJob: JobHandler<"lead.find_email"> = async ({ leadIds }, h) => {
  if (!h.companyId) throw new PermanentJobError("Şirket bağlamı yok.");
  const res = await findLeadEmails(h.companyId, leadIds, h.progress);
  await audit({ companyId: h.companyId, userId: h.createdById, actorType: "SYSTEM", action: "lead.email_discovery.completed", metadata: { found: res.found, notFound: res.notFound, blocked: res.blocked, failed: res.failed } });
  return res;
};
