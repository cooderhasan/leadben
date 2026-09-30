import "server-only";
import type { OpportunityStage, Prisma, ReplyCategory, LeadStatus } from "@prisma/client";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { assertCan } from "@/server/tenancy/permissions";
import type { TenantContext } from "@/server/tenancy/types";
import { ai, isAIConfigured } from "@/server/ai";
import { untrusted } from "@/server/ai/guardrails";
import {
  REPLY_CLASSIFICATION_INSTRUCTIONS,
  REPLY_CLASSIFICATION_SHAPE,
  REPLY_DRAFT_INSTRUCTIONS,
  REPLY_DRAFT_SHAPE,
  replyClassificationSchema,
  replyDraftSchema,
  type ReplyClassification,
} from "@/server/ai/prompts/reply";
import { enqueue } from "@/server/jobs/queue";
import { isEmailConfigured } from "@/server/providers/email";
import { consumeCredits, refundCredits } from "@/server/usage/credits";
import { audit } from "@/server/audit/audit";
import { AppError } from "@/lib/errors";
import { extractDomain, isGenericHost, normalizeEmail } from "@/lib/lead-normalize";
import { addSuppression } from "./compliance";
import { cancelFollowUpsForLead } from "./followups";
import { buildVerifiedCompanyContext } from "./facts";
import { getSenderSettings } from "./email-settings";
import { checkMessageQuality } from "./message-quality";
import { emitEvent } from "./integrations";

export const REPLY_CATEGORY_LABELS: Record<ReplyCategory, string> = {
  INTERESTED: "İlgileniyor",
  NOT_INTERESTED: "İlgilenmiyor",
  PRICING: "Fiyat soruyor",
  CATALOG_REQUEST: "Katalog istiyor",
  TECHNICAL_QUESTION: "Teknik soru",
  REQUEST_FOR_CALL: "Görüşme istiyor",
  REQUEST_FOR_QUOTE: "Teklif istiyor",
  LATER: "Daha sonra",
  WRONG_CONTACT: "Yanlış kişi",
  UNSUBSCRIBE: "Ret talebi",
  UNKNOWN: "Belirsiz",
};

/** Olumlu / satış fırsatı sayılan kategoriler */
export const POSITIVE_CATEGORIES: ReplyCategory[] = ["INTERESTED", "PRICING", "CATALOG_REQUEST", "TECHNICAL_QUESTION", "REQUEST_FOR_CALL", "REQUEST_FOR_QUOTE"];

/**
 * AI olmadan da yakalanan açık ret ifadeleri. Ret talebi kaçırılmamalı: AI kapalı veya hatalı olsa bile
 * adres hemen engel listesine eklenir (spec §24).
 */
const UNSUBSCRIBE_RE =
  /(listeden\s+(beni\s+)?çıkar|abonelikten\s+çık|(bir\s+daha|artık)\s+(mail|e-?posta|ileti)\s+(at|gönder|yolla)ma|e-?posta\s+(almak|istem)|rahatsız\s+etmeyin|\bunsubscribe\b|remove\s+me|stop\s+emailing|do\s+not\s+(contact|email))/i;

export function looksLikeUnsubscribe(text: string): boolean {
  return UNSUBSCRIBE_RE.test(text);
}

/** Bir e-posta gövdesinden alıntılanan önceki yazışmayı atar ("> ..." satırları, "… tarihinde … yazdı:"). */
export function stripQuotedReply(body: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (/^\s*(On .+ wrote:|.+ tarihinde .+ yazdı:|-{2,}\s*(Original Message|Orijinal ileti|Özgün ileti)\s*-{2,}|From:\s.+|Kimden:\s.+)\s*$/i.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim() || body.trim();
}

export interface InboundReply {
  fromAddress: string;
  toAddress?: string | null;
  subject?: string | null;
  body: string;
  /** In-Reply-To / References içinde geçen mesaj kimlikleri */
  references?: string[];
  receivedAt?: Date;
  /** Elle eklemede kullanıcı lead'i seçer */
  leadId?: string | null;
  /** Gelen e-postanın Message-ID'si — aynı ileti ikinci kez gelirse (IMAP / webhook tekrarı) kaydedilmez */
  externalId?: string | null;
}

/**
 * Gelen yanıtı kaydeder: ilgili giden iletiyi ve lead'i bulur, konuşmaya ekler, hatırlatmaları iptal eder,
 * açık ret ifadesi varsa hemen engel listesine ekler ve AI sınıflandırmasını kuyruğa alır.
 */
export async function recordInboundReply(companyId: string, input: InboundReply, actor: { userId?: string | null; source: "webhook" | "imap" | "manual" }) {
  const db = tenantDb({ companyId });
  const externalId = input.externalId?.replace(/[<>]/g, "").trim().slice(0, 500) || null;
  if (externalId) {
    const dup = await db.conversationMessage.findFirst({
      where: { externalId },
      select: { id: true, conversationId: true, conversation: { select: { leadId: true } } },
    });
    if (dup) return { matched: true as const, duplicate: true, leadId: dup.conversation.leadId, conversationId: dup.conversationId, conversationMessageId: dup.id };
  }
  const from = normalizeEmail(input.fromAddress);
  if (!from) throw new AppError("VALIDATION", "Gönderen e-posta adresi geçersiz.", { fromAddress: "Geçersiz adres" });
  const body = input.body.slice(0, 50_000);
  if (body.trim().length === 0) throw new AppError("VALIDATION", "Yanıt metni boş.", { body: "Metin gerekli" });

  // 1) İlgili giden ileti: önce referanslar (bizim mesaj kimliğimiz veya sağlayıcı kimliği), sonra bu adrese son gönderilen
  const refs = (input.references ?? []).map((r) => r.replace(/[<>]/g, "").trim()).filter(Boolean);
  const refIds = refs.flatMap((r) => [r, r.split("@")[0]!]);
  let outbound = refIds.length
    ? await db.message.findFirst({
        where: { direction: "OUTBOUND", OR: [{ id: { in: refIds } }, { providerMessageId: { in: [...refs, ...refs.map((r) => `<${r}>`)] } }] },
        orderBy: { sentAt: "desc" },
      })
    : null;
  if (!outbound) {
    outbound = await db.message.findFirst({
      where: { direction: "OUTBOUND", toAddress: from, status: { in: ["SENT", "DELIVERED"] }, ...(input.leadId ? { leadId: input.leadId } : {}) },
      orderBy: { sentAt: "desc" },
    });
  }

  // 2) Lead: iletiden, elle seçimden veya adres/alan adı eşleşmesinden
  let leadId = outbound?.leadId ?? input.leadId ?? null;
  if (input.leadId) {
    const owned = await db.lead.findUnique({ where: { id: input.leadId }, select: { id: true } });
    if (!owned) throw new AppError("NOT_FOUND", "Lead bulunamadı.");
  }
  if (!leadId) {
    const contact = await db.leadContact.findFirst({ where: { email: from }, select: { leadId: true } });
    leadId = contact?.leadId ?? null;
  }
  if (!leadId) {
    const byEmail = await db.lead.findFirst({ where: { genericEmail: from }, select: { id: true } });
    leadId = byEmail?.id ?? null;
  }
  if (!leadId) {
    const domain = extractDomain(from.split("@")[1]);
    if (domain && !isGenericHost(domain)) {
      const byDomain = await db.lead.findFirst({ where: { domain }, select: { id: true } });
      leadId = byDomain?.id ?? null;
    }
  }
  if (!leadId) return { matched: false as const };

  const contactId = outbound?.contactId ?? (await db.leadContact.findFirst({ where: { leadId, email: from }, select: { id: true } }))?.id ?? null;

  // 3) Konuşma
  let conversationId = outbound?.conversationId ?? null;
  if (!conversationId) {
    const existing = await db.conversation.findFirst({ where: { leadId, channel: "EMAIL" }, orderBy: { updatedAt: "desc" }, select: { id: true } });
    conversationId =
      existing?.id ??
      (await db.conversation.create({ data: { companyId, leadId, contactId, channel: "EMAIL", subject: input.subject?.slice(0, 300) ?? outbound?.subject ?? null } })).id;
  }
  if (outbound && !outbound.conversationId) await db.message.update({ where: { id: outbound.id }, data: { conversationId } });

  const receivedAt = input.receivedAt ?? new Date();
  const cm = await db.conversationMessage.create({
    data: {
      companyId,
      conversationId,
      direction: "INBOUND",
      fromAddress: from,
      toAddress: input.toAddress?.slice(0, 300) ?? null,
      subject: input.subject?.slice(0, 300) ?? null,
      body,
      receivedAt,
      externalId,
    },
  });
  await db.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: receivedAt } });

  // 4) Yanıt geldi: hatırlatmalar durur, lead "yanıt verdi" olur
  await cancelFollowUpsForLead(companyId, leadId, "Yanıt geldi.");
  await db.lead.updateMany({ where: { id: leadId, status: { in: ["NEW", "RESEARCHING", "QUALIFIED", "CONTACT_READY", "CONTACTED"] } }, data: { status: "REPLIED" } });
  if (outbound?.campaignId) await db.campaignLead.updateMany({ where: { campaignId: outbound.campaignId, leadId }, data: { status: "REPLIED" } });

  // 5) Açık ret ifadesi: AI'ı beklemeden engel listesine
  const fresh = stripQuotedReply(body);
  if (looksLikeUnsubscribe(fresh)) {
    await applyCategory(companyId, cm.id, { category: "UNSUBSCRIBE", confidence: 1, summary: "Alıcı listeden çıkarılmak istiyor.", request: null, followUpInDays: null });
  } else if (isAIConfigured()) {
    await enqueue("conversation.classify", { conversationMessageId: cm.id }, { companyId, createdById: actor.userId ?? null });
  } else {
    await createTask(companyId, { leadId, title: "Gelen yanıtı inceleyin", description: fresh.slice(0, 500), priority: "HIGH", dueInDays: 1 });
  }

  await audit({
    companyId,
    userId: actor.userId ?? null,
    actorType: actor.userId ? "USER" : "SYSTEM",
    action: "conversation.reply_received",
    entityType: "ConversationMessage",
    entityId: cm.id,
    metadata: { source: actor.source, matchedMessage: outbound?.id ?? null },
  });
  return { matched: true as const, duplicate: false, leadId, conversationId, conversationMessageId: cm.id };
}

/** Elle yanıt ekleme (kullanıcı kendi posta kutusundaki yanıtı yapıştırır). */
export async function addManualReply(ctx: TenantContext, input: { leadId: string; fromAddress: string; subject?: string | null; body: string }) {
  assertCan(ctx, "lead.write");
  const res = await recordInboundReply(ctx.companyId, input, { userId: ctx.userId, source: "manual" });
  if (!res.matched) throw new AppError("NOT_FOUND", "Lead bulunamadı.");
  return res;
}

// ── Sınıflandırma ve otomatik aksiyonlar ──────────────────────────────

/** İş içinden çağrılır. Yanıtı sınıflandırır ve kategoriye göre aksiyon alır. */
export async function classifyReply(companyId: string, conversationMessageId: string) {
  const db = tenantDb({ companyId });
  const cm = await db.conversationMessage.findUnique({ where: { id: conversationMessageId } });
  if (!cm) throw new AppError("NOT_FOUND", "Yanıt bulunamadı.");
  if (cm.category) return { category: cm.category, skipped: true };
  const { data } = await ai({ companyId, operation: "conversation.classify" }).extract({
    schema: replyClassificationSchema,
    tier: "fast",
    instructions: REPLY_CLASSIFICATION_INSTRUCTIONS,
    shape: REPLY_CLASSIFICATION_SHAPE,
    input: untrusted("email-reply", `Konu: ${cm.subject ?? ""}\n\n${stripQuotedReply(cm.body)}`, 8000),
    maxTokens: 500,
  });
  await applyCategory(companyId, cm.id, data);
  return { category: data.category, confidence: data.confidence };
}

const STATUS_BY_CATEGORY: Partial<Record<ReplyCategory, LeadStatus>> = {
  INTERESTED: "INTERESTED",
  PRICING: "INTERESTED",
  CATALOG_REQUEST: "INTERESTED",
  TECHNICAL_QUESTION: "INTERESTED",
  REQUEST_FOR_CALL: "INTERESTED",
  REQUEST_FOR_QUOTE: "QUOTE_REQUESTED",
  LATER: "NURTURE",
  NOT_INTERESTED: "LOST",
};

const TASK_BY_CATEGORY: Partial<Record<ReplyCategory, { title: string; priority: "HIGH" | "MEDIUM" | "URGENT"; dueInDays: number }>> = {
  INTERESTED: { title: "İlgilenen müşteriye dönüş yapın", priority: "HIGH", dueInDays: 1 },
  PRICING: { title: "Fiyat bilgisi isteniyor — fiyatı siz belirleyip yanıtlayın", priority: "HIGH", dueInDays: 1 },
  CATALOG_REQUEST: { title: "Katalog gönderin", priority: "HIGH", dueInDays: 1 },
  TECHNICAL_QUESTION: { title: "Teknik soruyu yanıtlayın", priority: "HIGH", dueInDays: 1 },
  REQUEST_FOR_CALL: { title: "Görüşme ayarlayın", priority: "URGENT", dueInDays: 1 },
  REQUEST_FOR_QUOTE: { title: "Teklif hazırlayın", priority: "URGENT", dueInDays: 1 },
  WRONG_CONTACT: { title: "Doğru kişiyi bulun (yanlış kişiye yazılmış)", priority: "MEDIUM", dueInDays: 3 },
  UNKNOWN: { title: "Gelen yanıtı inceleyin", priority: "MEDIUM", dueInDays: 2 },
};

const LOW_CONFIDENCE = 0.6;

async function createTask(
  companyId: string,
  t: { leadId: string; title: string; description?: string | null; priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT"; dueInDays: number; opportunityId?: string | null },
) {
  const db = tenantDb({ companyId });
  // Aynı lead için açık, aynı başlıklı görev tekrar açılmaz
  const exists = await db.task.findFirst({ where: { leadId: t.leadId, title: t.title, status: "OPEN" }, select: { id: true } });
  if (exists) return exists;
  return db.task.create({
    data: {
      companyId,
      leadId: t.leadId,
      opportunityId: t.opportunityId ?? null,
      title: t.title,
      description: t.description?.slice(0, 2000) ?? null,
      priority: t.priority,
      dueAt: new Date(Date.now() + t.dueInDays * 86_400_000),
      createdByAI: true,
    },
    select: { id: true },
  });
}

/**
 * Kategoriye göre aksiyon. Güven düşükse durum değiştirilmez, yalnızca inceleme görevi açılır
 * (ret talebi hariç — o her zaman uygulanır).
 */
export async function applyCategory(companyId: string, conversationMessageId: string, c: ReplyClassification) {
  const db = tenantDb({ companyId });
  const cm = await db.conversationMessage.update({
    where: { id: conversationMessageId },
    data: { category: c.category, categoryConfidence: c.confidence, aiSummary: c.summary },
    include: { conversation: { select: { id: true, leadId: true } } },
  });
  await db.conversation.update({ where: { id: cm.conversationId }, data: { category: c.category } });
  const leadId = cm.conversation.leadId;
  await emitEvent(companyId, "reply.received", {
    leadId,
    conversationId: cm.conversationId,
    category: c.category,
    confidence: c.confidence,
    summary: c.summary,
  });
  const description = [c.summary, c.request ? `Talep: ${c.request}` : null].filter(Boolean).join("\n");

  if (c.category === "UNSUBSCRIBE") {
    if (cm.fromAddress) {
      // Kanal bağımsız: e-posta adresi veya (WhatsApp) telefon numarası
      const type = cm.fromAddress.includes("@") ? "EMAIL" : "PHONE";
      await addSuppression(companyId, { type, value: cm.fromAddress, source: "REPLY", reason: "Alıcı yanıtında ret bildirdi.", leadId });
    }
    return;
  }

  if (c.confidence < LOW_CONFIDENCE) {
    await createTask(companyId, { leadId, title: "Gelen yanıtı inceleyin (AI emin değil)", description, priority: "HIGH", dueInDays: 1 });
    return;
  }

  const status = STATUS_BY_CATEGORY[c.category];
  if (status) {
    // Satış süreci ilerlemiş lead geri alınmaz (ör. teklif aşamasındaki lead "ilgileniyor"a düşmez)
    const advanced: LeadStatus[] = ["QUALIFIED_OPPORTUNITY", "PROPOSAL_SENT", "NEGOTIATION", "WON"];
    await db.lead.updateMany({ where: { id: leadId, status: { notIn: advanced } }, data: { status } });
  }

  let opportunityId: string | null = null;
  if (POSITIVE_CATEGORIES.includes(c.category)) {
    const stage: OpportunityStage = c.category === "REQUEST_FOR_QUOTE" ? "QUOTE" : "INTERESTED";
    opportunityId = (await ensureOpportunity(companyId, leadId, stage)).id;
  }

  if (c.category === "LATER") {
    await createTask(companyId, { leadId, title: "Tekrar iletişime geçin (daha sonra dediler)", description, priority: "MEDIUM", dueInDays: c.followUpInDays ?? 30 });
    return;
  }
  if (c.category === "NOT_INTERESTED") return;

  const task = TASK_BY_CATEGORY[c.category];
  if (task) await createTask(companyId, { leadId, ...task, description, opportunityId });
}

/** Lead için açık fırsat yoksa oluşturur; varsa aşamayı yalnızca ileri taşır. */
export async function ensureOpportunity(companyId: string, leadId: string, stage: OpportunityStage) {
  const db = tenantDb({ companyId });
  const ORDER: OpportunityStage[] = ["NEW", "QUALIFIED", "CONTACTED", "INTERESTED", "QUOTE", "NEGOTIATION", "WON", "LOST"];
  const open = await db.opportunity.findFirst({ where: { leadId, stage: { notIn: ["WON", "LOST"] } }, orderBy: { createdAt: "desc" } });
  if (open) {
    if (ORDER.indexOf(stage) > ORDER.indexOf(open.stage)) {
      return db.opportunity.update({ where: { id: open.id }, data: { stage } });
    }
    return open;
  }
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { companyName: true } });
  const lastCampaign = await db.message.findFirst({ where: { leadId, campaignId: { not: null } }, orderBy: { createdAt: "desc" }, select: { campaignId: true } });
  const opp = await db.opportunity.create({
    data: { companyId, leadId, campaignId: lastCampaign?.campaignId ?? null, title: lead?.companyName ?? "Fırsat", stage },
  });
  await audit({ companyId, actorType: "AI", action: "opportunity.created", entityType: "Opportunity", entityId: opp.id, metadata: { stage } });
  return opp;
}

// ── Okuma ─────────────────────────────────────────────────────────────

export async function listConversations(ctx: TenantContext, filter: { category?: ReplyCategory; leadId?: string } = {}) {
  assertCan(ctx, "lead.read");
  return tenantDb(ctx).conversation.findMany({
    where: {
      ...(filter.category ? { category: filter.category } : {}),
      ...(filter.leadId ? { leadId: filter.leadId } : {}),
      messages: { some: { direction: "INBOUND" } },
    },
    orderBy: { lastMessageAt: { sort: "desc", nulls: "last" } },
    take: 100,
    include: {
      lead: { select: { id: true, companyName: true, city: true } },
      messages: { where: { direction: "INBOUND" }, orderBy: { receivedAt: "desc" }, take: 1, select: { body: true, aiSummary: true, receivedAt: true, fromAddress: true, category: true } },
    },
  });
}

export async function getConversation(ctx: TenantContext, id: string) {
  assertCan(ctx, "lead.read");
  const db = tenantDb(ctx);
  const conv = await db.conversation.findUnique({
    where: { id },
    include: {
      lead: { select: { id: true, companyName: true, city: true, status: true } },
      messages: { orderBy: { receivedAt: "asc" } },
      outbound: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!conv) throw new AppError("NOT_FOUND", "Konuşma bulunamadı.");
  return conv;
}

// ── AI yanıt taslağı ve gönderim ──────────────────────────────────────

/** Son gelen yanıta AI cevap taslağı (1 kredi). Taslak insan onayı bekler. */
export async function draftReply(ctx: TenantContext, conversationId: string) {
  assertCan(ctx, "message.approve");
  if (!isAIConfigured()) throw new AppError("AI_UNAVAILABLE", "AI sağlayıcısı yapılandırılmamış (.env → ANTHROPIC_API_KEY).");
  const db = tenantDb(ctx);
  const conv = await getConversation(ctx, conversationId);
  const lastIn = [...conv.messages].reverse().find((m) => m.direction === "INBOUND");
  if (!lastIn?.fromAddress) throw new AppError("VALIDATION", "Yanıtlanacak gelen ileti yok.");
  if (conv.messages.some((m) => m.category === "UNSUBSCRIBE")) throw new AppError("FORBIDDEN", "Alıcı ret bildirdi; yanıt yazılamaz.");
  const pending = await db.message.findFirst({ where: { conversationId, status: { in: ["PENDING_APPROVAL", "APPROVED"] }, campaignStepId: null } });
  if (pending) throw new AppError("CONFLICT", "Bu konuşmada onay bekleyen bir yanıt taslağı zaten var.");

  const { usageId } = await consumeCredits({ companyId: ctx.companyId, operation: "ai.message", userId: ctx.userId, refType: "Conversation", refId: conversationId });
  try {
    const verified = await buildVerifiedCompanyContext(ctx);
    const { settings } = await getSenderSettings(ctx.companyId);
    const history = [
      ...conv.outbound.filter((m) => m.status === "SENT" || m.status === "DELIVERED").map((m) => ({ at: m.sentAt ?? m.createdAt, who: "BİZ", text: `${m.subject ?? ""}\n${m.body}` })),
      ...conv.messages.map((m) => ({ at: m.receivedAt, who: m.direction === "INBOUND" ? "ALICI" : "BİZ", text: `${m.subject ?? ""}\n${stripQuotedReply(m.body)}` })),
    ]
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .slice(-6)
      .map((h) => `[${h.who}] ${h.text.slice(0, 2500)}`)
      .join("\n\n---\n\n");

    const { data } = await ai({ companyId: ctx.companyId, operation: "conversation.reply_draft" }).extract({
      schema: replyDraftSchema,
      instructions: REPLY_DRAFT_INSTRUCTIONS,
      shape: REPLY_DRAFT_SHAPE,
      input: [
        `DOĞRULANMIŞ BİLGİ (satıcı):\n${JSON.stringify({ name: verified.name, summary: verified.summary, facts: verified.facts, products: verified.products.slice(0, 20) })}`,
        `GÖNDEREN: ${settings?.fromName ?? verified.name}`,
        `KONUŞMA GEÇMİŞİ:\n${untrusted("conversation", history, 16_000)}`,
      ].join("\n\n"),
      maxTokens: 1200,
    });
    const corpus = JSON.stringify({ ...verified, sender: settings ? { name: settings.fromName, legalName: settings.legalName } : null });
    const quality = checkMessageQuality({ subject: data.subject, body: data.body }, corpus, history);
    const issues = [
      ...quality.issues,
      ...data.unanswered.map((q) => ({ severity: "warn" as const, code: "unanswered", text: `Doğrulanmış bilgi olmadığı için cevaplanmadı: ${q}` })),
    ];
    const msg = await db.message.create({
      data: {
        companyId: ctx.companyId,
        leadId: conv.leadId,
        contactId: conv.contactId,
        conversationId,
        campaignId: null,
        channel: "EMAIL",
        toAddress: lastIn.fromAddress,
        subject: data.subject.trim(),
        body: data.body.trim(),
        status: "PENDING_APPROVAL",
        qualityScore: quality.score,
        qualityNotes: { issues, personalization: [], blocked: quality.blocked } as unknown as Prisma.InputJsonValue,
        complianceStatus: "SENDABLE",
      },
    });
    await audit({ companyId: ctx.companyId, userId: ctx.userId, actorType: "AI", action: "conversation.reply_drafted", entityType: "Message", entityId: msg.id });
    return msg;
  } catch (err) {
    await refundCredits(usageId, "conversation.reply_draft.failed");
    throw err;
  }
}

/** Onaylı yanıtı gönderir (işte). Kampanya dışı iletiler için. */
export async function sendReply(ctx: TenantContext, messageId: string) {
  assertCan(ctx, "email.send");
  if (!isEmailConfigured()) throw new AppError("VALIDATION", "E-posta sağlayıcısı yapılandırılmamış (EMAIL_PROVIDER).");
  const msg = await tenantDb(ctx).message.findUnique({ where: { id: messageId }, select: { status: true, campaignId: true } });
  if (!msg) throw new AppError("NOT_FOUND", "Mesaj bulunamadı.");
  if (msg.status !== "APPROVED") throw new AppError("VALIDATION", "Önce mesajı onaylayın.");
  if (msg.campaignId) throw new AppError("VALIDATION", "Kampanya mesajları kampanya ekranından gönderilir.");
  const jobId = await enqueue("message.send", { messageId }, { companyId: ctx.companyId, createdById: ctx.userId });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "message.send_requested", entityType: "Message", entityId: messageId });
  return { jobId };
}
