import "server-only";
import type { Message, Prisma } from "@prisma/client";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { assertCan } from "@/server/tenancy/permissions";
import type { TenantContext } from "@/server/tenancy/types";
import { ai, isAIConfigured } from "@/server/ai";
import { untrusted } from "@/server/ai/guardrails";
import { CAMPAIGN_MESSAGE_INSTRUCTIONS, CAMPAIGN_MESSAGE_SHAPE, campaignMessageSchema, campaignStrategySchema, isMessageLanguage, languageInstruction } from "@/server/ai/prompts/campaign";
import { consumeCredits, refundCredits } from "@/server/usage/credits";
import { audit } from "@/server/audit/audit";
import { AppError, isAppError } from "@/lib/errors";
import { buildVerifiedCompanyContext } from "./facts";
import { getSenderSettings } from "./email-settings";
import { checkMessageQuality } from "./message-quality";
import { findSuppression } from "./compliance";

const DAY = 86_400_000;
/** Bu durumlardaki lead'e hatırlatma yazılmaz */
const STOP_STATUSES = ["REPLIED", "INTERESTED", "QUALIFIED_OPPORTUNITY", "QUOTE_REQUESTED", "PROPOSAL_SENT", "NEGOTIATION", "WON", "LOST", "NURTURE", "SUPPRESSED"] as const;

export const FOLLOWUP_STATUS_LABELS = { SCHEDULED: "Planlandı", SENT: "Taslak hazırlandı", SKIPPED: "Atlandı", CANCELLED: "İptal" } as const;

/**
 * Kampanya adımı gönderildiğinde sonraki adımları planlar (stratejideki "Gün 3 hatırlatma" gibi).
 * Aynı lead + adım için ikinci plan oluşturulmaz.
 */
export async function scheduleFollowUpsAfterSend(companyId: string, msg: Pick<Message, "id" | "leadId" | "campaignId" | "campaignStepId" | "sentAt">) {
  if (!msg.campaignId || !msg.campaignStepId || !msg.sentAt) return 0;
  const db = tenantDb({ companyId });
  const current = await db.campaignStep.findUnique({ where: { id: msg.campaignStepId } });
  if (!current) return 0;
  const later = await db.campaignStep.findMany({
    where: { campaignId: msg.campaignId, order: { gt: current.order }, channel: "EMAIL" },
    orderBy: { order: "asc" },
  });
  let created = 0;
  for (const step of later) {
    const exists = await db.followUp.findFirst({ where: { leadId: msg.leadId, campaignStepId: step.id } });
    if (exists) continue;
    const days = Math.max(1, step.dayOffset - current.dayOffset);
    await db.followUp.create({
      data: {
        companyId,
        leadId: msg.leadId,
        campaignId: msg.campaignId,
        campaignStepId: step.id,
        messageId: msg.id,
        scheduledAt: new Date(msg.sentAt.getTime() + days * DAY),
      },
    });
    created++;
  }
  return created;
}

/** Yanıt geldiğinde / lead çıkarıldığında bekleyen hatırlatmalar ve onaylanmamış hatırlatma taslakları iptal edilir. */
export async function cancelFollowUpsForLead(companyId: string, leadId: string, reason: string) {
  const db = tenantDb({ companyId });
  const f = await db.followUp.updateMany({ where: { leadId, status: "SCHEDULED" }, data: { status: "CANCELLED", skipReason: reason } });
  // Kampanyanın 2+ adımına ait gönderilmemiş taslaklar
  const drafts = await db.message.findMany({
    where: { leadId, status: { in: ["DRAFT", "PENDING_APPROVAL", "APPROVED"] }, campaignStep: { order: { gt: 1 } } },
    select: { id: true },
  });
  if (drafts.length) {
    await db.message.updateMany({ where: { id: { in: drafts.map((d) => d.id) } }, data: { status: "CANCELLED", error: reason } });
  }
  return f.count + drafts.length;
}

export interface FollowUpRunResult {
  drafted: number;
  skipped: number;
  waiting: number;
}

/**
 * Vakti gelmiş hatırlatmaları işler (zamanlayıcı işi çağırır). Her biri için:
 * yanıt / ret / durum kontrolü → AI hatırlatma taslağı (1 kredi) → PENDING_APPROVAL.
 * Hatırlatmalar da otomatik gönderilmez; kullanıcı onaylayıp kampanyadan gönderir.
 */
export async function processDueFollowUps(companyId: string, now = new Date()): Promise<FollowUpRunResult> {
  const db = tenantDb({ companyId });
  const due = await db.followUp.findMany({
    where: { status: "SCHEDULED", scheduledAt: { lte: now } },
    orderBy: { scheduledAt: "asc" },
    take: 50,
    include: {
      campaign: { select: { id: true, status: true, strategy: true, strategyStatus: true, language: true } },
      campaignStep: true,
      message: true,
      lead: { select: { id: true, status: true, suppressed: true, companyName: true, aiSummary: true, industry: true } },
    },
  });
  const result: FollowUpRunResult = { drafted: 0, skipped: 0, waiting: 0 };
  if (due.length === 0) return result;

  const verified = await buildVerifiedCompanyContext({ companyId });
  const { settings } = await getSenderSettings(companyId);
  const corpus = JSON.stringify({ ...verified, sender: settings ? { name: settings.fromName, legalName: settings.legalName } : null });
  const touchedCampaigns = new Set<string>();

  for (const f of due) {
    const skip = async (reason: string, status: "SKIPPED" | "CANCELLED" = "SKIPPED") => {
      await db.followUp.update({ where: { id: f.id }, data: { status, skipReason: reason } });
      result.skipped++;
    };
    if (!f.campaign || !f.campaignStep || !f.message?.sentAt || !f.message.toAddress) {
      await skip("Kampanya adımı veya ilk ileti bulunamadı.", "CANCELLED");
      continue;
    }
    if (f.campaign.status === "ARCHIVED") {
      await skip("Kampanya arşivlendi.", "CANCELLED");
      continue;
    }
    if (f.campaign.status === "PAUSED") {
      result.waiting++;
      continue; // duraklatılmış kampanyanın hatırlatması bekler
    }
    if (f.lead.suppressed || (STOP_STATUSES as readonly string[]).includes(f.lead.status)) {
      await skip("Lead yanıt verdi veya süreç ilerledi.");
      continue;
    }
    const replied = await db.conversationMessage.count({
      where: { direction: "INBOUND", receivedAt: { gte: f.message.sentAt }, conversation: { leadId: f.leadId } },
    });
    if (replied > 0) {
      await skip("Yanıt geldi.");
      continue;
    }
    if (await findSuppression(companyId, { email: f.message.toAddress, leadId: f.leadId })) {
      await skip("Alıcı ret/engel listesinde.", "CANCELLED");
      continue;
    }
    if (!isAIConfigured()) {
      result.waiting++;
      continue;
    }

    let usageId: string;
    try {
      ({ usageId } = await consumeCredits({ companyId, operation: "ai.message", refType: "FollowUp", refId: f.id }));
    } catch (err) {
      if (isAppError(err) && err.code === "INSUFFICIENT_CREDITS") {
        // Kredi yüklenince sonraki çalıştırmada devam eder
        result.waiting += due.length - (result.drafted + result.skipped + result.waiting);
        break;
      }
      throw err;
    }

    try {
      const strategy = campaignStrategySchema.safeParse(f.campaign.strategy);
      const { data } = await ai({ companyId, operation: "followup.draft" }).extract({
        schema: campaignMessageSchema,
        instructions: `${CAMPAIGN_MESSAGE_INSTRUCTIONS}

${languageInstruction(isMessageLanguage(f.campaign.language) ? f.campaign.language : "tr")}

BU BİR HATIRLATMA E-POSTASIDIR:
- Alıcı önceki e-postaya yanıt vermedi. Kısa ve nazik bir hatırlatma yaz (en fazla 80 kelime).
- Önceki e-postayı tekrar etme; tek cümleyle hatırlat ve tek, kolay bir çağrı yap.
- Konu satırı önceki konunun başına "Re: " eklenmiş hali olabilir.`,
        shape: CAMPAIGN_MESSAGE_SHAPE,
        input: [
          `DOĞRULANMIŞ BİLGİ (satıcı):\n${JSON.stringify({ name: verified.name, summary: verified.summary, facts: verified.facts })}`,
          strategy.success ? `STRATEJİ:\n${JSON.stringify({ valueProposition: strategy.data.valueProposition, callToAction: strategy.data.callToAction, tone: strategy.data.tone })}` : "",
          `ADIM TALİMATI: ${f.campaignStep.instruction ?? f.campaignStep.name}`,
          `ÖNCEKİ E-POSTA (bizim gönderdiğimiz):\nKonu: ${f.message.subject ?? ""}\n${f.message.body.slice(0, 3000)}`,
          `LEAD VERİSİ:\n${untrusted("lead-data", JSON.stringify({ companyName: f.lead.companyName, industry: f.lead.industry, summary: f.lead.aiSummary }), 4000)}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
        maxTokens: 800,
      });
      const quality = checkMessageQuality({ subject: data.subject, body: data.body }, corpus, JSON.stringify(f.lead));
      const draft = await db.message.create({
        data: {
          companyId,
          campaignId: f.campaign.id,
          campaignStepId: f.campaignStep.id,
          leadId: f.leadId,
          contactId: f.message.contactId,
          conversationId: f.message.conversationId,
          channel: "EMAIL",
          toAddress: f.message.toAddress,
          subject: data.subject.trim(),
          body: data.body.trim(),
          status: "PENDING_APPROVAL",
          qualityScore: quality.score,
          qualityNotes: { issues: quality.issues, personalization: data.personalization, blocked: quality.blocked } as unknown as Prisma.InputJsonValue,
          complianceStatus: f.message.complianceStatus,
        },
      });
      await db.followUp.update({ where: { id: f.id }, data: { status: "SENT", messageId: draft.id } });
      touchedCampaigns.add(f.campaign.id);
      result.drafted++;
    } catch (err) {
      await refundCredits(usageId, "followup.draft.failed");
      if (isAppError(err) && err.code === "AI_UNAVAILABLE") {
        result.waiting++;
        break; // AI geçici olarak yok; sonraki çalıştırmada tekrar denenir
      }
      await skip(`Taslak üretilemedi: ${(err as Error).message.slice(0, 200)}`);
    }
  }

  // Tamamlanmış kampanyada yeni onay bekleyen taslak varsa kampanya tekrar "hazır" olur
  for (const id of touchedCampaigns) {
    await db.campaign.updateMany({ where: { id, status: "COMPLETED", approvedAt: { not: null } }, data: { status: "READY", completedAt: null } });
  }
  if (result.drafted || result.skipped) {
    await audit({ companyId, actorType: "SYSTEM", action: "followup.processed", metadata: { ...result } });
  }
  return result;
}

export async function listFollowUps(ctx: TenantContext, filter: { leadId?: string; campaignId?: string } = {}) {
  assertCan(ctx, "campaign.read");
  return tenantDb(ctx).followUp.findMany({
    where: { ...(filter.leadId ? { leadId: filter.leadId } : {}), ...(filter.campaignId ? { campaignId: filter.campaignId } : {}) },
    orderBy: { scheduledAt: "asc" },
    take: 200,
    include: { campaignStep: { select: { name: true, order: true } }, lead: { select: { companyName: true } } },
  });
}

export async function cancelFollowUp(ctx: TenantContext, id: string) {
  assertCan(ctx, "campaign.write");
  const res = await tenantDb(ctx).followUp.updateMany({ where: { id, status: "SCHEDULED" }, data: { status: "CANCELLED", skipReason: "Kullanıcı iptal etti." } });
  if (res.count === 0) throw new AppError("NOT_FOUND", "Planlı hatırlatma bulunamadı.");
}
