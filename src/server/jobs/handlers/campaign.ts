import "server-only";
import { generateCampaignMessages, generateStrategy } from "@/server/services/campaigns";
import { pauseAfterSendFailure, sendApprovedMessages } from "@/server/services/campaign-send";
import { refundCredits, CREDIT_COSTS } from "@/server/usage/credits";
import { audit } from "@/server/audit/audit";
import { PermanentJobError, type JobHandler, type JobPayloads } from "../types";

export const campaignStrategyJob: JobHandler<"campaign.strategy"> = async ({ campaignId }, h) => {
  if (!h.companyId) throw new PermanentJobError("Şirket bağlamı yok.");
  await h.progress(10);
  const res = await generateStrategy(h.companyId, campaignId);
  await audit({ companyId: h.companyId, userId: h.createdById, actorType: "AI", action: "campaign.strategy_generated", entityType: "Campaign", entityId: campaignId });
  return res;
};

export async function onCampaignStrategyFailure(payload: JobPayloads["campaign.strategy"]) {
  if (payload.usageId) await refundCredits(payload.usageId, "campaign.strategy.failed");
}

export const campaignMessagesJob: JobHandler<"campaign.generate_messages"> = async ({ campaignId, leadIds, usageId }, h) => {
  if (!h.companyId) throw new PermanentJobError("Şirket bağlamı yok.");
  const res = await generateCampaignMessages(h.companyId, campaignId, leadIds, h.progress);
  // Üretilemeyen / atlanan mesajların kredisi iade edilir
  const unused = (res.skipped + res.failed) * CREDIT_COSTS["ai.message"];
  if (usageId && unused > 0) await refundCredits(usageId, "campaign.messages.partial", unused);
  await audit({ companyId: h.companyId, userId: h.createdById, actorType: "AI", action: "campaign.messages_generated", entityType: "Campaign", entityId: campaignId, metadata: res });
  return res;
};

export async function onCampaignMessagesFailure(payload: JobPayloads["campaign.generate_messages"]) {
  if (payload.usageId) await refundCredits(payload.usageId, "campaign.messages.failed");
}

export const campaignSendJob: JobHandler<"campaign.send"> = async ({ campaignId }, h) => {
  if (!h.companyId) throw new PermanentJobError("Şirket bağlamı yok.");
  try {
    const res = await sendApprovedMessages(h.companyId, campaignId, h.progress);
    return { ...res };
  } catch (err) {
    const retryable = (err as { retryable?: boolean }).retryable === true;
    if (retryable && !h.isFinalAttempt) {
      // Sağlayıcı geçici hatası: runner'ın tekrar denemesi için AppError'ı düz hataya çevir
      throw new Error((err as Error).message);
    }
    // Kalıcı hata veya son deneme: kampanya duraklatılır, kullanıcı nedeni görüp sürdürür
    await pauseAfterSendFailure(h.companyId, campaignId, (err as Error).message);
    throw new PermanentJobError((err as Error).message);
  }
};
