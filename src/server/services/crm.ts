import "server-only";
import type { LostReason, OpportunityStage, Priority, Prisma } from "@prisma/client";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { assertCan } from "@/server/tenancy/permissions";
import type { TenantContext } from "@/server/tenancy/types";
import { audit } from "@/server/audit/audit";
import { emitEvent } from "./integrations";
import { AppError } from "@/lib/errors";

export const STAGE_LABELS: Record<OpportunityStage, string> = {
  NEW: "Yeni",
  QUALIFIED: "Nitelikli",
  CONTACTED: "İletişimde",
  INTERESTED: "İlgileniyor",
  QUOTE: "Teklif",
  NEGOTIATION: "Pazarlık",
  WON: "Kazanıldı",
  LOST: "Kaybedildi",
};

export const OPEN_STAGES: OpportunityStage[] = ["NEW", "QUALIFIED", "CONTACTED", "INTERESTED", "QUOTE", "NEGOTIATION"];

export const LOST_REASON_LABELS: Record<LostReason, string> = {
  PRICE: "Fiyat",
  DELIVERY: "Teslimat",
  PRODUCT_MISMATCH: "Ürün uyumsuz",
  COMPETITOR: "Rakip tercih edildi",
  TIMING: "Zamanlama",
  NO_RESPONSE: "Yanıt yok",
  WRONG_CONTACT: "Yanlış kişi",
  OTHER: "Diğer",
};

export const PRIORITY_LABELS: Record<Priority, string> = { LOW: "Düşük", MEDIUM: "Orta", HIGH: "Yüksek", URGENT: "Acil" };

// ── Fırsatlar ──────────────────────────────────────────────────────────

export async function listOpportunities(ctx: TenantContext) {
  assertCan(ctx, "lead.read");
  return tenantDb(ctx).opportunity.findMany({
    where: { OR: [{ stage: { in: OPEN_STAGES } }, { updatedAt: { gte: new Date(Date.now() - 90 * 86_400_000) } }] },
    orderBy: { updatedAt: "desc" },
    take: 500,
    include: {
      lead: { select: { id: true, companyName: true, city: true, fitScore: true } },
      _count: { select: { tasks: { where: { status: "OPEN" } } } },
    },
  });
}

export async function pipelineSummary(ctx: TenantContext) {
  assertCan(ctx, "lead.read");
  const rows = await tenantDb(ctx).opportunity.groupBy({
    by: ["stage"],
    _count: { _all: true },
    _sum: { value: true },
  });
  return rows.map((r) => ({ stage: r.stage, count: r._count._all, value: r._sum.value ? Number(r._sum.value) : 0 }));
}

export async function createOpportunity(ctx: TenantContext, input: { leadId: string; title?: string | null }) {
  assertCan(ctx, "lead.write");
  const db = tenantDb(ctx);
  const lead = await db.lead.findUnique({ where: { id: input.leadId }, select: { companyName: true } });
  if (!lead) throw new AppError("NOT_FOUND", "Lead bulunamadı.");
  const open = await db.opportunity.findFirst({ where: { leadId: input.leadId, stage: { in: OPEN_STAGES } }, select: { id: true } });
  if (open) throw new AppError("CONFLICT", "Bu lead için açık bir fırsat zaten var.");
  const opp = await db.opportunity.create({
    data: { companyId: ctx.companyId, leadId: input.leadId, title: input.title?.trim() || lead.companyName, stage: "QUALIFIED", ownerId: ctx.userId },
  });
  await db.lead.updateMany({ where: { id: input.leadId, status: { in: ["NEW", "RESEARCHING", "QUALIFIED", "CONTACT_READY", "CONTACTED", "REPLIED"] } }, data: { status: "QUALIFIED_OPPORTUNITY" } });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "opportunity.created", entityType: "Opportunity", entityId: opp.id });
  return opp;
}

export interface OpportunityUpdate {
  id: string;
  stage: OpportunityStage;
  /** Tutar yalnızca insan tarafından girilir (AI fiyat üretmez) */
  value?: number | null;
  probability?: number | null;
  expectedCloseAt?: Date | null;
  lostReason?: LostReason | null;
  lostNote?: string | null;
}

export async function updateOpportunity(ctx: TenantContext, input: OpportunityUpdate) {
  assertCan(ctx, "lead.write");
  const db = tenantDb(ctx);
  const opp = await db.opportunity.findUnique({ where: { id: input.id } });
  if (!opp) throw new AppError("NOT_FOUND", "Fırsat bulunamadı.");
  if (input.stage === "LOST" && !input.lostReason) {
    throw new AppError("VALIDATION", "Kaybedilme nedenini seçin; raporlarda neden kaybettiğinizi görmenizi sağlar.", { lostReason: "Neden seçin" });
  }
  const now = new Date();
  const data: Prisma.OpportunityUpdateInput = {
    stage: input.stage,
    ...(input.value !== undefined ? { value: input.value } : {}),
    ...(input.probability !== undefined ? { probability: input.probability } : {}),
    ...(input.expectedCloseAt !== undefined ? { expectedCloseAt: input.expectedCloseAt } : {}),
    wonAt: input.stage === "WON" ? (opp.wonAt ?? now) : null,
    lostAt: input.stage === "LOST" ? (opp.lostAt ?? now) : null,
    lostReason: input.stage === "LOST" ? input.lostReason : null,
    lostNote: input.stage === "LOST" ? (input.lostNote?.slice(0, 1000) ?? null) : null,
  };
  await db.opportunity.update({ where: { id: opp.id }, data });

  const leadStatus =
    input.stage === "WON" ? "WON" : input.stage === "LOST" ? "LOST" : input.stage === "QUOTE" ? "PROPOSAL_SENT" : input.stage === "NEGOTIATION" ? "NEGOTIATION" : null;
  if (leadStatus) await db.lead.updateMany({ where: { id: opp.leadId }, data: { status: leadStatus } });
  if (input.stage === "WON" || input.stage === "LOST") {
    await db.task.updateMany({ where: { opportunityId: opp.id, status: "OPEN" }, data: { status: "CANCELLED" } });
    await db.followUp.updateMany({ where: { leadId: opp.leadId, status: "SCHEDULED" }, data: { status: "CANCELLED", skipReason: "Fırsat kapandı." } });
  }
  await audit({
    companyId: ctx.companyId,
    userId: ctx.userId,
    action: opp.stage !== input.stage ? "opportunity.stage_changed" : "opportunity.updated",
    entityType: "Opportunity",
    entityId: opp.id,
    metadata: { from: opp.stage, to: input.stage, lostReason: input.lostReason ?? null },
  });
  if (opp.stage !== input.stage) {
    await emitEvent(ctx.companyId, "opportunity.stage_changed", { opportunityId: opp.id, leadId: opp.leadId, from: opp.stage, to: input.stage, value: input.value ?? null });
  }
}

/** Lead detay sayfası: açık fırsat + açık görevler */
export async function getLeadCrm(ctx: TenantContext, leadId: string) {
  assertCan(ctx, "lead.read");
  const db = tenantDb(ctx);
  const [opportunity, tasks] = await Promise.all([
    db.opportunity.findFirst({ where: { leadId }, orderBy: { updatedAt: "desc" } }),
    db.task.findMany({ where: { leadId, status: "OPEN" }, orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }], take: 20 }),
  ]);
  return { opportunity, tasks };
}

// ── Görevler ───────────────────────────────────────────────────────────

export async function listTasks(ctx: TenantContext, filter: { status?: "OPEN" | "DONE"; leadId?: string } = {}) {
  assertCan(ctx, "lead.read");
  return tenantDb(ctx).task.findMany({
    where: { status: filter.status ?? "OPEN", ...(filter.leadId ? { leadId: filter.leadId } : {}) },
    orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { priority: "desc" }, { createdAt: "asc" }],
    take: 300,
    include: { lead: { select: { id: true, companyName: true } }, opportunity: { select: { id: true, stage: true } } },
  });
}

export async function createTaskByUser(
  ctx: TenantContext,
  input: { title: string; description?: string | null; leadId?: string | null; dueAt?: Date | null; priority?: Priority },
) {
  assertCan(ctx, "lead.write");
  const db = tenantDb(ctx);
  if (input.leadId) {
    const lead = await db.lead.findUnique({ where: { id: input.leadId }, select: { id: true } });
    if (!lead) throw new AppError("NOT_FOUND", "Lead bulunamadı.");
  }
  return db.task.create({
    data: {
      companyId: ctx.companyId,
      title: input.title,
      description: input.description ?? null,
      leadId: input.leadId ?? null,
      dueAt: input.dueAt ?? null,
      priority: input.priority ?? "MEDIUM",
      createdById: ctx.userId,
      assigneeId: ctx.userId,
    },
  });
}

export async function setTaskStatus(ctx: TenantContext, id: string, status: "DONE" | "CANCELLED" | "OPEN") {
  assertCan(ctx, "lead.write");
  const res = await tenantDb(ctx).task.updateMany({
    where: { id },
    data: { status, completedAt: status === "DONE" ? new Date() : null },
  });
  if (res.count === 0) throw new AppError("NOT_FOUND", "Görev bulunamadı.");
  if (status === "DONE") await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "task.completed", entityType: "Task", entityId: id });
}

// ── "Bugün ne yapmalıyım?" ─────────────────────────────────────────────

export interface AgendaItem {
  key: string;
  text: string;
  href: string;
  count: number;
  tone: "danger" | "warning" | "accent";
}

/**
 * Bugünün yapılacakları — tamamı gerçek kayıtlardan sayılır; veri yoksa madde gösterilmez.
 */
export async function getTodayAgenda(ctx: TenantContext): Promise<AgendaItem[]> {
  assertCan(ctx, "lead.read");
  const db = tenantDb(ctx);
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);

  const [overdue, dueToday, pendingApproval, unansweredReplies, reviewRequired, hotLeads, quoteOpps] = await Promise.all([
    db.task.count({ where: { status: "OPEN", dueAt: { lt: startOfToday } } }),
    db.task.count({ where: { status: "OPEN", dueAt: { gte: startOfToday, lte: endOfToday } } }),
    db.message.count({ where: { status: "PENDING_APPROVAL" } }),
    // Son 7 günde yanıt gelen ve sonrasında bizden ileti gitmemiş konuşmalar
    db.conversation.count({
      where: {
        category: { notIn: ["UNSUBSCRIBE", "NOT_INTERESTED"] },
        lastMessageAt: { gte: weekAgo },
        messages: { some: { direction: "INBOUND", receivedAt: { gte: weekAgo } } },
        outbound: { none: { sentAt: { gte: weekAgo } } },
      },
    }),
    db.campaignLead.count({ where: { complianceStatus: "REVIEW_REQUIRED", campaign: { status: { in: ["DRAFT", "READY", "RUNNING", "PAUSED"] } } } }),
    db.lead.count({ where: { fitScore: { gte: 70 }, status: { in: ["NEW", "QUALIFIED"] }, suppressed: false, campaignLeads: { none: {} } } }),
    db.opportunity.count({ where: { stage: "QUOTE" } }),
  ]);

  const items: AgendaItem[] = [];
  if (overdue) items.push({ key: "overdue", text: `${overdue} görevin tarihi geçti`, href: "/tasks", count: overdue, tone: "danger" });
  if (unansweredReplies) items.push({ key: "replies", text: `${unansweredReplies} yanıt cevabınızı bekliyor`, href: "/messages?f=inbox", count: unansweredReplies, tone: "danger" });
  if (dueToday) items.push({ key: "today", text: `Bugün ${dueToday} görev var`, href: "/tasks", count: dueToday, tone: "warning" });
  if (quoteOpps) items.push({ key: "quotes", text: `${quoteOpps} fırsat teklif aşamasında`, href: "/pipeline", count: quoteOpps, tone: "warning" });
  if (pendingApproval) items.push({ key: "approve", text: `${pendingApproval} mesaj onayınızı bekliyor`, href: "/messages?f=pending", count: pendingApproval, tone: "accent" });
  if (reviewRequired) items.push({ key: "review", text: `${reviewRequired} adres için gönderim incelemesi gerekli`, href: "/campaigns", count: reviewRequired, tone: "accent" });
  if (hotLeads) items.push({ key: "hot", text: `${hotLeads} yüksek puanlı lead henüz hiçbir kampanyada değil`, href: "/leads?min=70", count: hotLeads, tone: "accent" });
  return items;
}
