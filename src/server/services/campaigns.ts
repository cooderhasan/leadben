import "server-only";
import type { CampaignStatus, MessageStatus, Prisma } from "@prisma/client";
import type { z } from "zod";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { assertCan } from "@/server/tenancy/permissions";
import type { TenantContext } from "@/server/tenancy/types";
import { ai, isAIConfigured } from "@/server/ai";
import { untrusted } from "@/server/ai/guardrails";
import {
  CAMPAIGN_MESSAGE_INSTRUCTIONS,
  languageInstruction,
  isMessageLanguage,
  type MessageLanguage,
  CAMPAIGN_MESSAGE_SHAPE,
  CAMPAIGN_STRATEGY_INSTRUCTIONS,
  CAMPAIGN_STRATEGY_SHAPE,
  campaignMessageSchema,
  campaignStrategySchema,
  type CampaignStrategy,
} from "@/server/ai/prompts/campaign";
import { enqueue } from "@/server/jobs/queue";
import { isEmailConfigured } from "@/server/providers/email";
import { consumeCredits, CREDIT_COSTS, refundCredits } from "@/server/usage/credits";
import { audit } from "@/server/audit/audit";
import { buildVerifiedCompanyContext } from "./facts";
import { refreshLeadCompliance } from "./compliance";
import { checkMessageQuality, type QualityIssue } from "./message-quality";
import { getSenderSettings, senderReadiness } from "./email-settings";
import type { LeadEnrichment } from "./lead-intelligence";
import { AppError } from "@/lib/errors";
import type { campaignCreateSchema } from "@/lib/validation";

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  DRAFT: "Taslak",
  STRATEGY_REVIEW: "Strateji onayı bekliyor",
  READY: "Gönderime hazır",
  RUNNING: "Gönderiliyor",
  PAUSED: "Duraklatıldı",
  COMPLETED: "Tamamlandı",
  ARCHIVED: "Arşiv",
};

export const MESSAGE_STATUS_LABELS: Record<MessageStatus, string> = {
  DRAFT: "Taslak",
  PENDING_APPROVAL: "Onay bekliyor",
  APPROVED: "Onaylandı",
  SCHEDULED: "Gönderiliyor",
  SENT: "Gönderildi",
  DELIVERED: "Teslim edildi",
  BOUNCED: "Geri döndü",
  FAILED: "Başarısız",
  CANCELLED: "İptal",
};

const DEFAULT_MIN_SCORE = 45;
const DEFAULT_MAX_LEADS = 50;
const EXCLUDED_LEAD_STATUSES = ["SUPPRESSED", "WON", "LOST"] as const;

export interface MessageQualityNotes {
  issues: QualityIssue[];
  personalization: string[];
  blocked: boolean;
}

// ── Okuma ──────────────────────────────────────────────────────────────

export async function listCampaigns(ctx: TenantContext) {
  assertCan(ctx, "campaign.read");
  return tenantDb(ctx).campaign.findMany({
    where: { status: { not: "ARCHIVED" } },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { leads: true, messages: true } } },
  });
}

export async function getCampaign(ctx: TenantContext, id: string) {
  assertCan(ctx, "campaign.read");
  const campaign = await tenantDb(ctx).campaign.findUnique({
    where: { id },
    include: {
      products: { select: { id: true, name: true } },
      steps: { orderBy: { order: "asc" } },
      leads: {
        orderBy: [{ score: { sort: "desc", nulls: "last" } }],
        include: { lead: { select: { id: true, companyName: true, city: true, fitScore: true, genericEmail: true, status: true } } },
      },
    },
  });
  if (!campaign) throw new AppError("NOT_FOUND", "Kampanya bulunamadı.");
  return campaign;
}

export async function listCampaignMessages(ctx: TenantContext, filter: { campaignId?: string; status?: MessageStatus; take?: number } = {}) {
  assertCan(ctx, "campaign.read");
  return tenantDb(ctx).message.findMany({
    where: {
      direction: "OUTBOUND",
      ...(filter.campaignId ? { campaignId: filter.campaignId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    orderBy: [{ createdAt: "desc" }],
    take: Math.min(filter.take ?? 100, 300),
    include: {
      lead: { select: { id: true, companyName: true, city: true } },
      campaign: { select: { id: true, name: true } },
    },
  });
}

// ── Oluşturma ──────────────────────────────────────────────────────────

/**
 * Kampanya taslağı: seçilen ürünler + puan eşiğine göre lead listesi.
 * Her lead için uyum (compliance) değerlendirmesi hemen yapılır.
 */
export async function createCampaign(ctx: TenantContext, input: z.infer<typeof campaignCreateSchema>) {
  assertCan(ctx, "campaign.write");
  const db = tenantDb(ctx);

  const products = input.productIds.length
    ? await db.product.findMany({ where: { id: { in: input.productIds }, status: "VERIFIED" }, select: { id: true } })
    : [];
  if (products.length !== input.productIds.length) {
    throw new AppError("VALIDATION", "Yalnızca onaylı ürünler seçilebilir.", { productIds: "Geçersiz ürün" });
  }

  const minScore = input.minScore ?? DEFAULT_MIN_SCORE;
  const leads = await db.lead.findMany({
    where: { fitScore: { gte: minScore }, suppressed: false, status: { notIn: [...EXCLUDED_LEAD_STATUSES] } },
    orderBy: { fitScore: "desc" },
    take: input.maxLeads ?? DEFAULT_MAX_LEADS,
    select: { id: true, fitScore: true },
  });
  if (leads.length === 0) {
    throw new AppError(
      "VALIDATION",
      `Puanı ${minScore} ve üzeri olan uygun lead yok. Önce Leads ekranında lead bulup puanlayın veya eşiği düşürün.`,
      { minScore: "Uygun lead yok" },
    );
  }

  const campaign = await db.campaign.create({
    data: {
      companyId: ctx.companyId,
      name: input.name,
      targetDescription: input.targetDescription,
      language: input.language ?? "tr",
      filters: { minScore, maxLeads: input.maxLeads ?? DEFAULT_MAX_LEADS } as Prisma.InputJsonValue,
      createdById: ctx.userId,
      products: { connect: products.map((p) => ({ id: p.id })) },
    },
  });

  for (const l of leads) {
    const { best } = await refreshLeadCompliance(ctx.companyId, l.id);
    await db.campaignLead.create({
      data: {
        companyId: ctx.companyId,
        campaignId: campaign.id,
        leadId: l.id,
        score: l.fitScore,
        complianceStatus: best?.status ?? "DO_NOT_SEND",
      },
    });
  }

  await audit({
    companyId: ctx.companyId,
    userId: ctx.userId,
    action: "campaign.created",
    entityType: "Campaign",
    entityId: campaign.id,
    metadata: { leads: leads.length, minScore },
  });
  return campaign;
}

export async function removeCampaignLead(ctx: TenantContext, campaignId: string, leadId: string) {
  assertCan(ctx, "campaign.write");
  const db = tenantDb(ctx);
  await db.campaignLead.deleteMany({ where: { campaignId, leadId } });
  await db.message.updateMany({
    where: { campaignId, leadId, status: { in: ["DRAFT", "PENDING_APPROVAL", "APPROVED"] } },
    data: { status: "CANCELLED", error: "Lead kampanyadan çıkarıldı." },
  });
}

export async function archiveCampaign(ctx: TenantContext, id: string) {
  assertCan(ctx, "campaign.write");
  const db = tenantDb(ctx);
  const c = await db.campaign.findUnique({ where: { id }, select: { status: true } });
  if (!c) throw new AppError("NOT_FOUND", "Kampanya bulunamadı.");
  if (c.status === "RUNNING") throw new AppError("CONFLICT", "Gönderim sürerken arşivlenemez. Önce duraklatın.");
  await db.campaign.update({ where: { id }, data: { status: "ARCHIVED" } });
  await db.message.updateMany({
    where: { campaignId: id, status: { in: ["DRAFT", "PENDING_APPROVAL", "APPROVED"] } },
    data: { status: "CANCELLED", error: "Kampanya arşivlendi." },
  });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "campaign.archived", entityType: "Campaign", entityId: id });
}

// ── Strateji ───────────────────────────────────────────────────────────

/**
 * Mesaj kalite kontrolünün "doğrulanmış" kabul ettiği metin: yalnızca VERIFIED bilgi, onaylı ürünler
 * ve gönderici kimliği. Mesajdaki her rakam / sertifika iddiası bu metinde geçmelidir.
 */
async function verifiedCorpus(companyId: string) {
  const verified = await buildVerifiedCompanyContext({ companyId });
  const { settings } = await getSenderSettings(companyId);
  return {
    verified,
    text: JSON.stringify({ ...verified, sender: settings ? { name: settings.fromName, legalName: settings.legalName } : null }),
  };
}

export async function startStrategyGeneration(ctx: TenantContext, campaignId: string) {
  assertCan(ctx, "campaign.write");
  if (!isAIConfigured()) throw new AppError("AI_UNAVAILABLE", "AI sağlayıcısı yapılandırılmamış (.env → ANTHROPIC_API_KEY).");
  const db = tenantDb(ctx);
  const c = await db.campaign.findUnique({ where: { id: campaignId }, select: { status: true } });
  if (!c) throw new AppError("NOT_FOUND", "Kampanya bulunamadı.");
  if (!["DRAFT", "STRATEGY_REVIEW"].includes(c.status)) {
    throw new AppError("CONFLICT", "Onaylanmış kampanyanın stratejisi yeniden üretilemez.");
  }
  const running = await db.job.findFirst({
    where: { type: "campaign.strategy", status: { in: ["QUEUED", "RUNNING"] }, payload: { path: ["campaignId"], equals: campaignId } },
    select: { id: true },
  });
  if (running) return { jobId: running.id };

  const { usageId } = await consumeCredits({
    companyId: ctx.companyId,
    operation: "ai.deep_research",
    userId: ctx.userId,
    refType: "Campaign",
    refId: campaignId,
  });
  try {
    const jobId = await enqueue("campaign.strategy", { campaignId, usageId }, { companyId: ctx.companyId, createdById: ctx.userId });
    return { jobId };
  } catch (err) {
    await refundCredits(usageId, "campaign.strategy.enqueue_failed");
    throw err;
  }
}

/** Kayıttaki dil değeri geçersizse (eski kampanya) Türkçe varsayılır. */
function campaignLanguage(value: string): MessageLanguage {
  return isMessageLanguage(value) ? value : "tr";
}

/** İş içinden çağrılır. Strateji PENDING kaydedilir; insan onaylamadan mesaj üretilmez. */
export async function generateStrategy(companyId: string, campaignId: string) {
  const db = tenantDb({ companyId });
  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    include: {
      products: { where: { status: "VERIFIED" }, select: { name: true, description: true, applications: true, industries: true } },
      leads: {
        orderBy: { score: { sort: "desc", nulls: "last" } },
        take: 8,
        include: { lead: { select: { companyName: true, industry: true, city: true, aiSummary: true, fitScore: true } } },
      },
    },
  });
  if (!campaign) throw new AppError("NOT_FOUND", "Kampanya bulunamadı.");
  const { verified } = await verifiedCorpus(companyId);

  const sample = campaign.leads.map((cl) => ({
    company: cl.lead.companyName,
    industry: cl.lead.industry,
    city: cl.lead.city,
    summary: cl.lead.aiSummary?.slice(0, 400) ?? null,
    score: cl.lead.fitScore,
  }));

  const { data } = await ai({ companyId, operation: "campaign.strategy" }).extract({
    schema: campaignStrategySchema,
    instructions: `${CAMPAIGN_STRATEGY_INSTRUCTIONS}

${languageInstruction(campaignLanguage(campaign.language))}`,
    shape: CAMPAIGN_STRATEGY_SHAPE,
    input: [
      `DOĞRULANMIŞ BİLGİ (satıcı):\n${JSON.stringify({ name: verified.name, sector: verified.sector, summary: verified.summary, facts: verified.facts, rules: verified.rules })}`,
      `KAMPANYA ÜRÜNLERİ:\n${JSON.stringify(campaign.products.length ? campaign.products : verified.products.slice(0, 20))}`,
      `KAMPANYA HEDEFİ:\n${untrusted("campaign-target", campaign.targetDescription, 2000)}`,
      `ÖRNEK HEDEF FİRMALAR:\n${untrusted("lead-sample", JSON.stringify(sample), 8000)}`,
    ].join("\n\n"),
    maxTokens: 3000,
  });

  // Sıralamayı ve ilk adımı garanti et
  const sequence = [...data.sequence].sort((a, b) => a.dayOffset - b.dayOffset);
  sequence[0]!.dayOffset = 0;
  await db.campaign.update({
    where: { id: campaignId },
    data: {
      strategy: { ...data, sequence } as unknown as Prisma.InputJsonValue,
      strategyStatus: "PENDING",
      status: "STRATEGY_REVIEW",
    },
  });
  return { steps: sequence.length };
}

/**
 * Stratejiyi onaylar (isteğe bağlı düzenlemelerle). Adımlar CampaignStep olarak oluşturulur.
 * Faz 3'te yalnızca ilk adım (ilk temas) gönderilir; hatırlatma adımları Faz 4 follow-up motoruyla çalışır.
 */
export async function approveStrategy(ctx: TenantContext, campaignId: string, edits?: Partial<Pick<CampaignStrategy, "valueProposition" | "callToAction" | "tone">>) {
  assertCan(ctx, "campaign.write");
  const db = tenantDb(ctx);
  const c = await db.campaign.findUnique({ where: { id: campaignId } });
  if (!c) throw new AppError("NOT_FOUND", "Kampanya bulunamadı.");
  const parsed = campaignStrategySchema.safeParse(c.strategy);
  if (!parsed.success) throw new AppError("VALIDATION", "Önce AI stratejisi üretilmeli.");
  const strategy: CampaignStrategy = {
    ...parsed.data,
    ...(edits?.valueProposition ? { valueProposition: edits.valueProposition } : {}),
    ...(edits?.callToAction ? { callToAction: edits.callToAction } : {}),
    ...(edits?.tone ? { tone: edits.tone } : {}),
  };

  await db.campaignStep.deleteMany({ where: { campaignId } });
  for (const [i, s] of strategy.sequence.entries()) {
    await db.campaignStep.create({
      data: { companyId: ctx.companyId, campaignId, order: i + 1, dayOffset: s.dayOffset, name: s.name, instruction: s.instruction, channel: "EMAIL" },
    });
  }
  await db.campaign.update({
    where: { id: campaignId },
    data: { strategy: strategy as unknown as Prisma.InputJsonValue, strategyStatus: "VERIFIED", status: c.status === "STRATEGY_REVIEW" ? "DRAFT" : c.status },
  });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "campaign.strategy_approved", entityType: "Campaign", entityId: campaignId, metadata: { edited: Boolean(edits && Object.values(edits).some(Boolean)) } });
}

// ── Mesaj üretimi ──────────────────────────────────────────────────────

export async function startMessageGeneration(ctx: TenantContext, campaignId: string) {
  assertCan(ctx, "campaign.write");
  if (!isAIConfigured()) throw new AppError("AI_UNAVAILABLE", "AI sağlayıcısı yapılandırılmamış (.env → ANTHROPIC_API_KEY).");
  const db = tenantDb(ctx);
  const c = await db.campaign.findUnique({
    where: { id: campaignId },
    include: { leads: { select: { leadId: true, complianceStatus: true } }, steps: { orderBy: { order: "asc" }, take: 1 } },
  });
  if (!c) throw new AppError("NOT_FOUND", "Kampanya bulunamadı.");
  if (c.strategyStatus !== "VERIFIED" || !c.steps[0]) throw new AppError("VALIDATION", "Önce kampanya stratejisini onaylayın.");
  if (!["DRAFT", "READY", "PAUSED"].includes(c.status)) throw new AppError("CONFLICT", "Bu aşamada mesaj üretilemez.");

  const running = await db.job.findFirst({
    where: { type: "campaign.generate_messages", status: { in: ["QUEUED", "RUNNING"] }, payload: { path: ["campaignId"], equals: campaignId } },
    select: { id: true },
  });
  if (running) return { jobId: running.id, count: 0 };

  // Zaten ilk adım mesajı olan (iptal edilmemiş) lead'ler atlanır
  const existing = await db.message.findMany({
    where: { campaignId, campaignStepId: c.steps[0].id, status: { not: "CANCELLED" } },
    select: { leadId: true },
  });
  const done = new Set(existing.map((m) => m.leadId));
  const leadIds = c.leads.filter((l) => l.complianceStatus !== "DO_NOT_SEND" && !done.has(l.leadId)).map((l) => l.leadId);
  if (leadIds.length === 0) throw new AppError("VALIDATION", "Mesaj üretilecek uygun lead yok (tümünün mesajı var veya gönderilemez durumda).");

  const { usageId } = await consumeCredits({
    companyId: ctx.companyId,
    operation: "ai.message",
    quantity: leadIds.length,
    userId: ctx.userId,
    refType: "Campaign",
    refId: campaignId,
  });
  try {
    const jobId = await enqueue(
      "campaign.generate_messages",
      { campaignId, leadIds, usageId },
      { companyId: ctx.companyId, createdById: ctx.userId },
    );
    await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "campaign.messages_requested", entityType: "Campaign", entityId: campaignId, metadata: { count: leadIds.length } });
    return { jobId, count: leadIds.length, cost: leadIds.length * CREDIT_COSTS["ai.message"] };
  } catch (err) {
    await refundCredits(usageId, "campaign.messages.enqueue_failed");
    throw err;
  }
}

function leadPromptData(lead: {
  companyName: string;
  industry: string | null;
  city: string | null;
  aiSummary: string | null;
  enrichment: Prisma.JsonValue;
  signals: Array<{ title: string; type: string }>;
}, contactName: string | null) {
  const e = (lead.enrichment ?? null) as LeadEnrichment | null;
  return {
    companyName: lead.companyName,
    contactName,
    industry: lead.industry,
    city: lead.city,
    summary: lead.aiSummary,
    products: e?.products ?? [],
    verifiedFacts: e?.verified.map((v) => v.statement) ?? [],
    signals: lead.signals.map((s) => s.title),
  };
}

/** İş içinden çağrılır. Her lead için tek mesaj üretir; her mesaj insan onayı bekler. */
export async function generateCampaignMessages(
  companyId: string,
  campaignId: string,
  leadIds: string[],
  progress?: (pct: number) => Promise<void>,
) {
  const db = tenantDb({ companyId });
  const campaign = await db.campaign.findUnique({
    where: { id: campaignId },
    include: {
      steps: { orderBy: { order: "asc" }, take: 1 },
      products: { where: { status: "VERIFIED", active: true }, select: { name: true, description: true, applications: true, industries: true } },
    },
  });
  if (!campaign?.steps[0]) throw new AppError("NOT_FOUND", "Kampanya veya ilk adım bulunamadı.");
  const step = campaign.steps[0];
  const lang = campaignLanguage(campaign.language);
  const strategy = campaignStrategySchema.parse(campaign.strategy);
  const { verified, text: corpus } = await verifiedCorpus(companyId);
  const { settings } = await getSenderSettings(companyId);
  const products = campaign.products.length ? campaign.products : verified.products;

  let created = 0;
  let skipped = 0;
  let failed = 0;
  for (let i = 0; i < leadIds.length; i++) {
    const leadId = leadIds[i]!;
    try {
      const { best } = await refreshLeadCompliance(companyId, leadId);
      if (!best || best.status === "DO_NOT_SEND") {
        await db.campaignLead.updateMany({ where: { campaignId, leadId }, data: { complianceStatus: best?.status ?? "DO_NOT_SEND" } });
        skipped++;
        continue;
      }
      const lead = await db.lead.findUnique({
        where: { id: leadId },
        include: { signals: { where: { verified: true }, take: 5, select: { title: true, type: true } } },
      });
      if (!lead) {
        skipped++;
        continue;
      }
      const contact = best.contactId ? await db.leadContact.findUnique({ where: { id: best.contactId }, select: { fullName: true } }) : null;
      const leadData = leadPromptData(lead, contact?.fullName ?? null);

      const { data } = await ai({ companyId, operation: "campaign.message" }).extract({
        schema: campaignMessageSchema,
        instructions: `${CAMPAIGN_MESSAGE_INSTRUCTIONS}

${languageInstruction(lang)}`,
        shape: CAMPAIGN_MESSAGE_SHAPE,
        input: [
          `DOĞRULANMIŞ BİLGİ (satıcı):\n${JSON.stringify({ name: verified.name, summary: verified.summary, facts: verified.facts })}`,
          `ÜRÜNLER:\n${JSON.stringify(products.slice(0, 15))}`,
          `STRATEJİ:\n${JSON.stringify({ valueProposition: strategy.valueProposition, keyMessages: strategy.keyMessages, callToAction: strategy.callToAction, tone: strategy.tone })}`,
          `ADIM TALİMATI: ${step.instruction ?? step.name}`,
          `GÖNDEREN: ${settings?.fromName ?? verified.name}`,
          `LEAD VERİSİ:\n${untrusted("lead-data", JSON.stringify(leadData), 8000)}`,
        ].join("\n\n"),
        tier: "default",
        maxTokens: 1200,
      });

      const quality = checkMessageQuality({ subject: data.subject, body: data.body }, corpus, JSON.stringify(leadData));
      const notes: MessageQualityNotes = { issues: quality.issues, personalization: data.personalization, blocked: quality.blocked };
      await db.message.create({
        data: {
          companyId,
          campaignId,
          campaignStepId: step.id,
          leadId,
          contactId: best.contactId,
          channel: "EMAIL",
          toAddress: best.address,
          subject: data.subject.trim(),
          body: data.body.trim(),
          status: "PENDING_APPROVAL",
          qualityScore: quality.score,
          qualityNotes: notes as unknown as Prisma.InputJsonValue,
          complianceStatus: best.status,
        },
      });
      await db.campaignLead.updateMany({ where: { campaignId, leadId }, data: { complianceStatus: best.status } });
      created++;
    } catch (err) {
      if (err instanceof AppError && err.code === "AI_UNAVAILABLE" && created === 0) throw err;
      failed++;
    }
    await progress?.(((i + 1) / leadIds.length) * 95);
  }
  return { created, skipped, failed };
}

// ── Mesaj onayı / düzenleme ────────────────────────────────────────────

export async function updateMessage(ctx: TenantContext, input: { id: string; subject: string; body: string }) {
  assertCan(ctx, "message.approve");
  const db = tenantDb(ctx);
  const msg = await db.message.findUnique({ where: { id: input.id }, include: { lead: { select: { companyName: true, aiSummary: true, enrichment: true, industry: true, city: true } } } });
  if (!msg) throw new AppError("NOT_FOUND", "Mesaj bulunamadı.");
  if (!["DRAFT", "PENDING_APPROVAL", "APPROVED"].includes(msg.status)) throw new AppError("CONFLICT", "Gönderilmiş veya iptal edilmiş mesaj düzenlenemez.");
  const { text: corpus } = await verifiedCorpus(ctx.companyId);
  const quality = checkMessageQuality(input, corpus, JSON.stringify(msg.lead));
  const prev = (msg.qualityNotes ?? {}) as Partial<MessageQualityNotes>;
  await db.message.update({
    where: { id: msg.id },
    data: {
      subject: input.subject,
      body: input.body,
      status: "PENDING_APPROVAL",
      approvedById: null,
      approvedAt: null,
      qualityScore: quality.score,
      qualityNotes: { issues: quality.issues, personalization: prev.personalization ?? [], blocked: quality.blocked } as unknown as Prisma.InputJsonValue,
    },
  });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "message.edited", entityType: "Message", entityId: msg.id });
  return quality;
}

/** İnsan onayı. Engelleyici kalite sorunu olan veya gönderilemez adrese giden mesaj onaylanamaz. */
export async function approveMessages(ctx: TenantContext, ids: string[]) {
  assertCan(ctx, "message.approve");
  const db = tenantDb(ctx);
  const msgs = await db.message.findMany({ where: { id: { in: ids }, status: "PENDING_APPROVAL" } });
  let approved = 0;
  const rejected: Array<{ id: string; reason: string }> = [];
  for (const m of msgs) {
    const notes = (m.qualityNotes ?? {}) as Partial<MessageQualityNotes>;
    if (notes.blocked) {
      rejected.push({ id: m.id, reason: "Doğrulanmamış iddia veya yer tutucu var — önce düzenleyin." });
      continue;
    }
    if (m.complianceStatus === "DO_NOT_SEND") {
      rejected.push({ id: m.id, reason: "Adres gönderilemez durumda." });
      continue;
    }
    await db.message.update({ where: { id: m.id }, data: { status: "APPROVED", approvedById: ctx.userId, approvedAt: new Date() } });
    approved++;
  }
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "message.approved", metadata: { approved, rejected: rejected.length } });
  return { approved, rejected };
}

export async function cancelMessage(ctx: TenantContext, id: string) {
  assertCan(ctx, "message.approve");
  const res = await tenantDb(ctx).message.updateMany({
    where: { id, status: { in: ["DRAFT", "PENDING_APPROVAL", "APPROVED"] } },
    data: { status: "CANCELLED", error: "Kullanıcı iptal etti." },
  });
  if (res.count === 0) throw new AppError("NOT_FOUND", "İptal edilebilir mesaj bulunamadı.");
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "message.cancelled", entityType: "Message", entityId: id });
}

// ── Önizleme, onay, gönderim ───────────────────────────────────────────

export async function campaignPreview(ctx: TenantContext, campaignId: string) {
  assertCan(ctx, "campaign.read");
  const db = tenantDb(ctx);
  const [c, byCompliance, byMessage, samples] = await Promise.all([
    db.campaign.findUnique({ where: { id: campaignId }, select: { id: true, status: true, strategyStatus: true } }),
    db.campaignLead.groupBy({ by: ["complianceStatus"], where: { campaignId }, _count: { _all: true } }),
    db.message.groupBy({ by: ["status"], where: { campaignId }, _count: { _all: true } }),
    db.message.findMany({
      where: { campaignId, status: { in: ["PENDING_APPROVAL", "APPROVED"] } },
      orderBy: { qualityScore: "desc" },
      take: 3,
      select: { id: true, subject: true, body: true, toAddress: true, lead: { select: { companyName: true } } },
    }),
  ]);
  if (!c) throw new AppError("NOT_FOUND", "Kampanya bulunamadı.");
  const count = (arr: Array<{ _count: { _all: number } } & Record<string, unknown>>, key: string, value: unknown) =>
    arr.filter((r) => r[key] === value).reduce((s, r) => s + r._count._all, 0);
  const totalLeads = byCompliance.reduce((s, r) => s + r._count._all, 0);
  const highScore = await db.campaignLead.count({ where: { campaignId, score: { gte: 70 } } });
  const suppressed = await db.campaignLead.count({ where: { campaignId, lead: { suppressed: true } } });
  const { settings, dns } = await getSenderSettings(ctx.companyId);

  return {
    totalLeads,
    sendable: count(byCompliance, "complianceStatus", "SENDABLE"),
    review: count(byCompliance, "complianceStatus", "REVIEW_REQUIRED"),
    doNotSend: count(byCompliance, "complianceStatus", "DO_NOT_SEND") + count(byCompliance, "complianceStatus", null),
    suppressed,
    highScore,
    messages: Object.fromEntries(byMessage.map((m) => [m.status, m._count._all])) as Partial<Record<MessageStatus, number>>,
    samples,
    emailConfigured: isEmailConfigured(),
    senderIssues: senderReadiness(settings, dns),
  };
}

/** "Kampanyayı Onayla" — yönetici onayı. Onaysız kampanya gönderilemez. */
export async function approveCampaign(ctx: TenantContext, campaignId: string) {
  assertCan(ctx, "campaign.approve");
  const db = tenantDb(ctx);
  const c = await db.campaign.findUnique({ where: { id: campaignId }, select: { status: true, strategyStatus: true } });
  if (!c) throw new AppError("NOT_FOUND", "Kampanya bulunamadı.");
  if (c.strategyStatus !== "VERIFIED") throw new AppError("VALIDATION", "Strateji onaylanmadan kampanya onaylanamaz.");
  if (!["DRAFT", "PAUSED"].includes(c.status)) throw new AppError("CONFLICT", "Kampanya bu durumda onaylanamaz.");
  const approvedMessages = await db.message.count({ where: { campaignId, status: "APPROVED" } });
  if (approvedMessages === 0) throw new AppError("VALIDATION", "En az bir mesajı onaylamadan kampanya onaylanamaz.");
  await db.campaign.update({ where: { id: campaignId }, data: { status: "READY", approvedById: ctx.userId, approvedAt: new Date() } });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "campaign.approved", entityType: "Campaign", entityId: campaignId, metadata: { approvedMessages } });
}

export async function startSending(ctx: TenantContext, campaignId: string) {
  assertCan(ctx, "email.send");
  const db = tenantDb(ctx);
  const c = await db.campaign.findUnique({ where: { id: campaignId }, select: { status: true, approvedAt: true } });
  if (!c) throw new AppError("NOT_FOUND", "Kampanya bulunamadı.");
  if (!c.approvedAt || !["READY", "PAUSED", "RUNNING"].includes(c.status)) {
    throw new AppError("VALIDATION", "Gönderim için kampanya önce onaylanmalı.");
  }
  if (!isEmailConfigured()) throw new AppError("VALIDATION", "E-posta sağlayıcısı yapılandırılmamış (EMAIL_PROVIDER). Gönderim yapılamaz.");
  const { settings, dns } = await getSenderSettings(ctx.companyId);
  const issues = senderReadiness(settings, dns);
  if (!settings) throw new AppError("VALIDATION", issues[0] ?? "Gönderici kimliği eksik.");

  const running = await db.job.findFirst({
    where: { type: "campaign.send", status: { in: ["QUEUED", "RUNNING"] }, payload: { path: ["campaignId"], equals: campaignId } },
    select: { id: true },
  });
  if (running) return { jobId: running.id };

  await db.campaign.update({ where: { id: campaignId }, data: { status: "RUNNING", startedAt: c.status === "READY" ? new Date() : undefined } });
  const jobId = await enqueue("campaign.send", { campaignId }, { companyId: ctx.companyId, createdById: ctx.userId });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "campaign.sending_started", entityType: "Campaign", entityId: campaignId });
  return { jobId };
}

export async function pauseCampaign(ctx: TenantContext, campaignId: string) {
  assertCan(ctx, "email.send");
  const res = await tenantDb(ctx).campaign.updateMany({ where: { id: campaignId, status: { in: ["RUNNING", "READY"] } }, data: { status: "PAUSED" } });
  if (res.count === 0) throw new AppError("CONFLICT", "Duraklatılacak aktif gönderim yok.");
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "campaign.paused", entityType: "Campaign", entityId: campaignId });
}

export async function getActiveCampaignJob(ctx: TenantContext, campaignId: string) {
  assertCan(ctx, "campaign.read");
  return tenantDb(ctx).job.findFirst({
    where: {
      type: { in: ["campaign.strategy", "campaign.generate_messages", "campaign.send"] },
      status: { in: ["QUEUED", "RUNNING"] },
      payload: { path: ["campaignId"], equals: campaignId },
    },
    select: { id: true, type: true },
  });
}

export async function getLastCampaignJob(ctx: TenantContext, campaignId: string) {
  return tenantDb(ctx).job.findFirst({
    where: { payload: { path: ["campaignId"], equals: campaignId } },
    orderBy: { createdAt: "desc" },
    select: { type: true, status: true, error: true, result: true, finishedAt: true },
  });
}

// ── Seçilen lead'leri kampanyaya ekleme (toplu işlem) ─────────────────

/** Lead eklenebilen kampanya aşamaları (gönderim bitmemiş / arşivlenmemiş) */
export const CAMPAIGN_OPEN_STATUSES: CampaignStatus[] = ["DRAFT", "STRATEGY_REVIEW", "READY", "PAUSED", "RUNNING"];

export async function listOpenCampaigns(ctx: TenantContext) {
  assertCan(ctx, "campaign.read");
  return tenantDb(ctx).campaign.findMany({
    where: { status: { in: CAMPAIGN_OPEN_STATUSES } },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, name: true, status: true },
  });
}

/**
 * Seçilen lead'leri mevcut kampanyaya ekler. Engellenen / kazanılan / kaybedilen ve zaten ekli olanlar atlanır;
 * her lead için gönderim uygunluğu hemen değerlendirilir. Mesajları "Mesajları üret" ile ayrıca üretilir.
 */
export async function addLeadsToCampaign(ctx: TenantContext, campaignId: string, leadIds: string[]) {
  assertCan(ctx, "campaign.write");
  const db = tenantDb(ctx);
  const campaign = await db.campaign.findUnique({ where: { id: campaignId }, select: { id: true, status: true, name: true } });
  if (!campaign) throw new AppError("NOT_FOUND", "Kampanya bulunamadı.");
  if (!CAMPAIGN_OPEN_STATUSES.includes(campaign.status)) throw new AppError("CONFLICT", "Bu kampanyaya artık lead eklenemez.");

  const already = new Set((await db.campaignLead.findMany({ where: { campaignId }, select: { leadId: true } })).map((c) => c.leadId));
  const leads = await db.lead.findMany({
    where: { id: { in: [...new Set(leadIds)] }, suppressed: false, status: { notIn: [...EXCLUDED_LEAD_STATUSES] } },
    select: { id: true, fitScore: true },
  });
  // Başka bir açık kampanyada olan firmalar: ekip içi çakışma uyarısı (alıcıyı sıklık kuralları korur)
  const inOther = new Set(
    (
      await db.campaignLead.findMany({
        where: { leadId: { in: leads.map((l) => l.id) }, campaignId: { not: campaignId }, campaign: { status: { in: CAMPAIGN_OPEN_STATUSES } } },
        select: { leadId: true },
      })
    ).map((c) => c.leadId),
  );
  let added = 0;
  let noEmail = 0;
  for (const l of leads) {
    if (already.has(l.id)) continue;
    const { best } = await refreshLeadCompliance(ctx.companyId, l.id);
    const complianceStatus = best?.status ?? "DO_NOT_SEND";
    if (!best) noEmail++;
    await db.campaignLead.create({ data: { companyId: ctx.companyId, campaignId, leadId: l.id, score: l.fitScore, complianceStatus } });
    added++;
  }
  const skipped = leadIds.length - added;
  const alsoInOther = leads.filter((l) => inOther.has(l.id) && !already.has(l.id)).length;
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "campaign.leads_added", entityType: "Campaign", entityId: campaignId, metadata: { added, skipped } });
  return { added, skipped, noEmail, alsoInOther, campaignName: campaign.name };
}
