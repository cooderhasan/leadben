import "server-only";
import type { LeadStatus, Prisma } from "@prisma/client";
import { tenantDb, type TenantDb } from "@/server/tenancy/tenant-db";
import { assertCan } from "@/server/tenancy/permissions";
import type { TenantContext } from "@/server/tenancy/types";
import { audit } from "@/server/audit/audit";
import { AppError } from "@/lib/errors";
import {
  extractDomain,
  isCompanyEmail,
  isGenericEmail,
  normalizeCompanyName,
  normalizeEmail,
  normalizePhone,
} from "@/lib/lead-normalize";
import type { RawLead } from "@/server/providers/lead-source/types";
import { checkMailDomain } from "@/server/providers/email/mx";
import { checkEmailQuality } from "@/lib/email-quality";
import { emitEvent } from "./integrations";

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  NEW: "Yeni",
  RESEARCHING: "Araştırılıyor",
  QUALIFIED: "Uygun",
  CONTACT_READY: "İletişime hazır",
  CONTACTED: "İletişim kuruldu",
  REPLIED: "Yanıt verdi",
  INTERESTED: "İlgileniyor",
  QUALIFIED_OPPORTUNITY: "Fırsat",
  QUOTE_REQUESTED: "Teklif istedi",
  PROPOSAL_SENT: "Teklif gönderildi",
  NEGOTIATION: "Görüşme",
  WON: "Kazanıldı",
  LOST: "Kaybedildi",
  NURTURE: "Besleme",
  SUPPRESSED: "Engellendi",
};

export interface LeadFilter {
  q?: string;
  status?: LeadStatus;
  city?: string;
  minScore?: number;
  /** Yalnızca puanlanmamış lead'ler */
  unscored?: boolean;
  /** Kaynak: Google Haritalar, web araması, liste sayfası, CSV, elle */
  source?: LeadSourceFilter;
  /** Kurumsal e-postası olan / olmayan */
  email?: "yes" | "no";
  /** Sorumlu: kullanıcı kimliği veya "none" (atanmamış) */
  owner?: string;
  /** Yalnızca bu listedeki firmalar */
  listId?: string;
  /** Açık kampanyada olan / olmayan */
  campaign?: "in" | "out";
  sort?: LeadSort;
  take?: number;
  skip?: number;
}

export const LEAD_SORTS = {
  score: { label: "Puan (yüksekten)", order: [{ fitScore: { sort: "desc", nulls: "last" } }, { discoveredAt: "desc" }] },
  new: { label: "En yeni", order: [{ discoveredAt: "desc" }] },
  name: { label: "Firma adı (A-Z)", order: [{ companyName: "asc" }] },
} satisfies Record<string, { label: string; order: Prisma.LeadOrderByWithRelationInput[] }>;
export type LeadSort = keyof typeof LEAD_SORTS;

/** Açık kampanya aşamaları (lead "kampanyada mı" kontrolü) */
const OPEN_CAMPAIGN_STATUSES = ["DRAFT", "STRATEGY_REVIEW", "READY", "PAUSED", "RUNNING"] as const;

export const LEAD_SOURCE_FILTERS = {
  maps: { label: "Google Haritalar", providers: ["apify"] },
  web: { label: "Web araması", providers: ["apify-web"] },
  directory: { label: "Liste sayfası", providers: ["directory"] },
  csv: { label: "CSV", providers: ["csv"] },
  manual: { label: "Elle", providers: ["manual"] },
} as const;
export type LeadSourceFilter = keyof typeof LEAD_SOURCE_FILTERS;

export function buildWhere(filter: LeadFilter): Prisma.LeadWhereInput {
  const where: Prisma.LeadWhereInput = {};
  if (filter.source) where.sources = { some: { provider: { in: [...LEAD_SOURCE_FILTERS[filter.source].providers] } } };
  if (filter.email === "yes") where.genericEmail = { not: null };
  if (filter.email === "no") where.genericEmail = null;
  if (filter.owner) where.ownerId = filter.owner === "none" ? null : filter.owner;
  if (filter.listId) where.lists = { some: { listId: filter.listId } };
  if (filter.campaign) {
    const inOpen = { campaign: { status: { in: [...OPEN_CAMPAIGN_STATUSES] } } };
    where.campaignLeads = filter.campaign === "in" ? { some: inOpen } : { none: inOpen };
  }
  if (filter.status) where.status = filter.status;
  if (filter.city) where.city = { equals: filter.city, mode: "insensitive" };
  if (typeof filter.minScore === "number") where.fitScore = { gte: filter.minScore };
  if (filter.unscored) where.fitScore = null;
  if (filter.q) {
    const q = filter.q.trim();
    where.OR = [
      { companyName: { contains: q, mode: "insensitive" } },
      { normalizedName: { contains: normalizeCompanyName(q) } },
      { domain: { contains: q.toLowerCase() } },
      { city: { contains: q, mode: "insensitive" } },
      { industry: { contains: q, mode: "insensitive" } },
    ];
  }
  return where;
}

export async function listLeads(ctx: TenantContext, filter: LeadFilter = {}) {
  assertCan(ctx, "lead.read");
  const db = tenantDb(ctx);
  const where = buildWhere(filter);
  const [rows, total] = await Promise.all([
    db.lead.findMany({
      where,
      orderBy: LEAD_SORTS[filter.sort ?? "score"].order,
      take: Math.min(filter.take ?? 50, 200),
      skip: filter.skip ?? 0,
      include: {
        _count: { select: { contacts: true, signals: true } },
        sources: { select: { type: true, provider: true }, take: 3 },
        campaignLeads: {
          where: { campaign: { status: { in: [...OPEN_CAMPAIGN_STATUSES] } } },
          select: { campaign: { select: { id: true, name: true, createdById: true } } },
          take: 2,
        },
      },
    }),
    db.lead.count({ where }),
  ]);
  return { rows, total };
}

/** Toplu işlemde en fazla seçilebilen lead */
export const BULK_MAX = 500;

/**
 * Toplu işlem seçimini lead id listesine çevirir: ya işaretlenen id'ler ya da "filtreye uyan tümü".
 * Her durumda yalnızca bu şirketin lead'leri döner (istemciden gelen id'ye güvenilmez).
 */
export async function resolveLeadSelection(ctx: TenantContext, sel: { ids?: string[]; filter?: LeadFilter }, max = BULK_MAX) {
  assertCan(ctx, "lead.read");
  const where = sel.filter ? buildWhere(sel.filter) : { id: { in: [...new Set(sel.ids ?? [])].slice(0, max) } };
  const rows = await tenantDb(ctx).lead.findMany({
    where,
    orderBy: [{ fitScore: { sort: "desc", nulls: "last" } }, { discoveredAt: "desc" }],
    take: max,
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Toplu durum değişikliği */
export async function bulkUpdateLeadStatus(ctx: TenantContext, ids: string[], status: LeadStatus) {
  assertCan(ctx, "lead.write");
  const res = await tenantDb(ctx).lead.updateMany({ where: { id: { in: ids } }, data: { status, suppressed: status === "SUPPRESSED" } });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "lead.bulk_status", metadata: { status, count: res.count } });
  return res.count;
}

/** Toplu silme */
export async function bulkDeleteLeads(ctx: TenantContext, ids: string[]) {
  assertCan(ctx, "lead.write");
  const res = await tenantDb(ctx).lead.deleteMany({ where: { id: { in: ids } } });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "lead.bulk_deleted", metadata: { count: res.count } });
  return res.count;
}

/** Toplu sorumlu atama (null = atanmamış). Sorumlu, şirketin üyesi olmalı. */
export async function bulkAssignOwner(ctx: TenantContext, ids: string[], ownerId: string | null) {
  assertCan(ctx, "lead.write");
  const db = tenantDb(ctx);
  if (ownerId) {
    const member = await db.companyMember.findFirst({ where: { userId: ownerId }, select: { id: true } });
    if (!member) throw new AppError("VALIDATION", "Seçilen kişi bu şirketin ekibinde değil.");
  }
  const res = await db.lead.updateMany({ where: { id: { in: ids } }, data: { ownerId } });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "lead.owner_assigned", metadata: { count: res.count, ownerId } });
  return res.count;
}

// ── Listeler (her arama / içe aktarma bir liste) ───────────────────────

export async function listLeadLists(ctx: TenantContext, take = 100) {
  assertCan(ctx, "lead.read");
  const lists = await tenantDb(ctx).leadList.findMany({
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, name: true, kind: true, createdById: true, createdAt: true, _count: { select: { items: true } } },
  });
  return lists.map((l) => ({ ...l, count: l._count.items }));
}

export async function createLeadList(ctx: TenantContext, name: string, leadIds: string[] = []) {
  assertCan(ctx, "lead.write");
  const trimmed = name.trim().slice(0, 120);
  if (trimmed.length < 2) throw new AppError("VALIDATION", "Liste adı girin.", { name: "En az 2 karakter" });
  const list = await tenantDb(ctx).leadList.create({ data: { companyId: ctx.companyId, name: trimmed, kind: "MANUAL", createdById: ctx.userId } });
  if (leadIds.length) await addLeadsToList(ctx, list.id, leadIds);
  return list;
}

export async function addLeadsToList(ctx: TenantContext, listId: string, leadIds: string[]) {
  assertCan(ctx, "lead.write");
  const db = tenantDb(ctx);
  const list = await db.leadList.findUnique({ where: { id: listId }, select: { id: true, name: true } });
  if (!list) throw new AppError("NOT_FOUND", "Liste bulunamadı.");
  const owned = await db.lead.findMany({ where: { id: { in: ids(leadIds) } }, select: { id: true } });
  const res = await db.leadListItem.createMany({
    data: owned.map((l) => ({ listId, leadId: l.id, companyId: ctx.companyId })),
    skipDuplicates: true,
  });
  return { added: res.count, name: list.name };
}

export async function removeLeadsFromList(ctx: TenantContext, listId: string, leadIds: string[]) {
  assertCan(ctx, "lead.write");
  const db = tenantDb(ctx);
  const res = await db.leadListItem.deleteMany({ where: { listId, leadId: { in: ids(leadIds) } } });
  return res.count;
}

const ids = (v: string[]) => [...new Set(v)].slice(0, BULK_MAX);

/**
 * Arama / içe aktarma işinin listesini oluşturur (aynı iş için tekrar çağrılırsa mevcut liste döner).
 * İş içinden çağrılır; ctx yoktur.
 */
export async function ensureJobList(companyId: string, input: { jobId: string; name: string; kind: "SEARCH" | "IMPORT"; createdById?: string | null }) {
  const db = tenantDb({ companyId });
  const existing = await db.leadList.findFirst({ where: { jobId: input.jobId }, select: { id: true } });
  if (existing) return existing.id;
  const list = await db.leadList.create({
    data: { companyId, jobId: input.jobId, name: input.name.trim().slice(0, 120) || "Liste", kind: input.kind, createdById: input.createdById ?? null },
  });
  return list.id;
}

export async function leadStats(ctx: TenantContext) {
  assertCan(ctx, "lead.read");
  const db = tenantDb(ctx);
  const [total, scored, qualified, contactReady] = await Promise.all([
    db.lead.count(),
    db.lead.count({ where: { fitScore: { not: null } } }),
    db.lead.count({ where: { fitScore: { gte: 70 } } }),
    db.lead.count({ where: { status: { in: ["CONTACT_READY", "QUALIFIED"] } } }),
  ]);
  return { total, scored, qualified, contactReady };
}

export async function getLead(ctx: TenantContext, id: string) {
  assertCan(ctx, "lead.read");
  const lead = await tenantDb(ctx).lead.findUnique({
    where: { id },
    include: {
      contacts: { orderBy: { createdAt: "asc" } },
      sources: { orderBy: { fetchedAt: "desc" } },
      signals: { orderBy: [{ publishedAt: "desc" }, { detectedAt: "desc" }] },
      scores: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  if (!lead) throw new AppError("NOT_FOUND", "Lead bulunamadı.");
  return lead;
}

export async function updateLeadStatus(ctx: TenantContext, id: string, status: LeadStatus) {
  assertCan(ctx, "lead.write");
  const res = await tenantDb(ctx).lead.updateMany({
    where: { id },
    data: { status, suppressed: status === "SUPPRESSED" },
  });
  if (res.count === 0) throw new AppError("NOT_FOUND", "Lead bulunamadı.");
  await audit({
    companyId: ctx.companyId,
    userId: ctx.userId,
    action: "lead.status_changed",
    entityType: "Lead",
    entityId: id,
    metadata: { status },
  });
}

/**
 * Kurumsal iletişim bilgilerini elle düzeltir (ör. robots.txt ile taramayı yasaklayan sitedeki adresi
 * kullanıcı kendisi okuyup girer). Kişisel adresler buraya yazılmaz — KVKK: kişiler ayrı tutulur.
 */
export async function updateLeadContactInfo(ctx: TenantContext, input: { id: string; website?: string | null; phone?: string | null; genericEmail?: string | null }) {
  assertCan(ctx, "lead.write");
  const db = tenantDb(ctx);
  const lead = await db.lead.findUnique({ where: { id: input.id }, select: { id: true, website: true } });
  if (!lead) throw new AppError("NOT_FOUND", "Lead bulunamadı.");

  const website = input.website?.trim() || null;
  const domain = website ? extractDomain(website) : null;
  if (website && !domain) throw new AppError("VALIDATION", "Web adresi geçersiz.", { website: "Geçersiz adres" });
  const phone = input.phone?.trim() || null;
  const normalizedPhone = phone ? normalizePhone(phone) : null;
  if (phone && !normalizedPhone) throw new AppError("VALIDATION", "Telefon numarası geçersiz.", { phone: "Geçersiz numara" });
  const email = input.genericEmail?.trim() ? normalizeEmail(input.genericEmail) : null;
  if (input.genericEmail?.trim() && !email) throw new AppError("VALIDATION", "E-posta adresi geçersiz.", { genericEmail: "Geçersiz adres" });
  if (email) {
    const q = checkEmailQuality(email);
    if (q.blocking) throw new AppError("VALIDATION", q.suggestion ? `${q.message} (${q.suggestion})` : (q.message ?? "Adres geçersiz."), { genericEmail: "Geçersiz adres" });
    if ((await checkMailDomain(q.domain ?? "")) === "no_mx") {
      throw new AppError("VALIDATION", "Bu alan adı e-posta alamıyor (DNS'te posta kaydı yok). Adresi kontrol edin.", { genericEmail: "Alan adı posta almıyor" });
    }
  }
  if (email && !isCompanyEmail(email, website ?? lead.website)) {
    throw new AppError("VALIDATION", "Bu adres bir kişiye ait görünüyor. Buraya yalnızca kurumsal adres girin (info@, satis@, satinalma@…).", {
      genericEmail: "Kişisel adres",
    });
  }

  // Yalnızca gönderilen alanlar değişir (hızlı "e-posta ekle" telefonu / siteyi silmesin)
  const data: Prisma.LeadUpdateInput = {};
  if (input.website !== undefined) Object.assign(data, { website: website ? (/^https?:\/\//i.test(website) ? website : `https://${website}`) : null, domain });
  if (input.phone !== undefined) Object.assign(data, { phone, normalizedPhone });
  if (input.genericEmail !== undefined) data.genericEmail = email;
  await db.lead.update({ where: { id: lead.id }, data });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "lead.contact_updated", entityType: "Lead", entityId: lead.id, metadata: { website: Boolean(website), phone: Boolean(phone), email: Boolean(email) } });
}

export async function deleteLead(ctx: TenantContext, id: string) {
  assertCan(ctx, "lead.write");
  const res = await tenantDb(ctx).lead.deleteMany({ where: { id } });
  if (res.count === 0) throw new AppError("NOT_FOUND", "Lead bulunamadı.");
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "lead.deleted", entityType: "Lead", entityId: id });
}

// ── Dedupe + kaydetme ────────────────────────────────────────────────

/** Ham lead'den DB alanlarını türetir (normalize edilmiş dedupe anahtarları dahil). */
export function rawToLeadData(raw: RawLead) {
  return {
    companyName: raw.companyName.trim().slice(0, 300),
    normalizedName: normalizeCompanyName(raw.companyName),
    domain: extractDomain(raw.website),
    website: raw.website?.trim().slice(0, 500) ?? null,
    phone: raw.phone?.trim().slice(0, 50) ?? null,
    normalizedPhone: normalizePhone(raw.phone),
    genericEmail: normalizeEmail(raw.genericEmail),
    address: raw.address?.trim().slice(0, 500) ?? null,
    city: raw.city?.trim().slice(0, 120) ?? null,
    district: raw.district?.trim().slice(0, 120) ?? null,
    country: raw.country?.trim().slice(0, 120) ?? "TR",
    industry: raw.category?.trim().slice(0, 200) ?? null,
    instagram: raw.socialProfiles?.instagram ?? null,
    linkedin: raw.socialProfiles?.linkedin ?? null,
    facebook: raw.socialProfiles?.facebook ?? null,
  };
}

/**
 * Mevcut lead'i bulur: alan adı → normalize telefon → normalize firma adı (+ şehir).
 * Farklı kaynaklardan gelse de aynı firma iki kez yazılmaz (spec §36 dedupe).
 */
async function findDuplicate(db: TenantDb, data: ReturnType<typeof rawToLeadData>) {
  const or: Prisma.LeadWhereInput[] = [];
  if (data.domain) or.push({ domain: data.domain });
  if (data.normalizedPhone) or.push({ normalizedPhone: data.normalizedPhone });
  // slugify boş/Latin dışı adlarda "sirket" döner — bu anahtarla eşleştirme yanlış birleştirme yapar
  if (data.normalizedName && data.normalizedName.length >= 3 && data.normalizedName !== "sirket") {
    or.push(
      data.city
        ? { normalizedName: data.normalizedName, city: { equals: data.city, mode: "insensitive" } }
        : { normalizedName: data.normalizedName },
    );
  }
  if (or.length === 0) return null;
  return db.lead.findFirst({ where: { OR: or }, orderBy: { createdAt: "asc" } });
}

/** Boş olan alanları doldurur; dolu alanların üzerine yazmaz. */
function fillMissing(existing: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null || value === undefined || value === "") continue;
    const current = existing[key];
    if (current === null || current === undefined || current === "") patch[key] = value;
  }
  return patch;
}

export interface SaveLeadsResult {
  created: number;
  merged: number;
  skipped: number;
  leadIds: string[];
}

/**
 * Kaynaktan gelen lead'leri dedupe ederek kaydeder. İş (job) bağlamında da çalışır:
 * kullanıcı rolü yoktur, yetki kontrolü çağıran taraftadır.
 */
export async function saveDiscoveredLeads(
  companyId: string,
  raws: RawLead[],
  opts: { provider: string; runId?: string; ownerId?: string | null; listId?: string },
): Promise<SaveLeadsResult> {
  const db = tenantDb({ companyId });
  const result: SaveLeadsResult = { created: 0, merged: 0, skipped: 0, leadIds: [] };

  for (const raw of raws) {
    if (!raw.companyName?.trim()) {
      result.skipped++;
      continue;
    }
    const data = rawToLeadData(raw);
    const existing = await findDuplicate(db, data);

    let leadId: string;
    if (existing) {
      const patch = fillMissing(existing as unknown as Record<string, unknown>, data as unknown as Record<string, unknown>);
      if (Object.keys(patch).length > 0) {
        await db.lead.update({ where: { id: existing.id }, data: patch as Prisma.LeadUpdateInput });
      }
      leadId = existing.id;
      result.merged++;
    } else {
      // Sorumlu yalnızca yeni kayıtta atanır; mevcut firmanın sorumlusu değişmez
      const created = await db.lead.create({ data: { ...data, companyId, status: "NEW", ownerId: opts.ownerId ?? null } });
      leadId = created.id;
      result.created++;
    }
    result.leadIds.push(leadId);

    // Kaynak kaydı: aynı sağlayıcı + externalId tekrar eklenmez
    const already = raw.externalId
      ? await db.leadSource.findFirst({ where: { leadId, provider: opts.provider, externalId: raw.externalId } })
      : null;
    if (!already) {
      await db.leadSource.create({
        data: {
          companyId,
          leadId,
          type: raw.sourceType,
          provider: opts.provider,
          externalId: raw.externalId ?? null,
          sourceUrl: raw.sourceUrl ?? null,
          rawData: (raw.raw ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
    }

    await saveContacts(db, companyId, leadId, raw);
  }

  // Bu arama / içe aktarmanın listesi: hem yeni hem birleşen firmalar listeye girer
  if (opts.listId && result.leadIds.length) {
    await db.leadListItem.createMany({
      data: result.leadIds.map((leadId) => ({ listId: opts.listId!, leadId, companyId })),
      skipDuplicates: true,
    });
  }

  await audit({
    companyId,
    actorType: "SYSTEM",
    action: "lead.discovered",
    metadata: {
      provider: opts.provider,
      runId: opts.runId ?? null,
      created: result.created,
      merged: result.merged,
      skipped: result.skipped,
      leadIds: result.leadIds.slice(0, 50),
    },
  });
  // Toplu ekleme tek olay olarak yayınlanır (tek tek elle eklemede "lead.created" ayrıca yayınlanır)
  if (result.created > 0 && opts.provider !== "manual") {
    await emitEvent(companyId, "leads.imported", { source: opts.provider, created: result.created, merged: result.merged, leadIds: result.leadIds.slice(0, 100) });
  }
  return result;
}

/**
 * Kişisel iletişim bilgileri ayrı kayıtta tutulur; hukuki dayanak varsayılan NONE'dur
 * (gönderim öncesi uyum kontrolü Faz 3'te bu alanı kullanır).
 */
async function saveContacts(db: TenantDb, companyId: string, leadId: string, raw: RawLead) {
  for (const c of raw.personalContacts ?? []) {
    const email = normalizeEmail(c.email);
    const phone = normalizePhone(c.phone);
    if (!email && !phone && !c.fullName) continue;
    const orFilters: Prisma.LeadContactWhereInput[] = [];
    if (email) orFilters.push({ email });
    if (phone) orFilters.push({ phone });
    const exists = orFilters.length > 0 ? await db.leadContact.findFirst({ where: { leadId, OR: orFilters } }) : null;
    if (exists) continue;
    await db.leadContact.create({
      data: {
        companyId,
        leadId,
        type: isGenericEmail(email) ? "COMPANY_GENERIC" : "PERSONAL",
        fullName: c.fullName?.slice(0, 200) ?? null,
        title: c.title?.slice(0, 200) ?? null,
        email,
        phone,
        source: raw.sourceType,
        sourceUrl: c.sourceUrl ?? raw.sourceUrl ?? null,
        sourceDate: new Date(),
      },
    });
  }
}

/** Elle lead ekleme — dedupe aynı kurallarla çalışır. */
export async function createManualLead(ctx: TenantContext, raw: RawLead) {
  assertCan(ctx, "lead.write");
  const res = await saveDiscoveredLeads(ctx.companyId, [raw], { provider: "manual", ownerId: ctx.userId });
  const leadId = res.leadIds[0];
  if (!leadId) throw new AppError("VALIDATION", "Lead kaydedilemedi: firma adı gerekli.");
  await audit({
    companyId: ctx.companyId,
    userId: ctx.userId,
    action: "lead.created_manual",
    entityType: "Lead",
    entityId: leadId,
  });
  if (res.created > 0) await emitEvent(ctx.companyId, "lead.created", { leadId, companyName: raw.companyName });
  return { leadId, merged: res.merged > 0 };
}

/** Sinyaller sayfası: tüm lead'lerdeki doğrulanmış satış sinyalleri, en yeniden eskiye. */
export async function listRecentSignals(ctx: TenantContext, take = 100) {
  assertCan(ctx, "lead.read");
  return tenantDb(ctx).leadSignal.findMany({
    where: { verified: true },
    orderBy: { detectedAt: "desc" },
    take: Math.min(take, 200),
    include: { lead: { select: { id: true, companyName: true, city: true, fitScore: true } } },
  });
}
