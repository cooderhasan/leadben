import "server-only";
import { classifyReply } from "@/server/services/conversations";
import { sendSingleApprovedMessage } from "@/server/services/campaign-send";
import { processDueFollowUps } from "@/server/services/followups";
import { draftProposal } from "@/server/services/proposals";
import { consumeCredits, refundCredits } from "@/server/usage/credits";
import { scanCompetitor } from "@/server/services/competitors";
import { deliverWebhook } from "@/server/services/integrations";
import type { JobPayloads } from "../types";
import { isAppError } from "@/lib/errors";
import { PermanentJobError, type JobHandler } from "../types";

export const classifyReplyJob: JobHandler<"conversation.classify"> = async ({ conversationMessageId }, h) => {
  if (!h.companyId) throw new PermanentJobError("Şirket bağlamı yok.");
  return classifyReply(h.companyId, conversationMessageId);
};

export const sendMessageJob: JobHandler<"message.send"> = async ({ messageId }, h) => {
  if (!h.companyId) throw new PermanentJobError("Şirket bağlamı yok.");
  try {
    return { outcome: await sendSingleApprovedMessage(h.companyId, messageId) };
  } catch (err) {
    // Sağlayıcı geçici hatası tekrar denenir; diğerleri kalıcıdır
    if ((err as { retryable?: boolean }).retryable === true && !h.isFinalAttempt) throw new Error((err as Error).message);
    if (isAppError(err) || (err as { retryable?: boolean }).retryable === true) throw new PermanentJobError((err as Error).message);
    throw err;
  }
};

export const followUpRunJob: JobHandler<"followup.run"> = async (_payload, h) => {
  if (!h.companyId) throw new PermanentJobError("Şirket bağlamı yok.");
  return { ...(await processDueFollowUps(h.companyId)) };
};

export const proposalDraftJob: JobHandler<"proposal.draft"> = async ({ proposalId }, h) => {
  if (!h.companyId) throw new PermanentJobError("Şirket bağlamı yok.");
  return draftProposal(h.companyId, proposalId);
};

export async function onProposalDraftFailure(payload: JobPayloads["proposal.draft"]) {
  if (payload.usageId) await refundCredits(payload.usageId, "proposal.draft.failed");
}

export const competitorScanJob: JobHandler<"competitor.scan"> = async ({ competitorId, usageId }, h) => {
  if (!h.companyId) throw new PermanentJobError("Şirket bağlamı yok.");
  let charged = usageId;
  if (!charged) {
    // Zamanlayıcıdan gelen haftalık tarama: kredi yoksa sessizce atla
    try {
      charged = (await consumeCredits({ companyId: h.companyId, operation: "website.analyze", refType: "Competitor", refId: competitorId })).usageId;
    } catch (err) {
      if (isAppError(err) && err.code === "INSUFFICIENT_CREDITS") return { skipped: "insufficient_credits" };
      throw err;
    }
  }
  try {
    const res = await scanCompetitor(h.companyId, competitorId);
    // Değişiklik yoksa AI kullanılmadı → kredi iade
    if (!res.aiUsed) await refundCredits(charged, "competitor.scan.no_change");
    return { ...res };
  } catch (err) {
    const willRetry = !h.isFinalAttempt && !isAppError(err);
    // Bu denemede düşülen kredi (zamanlayıcı yolu) her denemede iade edilir; kullanıcı yolunda yalnızca son denemede
    if (!usageId || !willRetry) await refundCredits(charged, "competitor.scan.failed");
    if (willRetry) throw err;
    throw isAppError(err) ? new PermanentJobError(err.message) : err;
  }
};

export const webhookDeliverJob: JobHandler<"webhook.deliver"> = async (payload, h) => {
  if (!h.companyId) throw new PermanentJobError("Şirket bağlamı yok.");
  return deliverWebhook(h.companyId, payload, h.isFinalAttempt);
};
