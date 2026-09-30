import "server-only";
import { Prisma, type ProposalStatus } from "@prisma/client";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { assertCan } from "@/server/tenancy/permissions";
import type { TenantContext } from "@/server/tenancy/types";
import { ai, isAIConfigured } from "@/server/ai";
import { untrusted } from "@/server/ai/guardrails";
import { PROPOSAL_DRAFT_INSTRUCTIONS, PROPOSAL_DRAFT_SHAPE, proposalDraftSchema, type ProposalDraft } from "@/server/ai/prompts/proposal";
import { enqueue } from "@/server/jobs/queue";
import { consumeCredits, refundCredits } from "@/server/usage/credits";
import { audit } from "@/server/audit/audit";
import { AppError } from "@/lib/errors";
import { buildVerifiedCompanyContext } from "./facts";
import { valueFound } from "./evidence";
import { stripQuotedReply } from "./conversations";
import { getSenderSettings } from "./email-settings";
import { emitEvent } from "./integrations";

export const PROPOSAL_STATUS_LABELS: Record<ProposalStatus, string> = {
  DRAFT: "Taslak",
  PENDING_APPROVAL: "Onay bekliyor",
  APPROVED: "Onaylandı",
  SENT: "Gönderildi",
  ACCEPTED: "Kabul edildi",
  REJECTED: "Reddedildi",
  EXPIRED: "Süresi doldu",
};

export interface ProposalItem {
  productId: string | null;
  name: string;
  quantity: number | null;
  unit: string | null;
  /** YALNIZCA insan girer. AI taslağında her zaman null. */
  unitPrice: number | null;
  note: string | null;
}

const EDITABLE: ProposalStatus[] = ["DRAFT", "PENDING_APPROVAL"];

export function parseItems(json: Prisma.JsonValue): ProposalItem[] {
  return Array.isArray(json) ? (json as unknown as ProposalItem[]) : [];
}

/** Toplam yalnızca fiyatı ve adedi girilmiş kalemlerden hesaplanır; eksik kalem varsa null. */
export function computeTotal(items: ProposalItem[]): number | null {
  if (items.length === 0) return null;
  let total = 0;
  for (const i of items) {
    if (i.unitPrice == null || i.quantity == null) return null;
    total += i.unitPrice * i.quantity;
  }
  return Math.round(total * 100) / 100;
}

/** Onay için eksikler (kullanıcıya gösterilir). */
export function proposalBlockers(items: ProposalItem[], validUntil: Date | null): string[] {
  const out: string[] = [];
  if (items.length === 0) out.push("En az bir kalem ekleyin.");
  items.forEach((i, idx) => {
    if (!i.name.trim()) out.push(`${idx + 1}. kalemin adı boş.`);
    if (i.quantity == null || i.quantity <= 0) out.push(`"${i.name || idx + 1}" için adet girin.`);
    if (i.unitPrice == null || i.unitPrice < 0) out.push(`"${i.name || idx + 1}" için birim fiyatı siz girin.`);
  });
  if (!validUntil) out.push("Geçerlilik tarihi girin.");
  return out;
}

/**
 * AI çıktısını doğrular: ürün adı yalnızca onaylı listeden; adet yalnızca müşteri metninde geçiyorsa;
 * teslim koşulu yalnızca doğrulanmış bilgide geçiyorsa. Fiyat her zaman boştur.
 */
export function sanitizeDraft(
  draft: ProposalDraft,
  products: Array<{ id: string; name: string }>,
  customerText: string,
  verifiedCorpus: string,
): { items: ProposalItem[]; deliveryTerms: string | null; missingInfo: string[]; coverNote: string | null } {
  const byName = new Map(products.map((p) => [p.name.toLocaleLowerCase("tr"), p]));
  const missing = new Set(draft.missingInfo);
  const items: ProposalItem[] = draft.items.map((i) => {
    const product = i.productName ? byName.get(i.productName.trim().toLocaleLowerCase("tr")) ?? null : null;
    if (!product) missing.add(`"${i.requested}" onaylı ürün listenizde yok — ürünü ekleyin veya kalemi düzenleyin.`);
    const qtyOk = i.quantity != null && valueFound(String(i.quantity), customerText);
    if (i.quantity != null && !qtyOk) missing.add(`"${i.requested}" için adet müşteri metninde doğrulanamadı.`);
    else if (i.quantity == null) missing.add(`"${i.requested}" için adet.`);
    return {
      productId: product?.id ?? null,
      name: product?.name ?? i.requested,
      quantity: qtyOk ? i.quantity : null,
      unit: i.unit,
      unitPrice: null,
      note: i.note,
    };
  });
  // Teslim koşulundaki her sayı (gün, hafta…) doğrulanmış bilgide geçmeli; sayısız genel ifade de kabul edilmez
  const deliveryNumbers = draft.deliveryTerms?.match(/\d+(?:[.,]\d+)?/g) ?? [];
  const deliveryOk = Boolean(draft.deliveryTerms) && deliveryNumbers.length > 0 && deliveryNumbers.every((n) => valueFound(n, verifiedCorpus));
  if (draft.deliveryTerms && !deliveryOk) missing.add("Teslim süresi doğrulanmış bilgilerinizde yok — siz girin.");
  missing.add("Birim fiyatlar (yalnızca siz girebilirsiniz).");
  return {
    items,
    deliveryTerms: deliveryOk ? draft.deliveryTerms : null,
    missingInfo: [...missing].slice(0, 20),
    coverNote: draft.coverNote,
  };
}

async function nextNumber(companyId: string): Promise<string> {
  const year = new Date().getFullYear();
  const count = await tenantDb({ companyId }).proposal.count({ where: { number: { startsWith: `TKL-${year}-` } } });
  return `TKL-${year}-${String(count + 1).padStart(4, "0")}`;
}

// ── Oluşturma ──────────────────────────────────────────────────────────

/** Fırsattan teklif taslağı (AI, 5 kredi, işte çalışır). AI kapalıysa boş taslak açılır. */
export async function startProposal(ctx: TenantContext, input: { opportunityId?: string | null; leadId?: string | null }) {
  assertCan(ctx, "lead.write");
  const db = tenantDb(ctx);
  const opp = input.opportunityId ? await db.opportunity.findUnique({ where: { id: input.opportunityId }, select: { id: true, leadId: true } }) : null;
  if (input.opportunityId && !opp) throw new AppError("NOT_FOUND", "Fırsat bulunamadı.");
  const leadId = opp?.leadId ?? input.leadId;
  if (!leadId) throw new AppError("VALIDATION", "Teklif için lead veya fırsat seçin.");
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { id: true } });
  if (!lead) throw new AppError("NOT_FOUND", "Lead bulunamadı.");

  const create = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await db.proposal.create({
          data: {
            companyId: ctx.companyId,
            leadId,
            opportunityId: opp?.id ?? null,
            number: await nextNumber(ctx.companyId),
            items: [] as unknown as Prisma.InputJsonValue,
            validUntil: new Date(Date.now() + 30 * 86_400_000),
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue; // numara çakışması
        throw err;
      }
    }
    throw new AppError("CONFLICT", "Teklif numarası üretilemedi, tekrar deneyin.");
  };

  const proposal = await create();
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "proposal.created", entityType: "Proposal", entityId: proposal.id });
  if (!isAIConfigured()) return { proposal, jobId: null };

  const { usageId } = await consumeCredits({ companyId: ctx.companyId, operation: "quotation.generate", userId: ctx.userId, refType: "Proposal", refId: proposal.id });
  try {
    const jobId = await enqueue("proposal.draft", { proposalId: proposal.id, usageId }, { companyId: ctx.companyId, createdById: ctx.userId });
    return { proposal, jobId };
  } catch (err) {
    await refundCredits(usageId, "proposal.draft.enqueue_failed");
    throw err;
  }
}

/** İş içinden çağrılır. Müşterinin son yanıtlarından talebi okur, onaylı ürünlerle eşleştirir. */
export async function draftProposal(companyId: string, proposalId: string) {
  const db = tenantDb({ companyId });
  const p = await db.proposal.findUnique({ where: { id: proposalId } });
  if (!p) throw new AppError("NOT_FOUND", "Teklif bulunamadı.");
  if (p.status !== "DRAFT") return { skipped: true };

  const [verified, products, inbound] = await Promise.all([
    buildVerifiedCompanyContext({ companyId }),
    db.product.findMany({
      where: { status: "VERIFIED", active: true },
      select: { id: true, name: true, description: true, technicalSpecs: true, minOrder: true, deliveryTime: true },
    }),
    db.conversationMessage.findMany({
      where: { direction: "INBOUND", conversation: { leadId: p.leadId } },
      orderBy: { receivedAt: "desc" },
      take: 5,
      select: { body: true, subject: true },
    }),
  ]);
  const customerText = inbound.map((m) => `${m.subject ?? ""}\n${stripQuotedReply(m.body)}`).join("\n---\n").slice(0, 12_000);
  const corpus = JSON.stringify(verified);

  const { data } = await ai({ companyId, operation: "proposal.draft" }).extract({
    schema: proposalDraftSchema,
    instructions: PROPOSAL_DRAFT_INSTRUCTIONS,
    shape: PROPOSAL_DRAFT_SHAPE,
    input: [
      `DOĞRULANMIŞ BİLGİ (satıcı):\n${JSON.stringify({ name: verified.name, facts: verified.facts })}`,
      `ONAYLI ÜRÜNLER:\n${JSON.stringify(products.map((x) => ({ name: x.name, description: x.description, specs: x.technicalSpecs, minOrder: x.minOrder, deliveryTime: x.deliveryTime })))}`,
      `MÜŞTERİ TALEBİ (son yanıtlar):\n${untrusted("customer-request", customerText || "(Müşteriden yazılı talep yok)", 12_000)}`,
    ].join("\n\n"),
    maxTokens: 2500,
  });
  const clean = sanitizeDraft(data, products, customerText, corpus);
  await db.proposal.update({
    where: { id: p.id },
    data: {
      items: clean.items as unknown as Prisma.InputJsonValue,
      deliveryTerms: clean.deliveryTerms,
      terms: clean.coverNote,
      missingInfo: clean.missingInfo,
      totalAmount: null,
    },
  });
  return { items: clean.items.length, missing: clean.missingInfo.length };
}

// ── Okuma / düzenleme ──────────────────────────────────────────────────

export async function listProposals(ctx: TenantContext) {
  assertCan(ctx, "lead.read");
  return tenantDb(ctx).proposal.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { lead: { select: { id: true, companyName: true } } },
  });
}

export async function getProposal(ctx: TenantContext, id: string) {
  assertCan(ctx, "lead.read");
  const p = await tenantDb(ctx).proposal.findUnique({
    where: { id },
    include: { lead: { select: { id: true, companyName: true, address: true, city: true, genericEmail: true } }, opportunity: { select: { id: true, stage: true } } },
  });
  if (!p) throw new AppError("NOT_FOUND", "Teklif bulunamadı.");
  return p;
}

export interface ProposalUpdate {
  id: string;
  items: ProposalItem[];
  currency: string;
  validUntil: Date | null;
  deliveryTerms: string | null;
  terms: string | null;
}

export async function updateProposal(ctx: TenantContext, input: ProposalUpdate) {
  assertCan(ctx, "lead.write");
  const db = tenantDb(ctx);
  const p = await db.proposal.findUnique({ where: { id: input.id }, select: { status: true } });
  if (!p) throw new AppError("NOT_FOUND", "Teklif bulunamadı.");
  if (!EDITABLE.includes(p.status)) throw new AppError("CONFLICT", "Onaylanmış teklif düzenlenemez; yeni teklif oluşturun.");

  // Kalem ürünü başka şirketin ürünü olamaz
  const productIds = input.items.map((i) => i.productId).filter((x): x is string => Boolean(x));
  if (productIds.length) {
    const owned = await db.product.count({ where: { id: { in: productIds } } });
    if (owned !== new Set(productIds).size) throw new AppError("VALIDATION", "Geçersiz ürün seçimi.");
  }
  const total = computeTotal(input.items);
  await db.proposal.update({
    where: { id: input.id },
    data: {
      items: input.items as unknown as Prisma.InputJsonValue,
      currency: input.currency,
      validUntil: input.validUntil,
      deliveryTerms: input.deliveryTerms,
      terms: input.terms,
      totalAmount: total,
      // Düzenlenen teklif yeniden onaya gider
      status: "DRAFT",
      approvedById: null,
      approvedAt: null,
    },
  });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "proposal.updated", entityType: "Proposal", entityId: input.id, metadata: { total } });
  return { total, blockers: proposalBlockers(input.items, input.validUntil) };
}

export async function submitProposal(ctx: TenantContext, id: string) {
  assertCan(ctx, "lead.write");
  const db = tenantDb(ctx);
  const p = await db.proposal.findUnique({ where: { id } });
  if (!p) throw new AppError("NOT_FOUND", "Teklif bulunamadı.");
  if (p.status !== "DRAFT") throw new AppError("CONFLICT", "Yalnızca taslak onaya gönderilebilir.");
  const blockers = proposalBlockers(parseItems(p.items), p.validUntil);
  if (blockers.length) throw new AppError("VALIDATION", `Onaya göndermeden önce: ${blockers.slice(0, 3).join(" ")}`);
  await db.proposal.update({ where: { id }, data: { status: "PENDING_APPROVAL" } });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "proposal.submitted", entityType: "Proposal", entityId: id });
}

/** Yönetici onayı: fiyatlar ve koşullar insan tarafından kontrol edildi. */
export async function approveProposal(ctx: TenantContext, id: string) {
  assertCan(ctx, "proposal.approve");
  const db = tenantDb(ctx);
  const p = await db.proposal.findUnique({ where: { id } });
  if (!p) throw new AppError("NOT_FOUND", "Teklif bulunamadı.");
  if (p.status !== "PENDING_APPROVAL") throw new AppError("CONFLICT", "Yalnızca onay bekleyen teklif onaylanabilir.");
  const items = parseItems(p.items);
  if (proposalBlockers(items, p.validUntil).length) throw new AppError("VALIDATION", "Teklifte eksik fiyat/adet var.");
  await db.proposal.update({ where: { id }, data: { status: "APPROVED", approvedById: ctx.userId, approvedAt: new Date(), totalAmount: computeTotal(items) } });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "proposal.approved", entityType: "Proposal", entityId: id, metadata: { total: computeTotal(items) } });
}

/** Gönderildi / kabul / red. Kabul → fırsat kazanıldı (tutar teklif toplamı). */
export async function setProposalOutcome(ctx: TenantContext, id: string, status: "SENT" | "ACCEPTED" | "REJECTED") {
  assertCan(ctx, "lead.write");
  const db = tenantDb(ctx);
  const p = await db.proposal.findUnique({ where: { id } });
  if (!p) throw new AppError("NOT_FOUND", "Teklif bulunamadı.");
  const allowedFrom: Record<typeof status, ProposalStatus[]> = { SENT: ["APPROVED"], ACCEPTED: ["APPROVED", "SENT"], REJECTED: ["APPROVED", "SENT"] };
  if (!allowedFrom[status].includes(p.status)) throw new AppError("CONFLICT", "Teklif önce onaylanmalı.");
  await db.proposal.update({ where: { id }, data: { status, ...(status === "SENT" ? { sentAt: p.sentAt ?? new Date() } : {}) } });

  if (p.opportunityId) {
    if (status === "SENT") {
      await db.opportunity.updateMany({ where: { id: p.opportunityId, stage: { in: ["NEW", "QUALIFIED", "CONTACTED", "INTERESTED"] } }, data: { stage: "QUOTE" } });
      await db.lead.updateMany({ where: { id: p.leadId }, data: { status: "PROPOSAL_SENT" } });
    }
    if (status === "ACCEPTED") {
      await db.opportunity.update({ where: { id: p.opportunityId }, data: { stage: "WON", wonAt: new Date(), value: p.totalAmount, currency: p.currency, lostReason: null, lostAt: null } });
      await db.lead.updateMany({ where: { id: p.leadId }, data: { status: "WON" } });
    }
  }
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: `proposal.${status.toLowerCase()}`, entityType: "Proposal", entityId: id });
  if (status === "ACCEPTED") {
    await emitEvent(ctx.companyId, "proposal.accepted", { proposalId: id, number: p.number, leadId: p.leadId, total: p.totalAmount != null ? Number(p.totalAmount) : null, currency: p.currency });
  }
}

const money = (n: number, currency: string) =>
  new Intl.NumberFormat("tr-TR", { style: "currency", currency: currency || "TRY", maximumFractionDigits: 2 }).format(n);

/** Onaylı teklifin e-posta metni (düz metin). */
export function proposalText(p: { number: string; currency: string; validUntil: Date | null; deliveryTerms: string | null; terms: string | null; totalAmount: Prisma.Decimal | null }, items: ProposalItem[]) {
  const lines = items.map((i, idx) => {
    const line = i.unitPrice != null && i.quantity != null ? money(i.unitPrice * i.quantity, p.currency) : "—";
    return `${idx + 1}. ${i.name} — ${i.quantity ?? "?"} ${i.unit ?? ""} × ${i.unitPrice != null ? money(i.unitPrice, p.currency) : "?"} = ${line}${i.note ? ` (${i.note})` : ""}`;
  });
  return [
    p.terms?.trim() || "Talebiniz için teklifimiz aşağıdadır.",
    "",
    `Teklif no: ${p.number}`,
    ...lines,
    "",
    `Toplam: ${p.totalAmount != null ? money(Number(p.totalAmount), p.currency) : "—"} (KDV hariç)`,
    p.deliveryTerms ? `Teslim: ${p.deliveryTerms}` : null,
    p.validUntil ? `Geçerlilik: ${new Intl.DateTimeFormat("tr-TR", { dateStyle: "long" }).format(p.validUntil)}` : null,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/** Onaylı teklif için e-posta taslağı (Mesajlar'da onay bekler; gönderim mevcut güvenli yoldan). */
export async function createProposalEmail(ctx: TenantContext, id: string) {
  assertCan(ctx, "message.approve");
  const db = tenantDb(ctx);
  const p = await getProposal(ctx, id);
  if (!["APPROVED", "SENT"].includes(p.status)) throw new AppError("CONFLICT", "Yalnızca onaylanmış teklif gönderilebilir.");
  const conv = await db.conversation.findFirst({ where: { leadId: p.leadId, channel: "EMAIL" }, orderBy: { updatedAt: "desc" } });
  const lastIn = conv ? await db.conversationMessage.findFirst({ where: { conversationId: conv.id, direction: "INBOUND" }, orderBy: { receivedAt: "desc" } }) : null;
  const to = lastIn?.fromAddress ?? p.lead.genericEmail;
  if (!to) throw new AppError("VALIDATION", "Lead'in e-posta adresi yok.");
  const { settings } = await getSenderSettings(ctx.companyId);
  const msg = await db.message.create({
    data: {
      companyId: ctx.companyId,
      leadId: p.leadId,
      conversationId: conv?.id ?? null,
      channel: "EMAIL",
      toAddress: to,
      subject: `Teklif ${p.number}${settings ? ` — ${settings.legalName}` : ""}`,
      body: proposalText(p, parseItems(p.items)),
      status: "PENDING_APPROVAL",
      qualityScore: 100,
      qualityNotes: { issues: [], personalization: [], blocked: false } as unknown as Prisma.InputJsonValue,
      complianceStatus: lastIn ? "SENDABLE" : null,
    },
  });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "proposal.email_drafted", entityType: "Message", entityId: msg.id });
  return msg;
}
