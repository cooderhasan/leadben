import "server-only";
import type { CommunicationBasis, ComplianceStatus, Prisma, SuppressionSource, SuppressionType } from "@prisma/client";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { assertCan } from "@/server/tenancy/permissions";
import type { TenantContext } from "@/server/tenancy/types";
import { findPlatformSuppressions } from "@/server/tenancy/global-suppression";
import { audit } from "@/server/audit/audit";
import { AppError } from "@/lib/errors";
import { CONTACT_WINDOW_DAYS, evaluateEmailCompliance } from "@/lib/compliance";
import { checkMailDomain } from "@/server/providers/email/mx";
import { extractDomain, normalizeEmail, normalizePhone } from "@/lib/lead-normalize";

/** Gönderilmemiş (iptal edilebilir) mesaj durumları */
export const PENDING_MESSAGE_STATUSES = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SCHEDULED"] as const;

// ── Suppression (ret / engel listesi) ─────────────────────────────────

export function normalizeSuppressionValue(type: SuppressionType, value: string): string | null {
  switch (type) {
    case "EMAIL":
      return normalizeEmail(value);
    case "DOMAIN":
      return extractDomain(value.includes("@") ? value.split("@")[1]! : value);
    case "PHONE":
      return normalizePhone(value);
    case "LEAD":
      return value.trim() || null;
  }
}

function keysFor(input: { email?: string | null; leadId?: string | null }) {
  const keys: Array<{ type: SuppressionType; value: string }> = [];
  const email = normalizeEmail(input.email);
  if (email) {
    keys.push({ type: "EMAIL", value: email });
    const domain = email.split("@")[1];
    if (domain) keys.push({ type: "DOMAIN", value: domain });
  }
  if (input.leadId) keys.push({ type: "LEAD", value: input.leadId });
  return keys;
}

/** Şirketin kendi listesi + platform geneli merkezi liste. Gönderimden hemen önce de çağrılır. */
export async function findSuppression(companyId: string, input: { email?: string | null; leadId?: string | null }) {
  const keys = keysFor(input);
  if (keys.length === 0) return null;
  const own = await tenantDb({ companyId }).suppressionRecord.findFirst({
    where: { OR: keys },
    select: { type: true, value: true, reason: true, source: true },
  });
  if (own) return own;
  const platform = await findPlatformSuppressions(keys);
  return platform[0] ? { ...platform[0], source: "MANUAL" as SuppressionSource } : null;
}

interface AddSuppressionInput {
  type: SuppressionType;
  value: string;
  source: SuppressionSource;
  reason?: string | null;
  leadId?: string | null;
  createdById?: string | null;
}

/**
 * Engel kaydı ekler ve etkisini hemen uygular: bekleyen mesajlar iptal edilir,
 * kişi optOut olur, uyum kaydı DO_NOT_SEND'e çekilir. Tekrar çağrılması güvenlidir.
 */
export async function addSuppression(companyId: string, input: AddSuppressionInput) {
  const value = normalizeSuppressionValue(input.type, input.value);
  if (!value) throw new AppError("VALIDATION", "Geçerli bir e-posta, alan adı veya telefon girin.", { value: "Geçersiz değer" });
  const db = tenantDb({ companyId });

  const record = await db.suppressionRecord.upsert({
    where: { companyId_type_value: { companyId, type: input.type, value } },
    create: {
      companyId,
      type: input.type,
      value,
      source: input.source,
      reason: input.reason?.slice(0, 500) ?? null,
      leadId: input.leadId ?? null,
      createdById: input.createdById ?? null,
    },
    update: {},
  });

  // Etki: bekleyen mesajları iptal et
  const messageWhere: Prisma.MessageWhereInput = { status: { in: [...PENDING_MESSAGE_STATUSES] } };
  if (input.type === "EMAIL") messageWhere.toAddress = value;
  else if (input.type === "DOMAIN") messageWhere.toAddress = { endsWith: `@${value}` };
  else if (input.type === "LEAD") messageWhere.leadId = value;
  let cancelled = 0;
  if (input.type !== "PHONE") {
    const res = await db.message.updateMany({
      where: messageWhere,
      data: { status: "CANCELLED", error: "Ret/engel listesine eklendi." },
    });
    cancelled = res.count;
  }

  if (input.type === "EMAIL") {
    await db.leadContact.updateMany({ where: { email: value }, data: { optOut: true, consentStatus: "WITHDRAWN" } });
    await db.complianceRecord.updateMany({
      where: { channel: "EMAIL", address: value },
      data: { optOut: true, suppressed: true, status: "DO_NOT_SEND", reasons: ["Ret/engel listesinde."] },
    });
  } else if (input.type === "DOMAIN") {
    await db.complianceRecord.updateMany({
      where: { channel: "EMAIL", address: { endsWith: `@${value}` } },
      data: { suppressed: true, status: "DO_NOT_SEND", reasons: ["Alan adı engel listesinde."] },
    });
  } else if (input.type === "LEAD") {
    await db.lead.updateMany({ where: { id: value }, data: { suppressed: true, status: "SUPPRESSED" } });
    await db.complianceRecord.updateMany({
      where: { leadId: value },
      data: { suppressed: true, status: "DO_NOT_SEND", reasons: ["Firma engel listesinde."] },
    });
  }

  await audit({
    companyId,
    userId: input.createdById ?? null,
    actorType: input.createdById ? "USER" : "SYSTEM",
    action: "suppression.added",
    entityType: "SuppressionRecord",
    entityId: record.id,
    metadata: { type: input.type, source: input.source, cancelledMessages: cancelled },
  });
  return { record, cancelled };
}

export async function addSuppressionByUser(ctx: TenantContext, input: { type: SuppressionType; value: string; reason?: string | null }) {
  assertCan(ctx, "suppression.manage");
  return addSuppression(ctx.companyId, { ...input, source: "MANUAL", createdById: ctx.userId });
}

/**
 * Yalnızca elle eklenen kayıtlar kaldırılabilir. Alıcının kendi ret talebi (bağlantı / yanıt / şikâyet)
 * kullanıcı tarafından geri alınamaz.
 */
export async function removeSuppression(ctx: TenantContext, id: string) {
  assertCan(ctx, "suppression.manage");
  const db = tenantDb(ctx);
  const rec = await db.suppressionRecord.findUnique({ where: { id } });
  if (!rec) throw new AppError("NOT_FOUND", "Kayıt bulunamadı.");
  if (rec.source !== "MANUAL") {
    throw new AppError("FORBIDDEN", "Alıcının kendi ret talebi veya geri dönen/şikâyet kaydı kaldırılamaz.");
  }
  await db.suppressionRecord.delete({ where: { id } });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "suppression.removed", entityType: "SuppressionRecord", entityId: id, metadata: { type: rec.type } });
}

export async function listSuppressions(ctx: TenantContext, take = 200) {
  assertCan(ctx, "campaign.read");
  return tenantDb(ctx).suppressionRecord.findMany({ orderBy: { createdAt: "desc" }, take });
}

// ── Uyum kayıtları ─────────────────────────────────────────────────────

const STATUS_RANK: Record<ComplianceStatus, number> = { SENDABLE: 2, REVIEW_REQUIRED: 1, DO_NOT_SEND: 0 };

/**
 * Lead'in tüm e-posta adreslerini (kurumsal + kişiler) değerlendirir ve ComplianceRecord'ları günceller.
 * İnsan incelemesi (basis + reviewedAt) korunur. En uygun adresi döner (kurumsal SENDABLE öncelikli).
 */
export async function refreshLeadCompliance(companyId: string, leadId: string) {
  const db = tenantDb({ companyId });
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    include: { contacts: true, sources: { select: { type: true, fetchedAt: true }, orderBy: { fetchedAt: "asc" }, take: 1 } },
  });
  if (!lead) throw new AppError("NOT_FOUND", "Lead bulunamadı.");

  const candidates: Array<{
    address: string;
    contactId: string | null;
    contactType: "COMPANY_GENERIC" | "PERSONAL";
    basis: CommunicationBasis;
    consent: "UNKNOWN" | "GRANTED" | "DENIED" | "WITHDRAWN";
    optOut: boolean;
    source: (typeof lead.contacts)[number]["source"];
    sourceDate: Date | null;
  }> = [];
  const firstSource = lead.sources[0];
  const generic = normalizeEmail(lead.genericEmail);
  if (generic) {
    candidates.push({
      address: generic,
      contactId: null,
      contactType: "COMPANY_GENERIC",
      basis: "B2B_TRADER_ADDRESS",
      consent: "UNKNOWN",
      optOut: false,
      source: firstSource?.type ?? "MANUAL",
      sourceDate: firstSource?.fetchedAt ?? lead.discoveredAt,
    });
  }
  for (const c of lead.contacts) {
    const email = normalizeEmail(c.email);
    if (!email || candidates.some((x) => x.address === email)) continue;
    candidates.push({
      address: email,
      contactId: c.id,
      contactType: c.type,
      basis: c.communicationBasis,
      consent: c.consentStatus,
      optOut: c.optOut,
      source: c.source,
      sourceDate: c.sourceDate,
    });
  }

  // Firma bazlı sıklık: aynı alan adına son ileti + son 30 gündeki ticari ileti sayısı (yanıtlar hariç)
  const windowStart = new Date(Date.now() - CONTACT_WINDOW_DAYS * 86_400_000);
  const contactsInWindow = await db.message.count({
    where: { leadId, channel: "EMAIL", direction: "OUTBOUND", status: { in: ["SENT", "DELIVERED"] }, conversationId: null, sentAt: { gte: windowStart } },
  });

  const results = [];
  for (const cand of candidates) {
    const domain = cand.address.split("@")[1] ?? "";
    const lastToDomain = domain
      ? await db.message.findFirst({
          where: {
            channel: "EMAIL",
            direction: "OUTBOUND",
            status: { in: ["SENT", "DELIVERED"] },
            conversationId: null,
            toAddress: { endsWith: `@${domain}`, not: cand.address },
            sentAt: { not: null },
          },
          orderBy: { sentAt: "desc" },
          select: { sentAt: true },
        })
      : null;
    const existing = await db.complianceRecord.findUnique({
      where: { companyId_channel_address: { companyId, channel: "EMAIL", address: cand.address } },
    });
    const suppression = lead.suppressed ? { reason: "lead" } : await findSuppression(companyId, { email: cand.address, leadId });
    // İnsanın seçtiği dayanak korunur
    const basis = existing?.reviewedAt ? existing.communicationBasis : cand.basis;
    const evaluation = evaluateEmailCompliance({
      address: cand.address,
      mailDomain: await checkMailDomain(cand.address.split("@")[1] ?? ""),
      contactType: cand.contactType,
      basis,
      consent: cand.consent,
      optOut: cand.optOut || Boolean(existing?.optOut),
      suppressed: Boolean(suppression),
      lastContactedAt: existing?.lastContactedAt,
      domainLastContactedAt: lastToDomain?.sentAt ?? null,
      contactsInWindow,
      reviewed: Boolean(existing?.reviewedAt),
    });
    const data = {
      leadId,
      contactId: cand.contactId,
      contactType: cand.contactType,
      source: cand.source,
      sourceDate: cand.sourceDate,
      communicationBasis: basis,
      consentStatus: cand.consent,
      optOut: cand.optOut || Boolean(existing?.optOut),
      suppressed: Boolean(suppression),
      status: evaluation.status,
      reasons: evaluation.reasons,
    };
    const rec = existing
      ? await db.complianceRecord.update({ where: { id: existing.id }, data })
      : await db.complianceRecord.create({ data: { ...data, companyId, channel: "EMAIL", address: cand.address } });
    results.push(rec);
  }

  results.sort((a, b) => {
    const r = STATUS_RANK[b.status] - STATUS_RANK[a.status];
    if (r !== 0) return r;
    return (a.contactType === "COMPANY_GENERIC" ? 0 : 1) - (b.contactType === "COMPANY_GENERIC" ? 0 : 1);
  });
  return { records: results, best: results[0] ?? null };
}

/** Lead detayında gösterilen uyum kayıtları. */
export async function listLeadCompliance(ctx: TenantContext, leadId: string) {
  assertCan(ctx, "lead.read");
  return tenantDb(ctx).complianceRecord.findMany({ where: { leadId }, orderBy: [{ status: "asc" }, { createdAt: "asc" }] });
}

/** Kullanıcı bir adresi inceleyip iletişim dayanağı seçer (ör. "Tacir kurumsal adresi"). */
export async function reviewComplianceRecord(ctx: TenantContext, recordId: string, basis: CommunicationBasis) {
  assertCan(ctx, "compliance.review");
  const db = tenantDb(ctx);
  const rec = await db.complianceRecord.findUnique({ where: { id: recordId } });
  if (!rec) throw new AppError("NOT_FOUND", "Uyum kaydı bulunamadı.");
  if (rec.optOut || rec.suppressed) throw new AppError("FORBIDDEN", "Ret talebi veya engel bulunan adres gönderilebilir yapılamaz.");
  await db.complianceRecord.update({
    where: { id: recordId },
    data: { communicationBasis: basis, reviewedById: ctx.userId, reviewedAt: new Date() },
  });
  if (rec.contactId) await db.leadContact.updateMany({ where: { id: rec.contactId }, data: { communicationBasis: basis } });
  const { records } = await refreshLeadCompliance(ctx.companyId, rec.leadId);
  await audit({
    companyId: ctx.companyId,
    userId: ctx.userId,
    action: "compliance.reviewed",
    entityType: "ComplianceRecord",
    entityId: recordId,
    metadata: { basis },
  });
  return records.find((r) => r.id === recordId) ?? null;
}
