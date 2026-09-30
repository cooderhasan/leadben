import "server-only";
import type { CallOutcome, LeadStatus, Prisma } from "@prisma/client";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { assertCan } from "@/server/tenancy/permissions";
import type { TenantContext } from "@/server/tenancy/types";
import { audit } from "@/server/audit/audit";
import { AppError } from "@/lib/errors";
import { isGenericEmail, normalizeEmail, normalizePhone } from "@/lib/lead-normalize";
import { addSuppression } from "./compliance";
import { ensureOpportunity } from "./conversations";

export const CALL_OUTCOME_LABELS: Record<CallOutcome, string> = {
  NO_ANSWER: "Açmadı / ulaşılamadı",
  BUSY: "Meşgul",
  WRONG_NUMBER: "Yanlış numara",
  CALL_BACK: "Tekrar ara",
  NOT_INTERESTED: "İlgilenmiyor",
  INTERESTED: "İlgileniyor",
  CATALOG_REQUESTED: "Katalog / bilgi istedi",
  MEETING_SET: "Görüşme / ziyaret ayarlandı",
  WHATSAPP_CONSENT: "WhatsApp izni verdi",
  EMAIL_OBTAINED: "E-posta adresi verdi",
  DO_NOT_CALL: "Bir daha aranmak istemiyor",
};

/** Bu sonuçlardan sonra lead arama listesinden çıkar */
const CLOSED_OUTCOMES: CallOutcome[] = ["WRONG_NUMBER", "NOT_INTERESTED", "DO_NOT_CALL"];
const POSITIVE_OUTCOMES: CallOutcome[] = ["INTERESTED", "CATALOG_REQUESTED", "MEETING_SET", "WHATSAPP_CONSENT", "EMAIL_OBTAINED"];
const UNREACHED: CallOutcome[] = ["NO_ANSWER", "BUSY"];
/** Arama listesine hiç girmeyen lead durumları */
const EXCLUDED_STATUSES: LeadStatus[] = ["WON", "LOST", "SUPPRESSED"];
/** Satış süreci ilerlemiş lead'in durumu geri alınmaz */
const EARLY_STATUSES: LeadStatus[] = ["NEW", "RESEARCHING", "QUALIFIED", "CONTACT_READY", "CONTACTED", "REPLIED"];

const DAY = 86_400_000;
/** Ulaşılamayan firma: ilk 3 denemede ertesi gün, sonra haftada bir; 6 denemeden sonra listeden düşer */
const MAX_UNREACHED_ATTEMPTS = 6;

export type CallQueueView = "due" | "later" | "all";

/**
 * Arama listesi: telefonu olan, engellenmemiş ve kapanmamış lead'ler.
 * Sıra: vakti gelmiş geri aramalar → hiç aranmamışlar (yüksek puan önce) → diğerleri.
 */
export async function listCallQueue(ctx: TenantContext, opts: { view?: CallQueueView; onlyWithoutEmail?: boolean; take?: number } = {}) {
  assertCan(ctx, "lead.read");
  const db = tenantDb(ctx);
  const view = opts.view ?? "due";
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);

  const where: Prisma.LeadWhereInput = {
    phone: { not: null },
    suppressed: false,
    status: { notIn: EXCLUDED_STATUSES },
    OR: [{ lastCallOutcome: null }, { lastCallOutcome: { notIn: CLOSED_OUTCOMES } }],
    ...(opts.onlyWithoutEmail ? { genericEmail: null } : {}),
  };
  if (view === "due") where.AND = [{ OR: [{ nextCallAt: null, lastCallAt: null }, { nextCallAt: { lte: endOfToday } }] }];
  if (view === "later") where.nextCallAt = { gt: endOfToday };

  const rows = await db.lead.findMany({
    where,
    orderBy: [{ nextCallAt: { sort: "asc", nulls: "last" } }, { fitScore: { sort: "desc", nulls: "last" } }, { discoveredAt: "asc" }],
    take: Math.min(opts.take ?? 100, 300),
    select: {
      id: true,
      companyName: true,
      city: true,
      district: true,
      industry: true,
      phone: true,
      normalizedPhone: true,
      genericEmail: true,
      website: true,
      fitScore: true,
      status: true,
      nextCallAt: true,
      lastCallAt: true,
      lastCallOutcome: true,
      callAttempts: true,
      calls: { orderBy: { createdAt: "desc" }, take: 1, select: { note: true } },
    },
  });

  // Telefonu engel listesinde olanlar (firma veya platform geneli) aranmaz
  const phones = rows.map((r) => r.normalizedPhone ?? normalizePhone(r.phone)).filter((p): p is string => Boolean(p));
  const blocked = phones.length
    ? new Set((await db.suppressionRecord.findMany({ where: { type: "PHONE", value: { in: phones } }, select: { value: true } })).map((s) => s.value))
    : new Set<string>();
  return rows.filter((r) => !blocked.has(r.normalizedPhone ?? normalizePhone(r.phone) ?? ""));
}

export async function callQueueCounts(ctx: TenantContext) {
  const [due, later] = await Promise.all([listCallQueue(ctx, { view: "due", take: 300 }), listCallQueue(ctx, { view: "later", take: 300 })]);
  return { due: due.length, later: later.length };
}

export interface LogCallInput {
  leadId: string;
  outcome: CallOutcome;
  note?: string | null;
  /** CALL_BACK: tekrar arama zamanı; MEETING_SET: görüşme zamanı (isteğe bağlı) */
  at?: Date | null;
  /** WHATSAPP_CONSENT: izin veren kişinin cep telefonu */
  mobilePhone?: string | null;
  contactName?: string | null;
  /** EMAIL_OBTAINED (zorunlu) veya CATALOG_REQUESTED (isteğe bağlı) */
  email?: string | null;
}

/**
 * Görüşme sonucunu kaydeder ve sonuca göre aksiyon alır: tekrar arama zamanı, görev, fırsat,
 * sözlü izinle kişi kaydı (WhatsApp / e-posta) veya telefon engeli. İzin, kim/ne zaman bilgisiyle CallLog'da belgelenir.
 */
export async function logCall(ctx: TenantContext, input: LogCallInput) {
  assertCan(ctx, "lead.write");
  const db = tenantDb(ctx);
  const lead = await db.lead.findUnique({
    where: { id: input.leadId },
    select: { id: true, companyName: true, phone: true, normalizedPhone: true, genericEmail: true, callAttempts: true, lastCallOutcome: true },
  });
  if (!lead) throw new AppError("NOT_FOUND", "Lead bulunamadı.");
  const note = input.note?.trim().slice(0, 2000) || null;
  const now = new Date();
  const who = `${ctx.userId} · ${now.toISOString()}`;

  // ── Girdi doğrulama (kayıttan önce) ──
  let mobile: string | null = null;
  if (input.outcome === "WHATSAPP_CONSENT") {
    mobile = normalizePhone(input.mobilePhone);
    if (!mobile || !/^\+905\d{9}$/.test(mobile)) {
      throw new AppError("VALIDATION", "WhatsApp için geçerli bir cep telefonu girin (05xx…).", { mobilePhone: "Cep telefonu gerekli" });
    }
  }
  let email: string | null = null;
  if (input.email?.trim()) {
    email = normalizeEmail(input.email);
    if (!email) throw new AppError("VALIDATION", "E-posta adresi geçersiz.", { email: "Geçersiz adres" });
  }
  if (input.outcome === "EMAIL_OBTAINED" && !email) throw new AppError("VALIDATION", "Verilen e-posta adresini yazın.", { email: "E-posta gerekli" });
  if (input.outcome === "CALL_BACK" && (!input.at || input.at.getTime() < now.getTime() - 60_000)) {
    throw new AppError("VALIDATION", "Tekrar arama için ileri bir tarih seçin.", { at: "Tarih gerekli" });
  }

  // ── Sonraki arama zamanı ──
  // callAttempts = arka arkaya ulaşılamayan deneme sayısı (ulaşılınca sıfırlanır)
  const unreached = UNREACHED.includes(input.outcome);
  const streak = unreached ? (lead.lastCallOutcome && UNREACHED.includes(lead.lastCallOutcome) ? lead.callAttempts : 0) + 1 : 0;
  let nextCallAt: Date | null = null;
  if (unreached) {
    // Sınır dolunca tekrar zamanı konmaz → "bugün aranacaklar"dan düşer, "tümü"nde görünür
    nextCallAt = streak >= MAX_UNREACHED_ATTEMPTS ? null : new Date(now.getTime() + (streak < 3 ? DAY : 7 * DAY));
  } else if (input.outcome === "CALL_BACK") nextCallAt = input.at!;

  const phone = lead.normalizedPhone ?? normalizePhone(lead.phone);
  const call = await db.callLog.create({
    data: { companyId: ctx.companyId, leadId: lead.id, userId: ctx.userId, outcome: input.outcome, note, phone, nextCallAt },
  });
  await db.lead.update({
    where: { id: lead.id },
    data: {
      lastCallAt: now,
      lastCallOutcome: input.outcome,
      nextCallAt,
      callAttempts: streak,
    },
  });

  // ── Lead durumu ──
  const reached = !unreached && input.outcome !== "WRONG_NUMBER";
  if (POSITIVE_OUTCOMES.includes(input.outcome)) {
    await db.lead.updateMany({ where: { id: lead.id, status: { in: EARLY_STATUSES } }, data: { status: "INTERESTED" } });
  } else if (input.outcome === "NOT_INTERESTED") {
    await db.lead.updateMany({ where: { id: lead.id, status: { in: EARLY_STATUSES } }, data: { status: "LOST" } });
  } else if (reached) {
    await db.lead.updateMany({ where: { id: lead.id, status: { in: ["NEW", "RESEARCHING", "QUALIFIED", "CONTACT_READY"] } }, data: { status: "CONTACTED" } });
  }

  // ── Sonuca göre aksiyon ──
  let opportunityId: string | null = null;
  if (POSITIVE_OUTCOMES.includes(input.outcome)) opportunityId = (await ensureOpportunity(ctx.companyId, lead.id, "INTERESTED")).id;

  if (email) {
    if (isGenericEmail(email) && !lead.genericEmail) {
      await db.lead.update({ where: { id: lead.id }, data: { genericEmail: email } });
    } else {
      // Kişisel adres: telefonda bilgi gönderilmesini isteyerek verdi → açık izin, kaydı CallLog'da
      await upsertContact(ctx, lead.id, { email, fullName: input.contactName }, who);
    }
  }
  if (mobile) await upsertContact(ctx, lead.id, { phone: mobile, fullName: input.contactName }, who);

  if (input.outcome === "DO_NOT_CALL" && phone) {
    await addSuppression(ctx.companyId, { type: "PHONE", value: phone, source: "MANUAL", reason: "Telefonda bir daha aranmak istemediğini bildirdi.", leadId: lead.id, createdById: ctx.userId });
  }

  const task = TASKS[input.outcome];
  if (task) {
    const due = input.outcome === "CALL_BACK" || input.outcome === "MEETING_SET" ? (input.at ?? new Date(now.getTime() + DAY)) : new Date(now.getTime() + task.dueInDays * DAY);
    const exists = await db.task.findFirst({ where: { leadId: lead.id, title: task.title, status: "OPEN" }, select: { id: true } });
    if (exists) await db.task.update({ where: { id: exists.id }, data: { dueAt: due, description: note ?? undefined } });
    else {
      await db.task.create({
        data: {
          companyId: ctx.companyId,
          leadId: lead.id,
          opportunityId,
          title: task.title,
          description: note,
          priority: task.priority,
          dueAt: due,
          createdById: ctx.userId,
          assigneeId: ctx.userId,
        },
      });
    }
  }

  await audit({
    companyId: ctx.companyId,
    userId: ctx.userId,
    action: "call.logged",
    entityType: "Lead",
    entityId: lead.id,
    metadata: { outcome: input.outcome, callId: call.id, consent: Boolean(mobile || (email && !isGenericEmail(email))) },
  });
  return { callId: call.id, nextCallAt, opportunityId };
}

const TASKS: Partial<Record<CallOutcome, { title: string; priority: "LOW" | "MEDIUM" | "HIGH"; dueInDays: number }>> = {
  CALL_BACK: { title: "Tekrar arayın", priority: "MEDIUM", dueInDays: 1 },
  INTERESTED: { title: "İlgilenen firmaya dönüş yapın", priority: "HIGH", dueInDays: 1 },
  CATALOG_REQUESTED: { title: "Katalog / bilgi gönderin", priority: "HIGH", dueInDays: 1 },
  MEETING_SET: { title: "Görüşmeye hazırlanın", priority: "HIGH", dueInDays: 1 },
  WHATSAPP_CONSENT: { title: "WhatsApp'tan katalog / bilgi gönderin", priority: "HIGH", dueInDays: 1 },
  EMAIL_OBTAINED: { title: "E-posta ile bilgi gönderin", priority: "HIGH", dueInDays: 1 },
};

/** Telefonda sözlü izin veren kişi: açık izinli iletişim kaydı (varsa güncellenir). */
async function upsertContact(ctx: TenantContext, leadId: string, c: { email?: string | null; phone?: string | null; fullName?: string | null }, who: string) {
  const db = tenantDb(ctx);
  const existing = await db.leadContact.findFirst({
    where: { leadId, OR: [...(c.email ? [{ email: c.email }] : []), ...(c.phone ? [{ phone: c.phone }] : [])] },
    select: { id: true, optOut: true },
  });
  const data = {
    communicationBasis: "EXPLICIT_CONSENT" as const,
    consentStatus: "GRANTED" as const,
    sourceDate: new Date(),
    sourceUrl: `call:${who}`,
    ...(c.fullName?.trim() ? { fullName: c.fullName.trim().slice(0, 200) } : {}),
  };
  if (existing) {
    // Daha önce ret bildirmiş kişi için izin buradan geri açılmaz
    if (existing.optOut) throw new AppError("FORBIDDEN", "Bu kişi daha önce ret bildirmiş; izin kaydı değiştirilemez.");
    await db.leadContact.update({ where: { id: existing.id }, data });
    return;
  }
  await db.leadContact.create({
    data: { companyId: ctx.companyId, leadId, type: "PERSONAL", email: c.email ?? null, phone: c.phone ?? null, source: "MANUAL", ...data },
  });
}

export async function listLeadCalls(ctx: TenantContext, leadId: string) {
  assertCan(ctx, "lead.read");
  return tenantDb(ctx).callLog.findMany({ where: { leadId }, orderBy: { createdAt: "desc" }, take: 50 });
}
