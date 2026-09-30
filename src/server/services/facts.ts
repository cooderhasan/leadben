import "server-only";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { assertCan } from "@/server/tenancy/permissions";
import type { TenantContext } from "@/server/tenancy/types";
import { audit } from "@/server/audit/audit";
import { AppError } from "@/lib/errors";

export async function listFacts(ctx: TenantContext, status?: "PENDING" | "VERIFIED" | "REJECTED") {
  return tenantDb(ctx).companyFact.findMany({
    where: status ? { status } : {},
    orderBy: [{ key: "asc" }, { confidence: "desc" }, { createdAt: "asc" }],
  });
}

/** "Onayla" — değer olduğu gibi doğrulanmış bilgi olur. */
export async function verifyFacts(ctx: TenantContext, factIds: string[]) {
  assertCan(ctx, "facts.review");
  if (factIds.length === 0) return 0;
  const res = await tenantDb(ctx).companyFact.updateMany({
    where: { id: { in: factIds }, status: { not: "VERIFIED" } },
    data: { status: "VERIFIED", reviewedById: ctx.userId, reviewedAt: new Date() },
  });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "fact.verified", metadata: { count: res.count, ids: factIds.slice(0, 100) } });
  return res.count;
}

/** "Düzelt" — kullanıcı değeri değiştirir; düzeltilmiş değer doğrulanmış kabul edilir. */
export async function correctFact(ctx: TenantContext, factId: string, value: string) {
  assertCan(ctx, "facts.review");
  const db = tenantDb(ctx);
  const fact = await db.companyFact.findUnique({ where: { id: factId } });
  if (!fact) throw new AppError("NOT_FOUND", "Bilgi bulunamadı.");
  await db.companyFact.update({
    where: { id: factId },
    data: { value, status: "VERIFIED", source: "USER", reviewedById: ctx.userId, reviewedAt: new Date() },
  });
  await audit({
    companyId: ctx.companyId,
    userId: ctx.userId,
    action: "fact.corrected",
    entityType: "CompanyFact",
    entityId: factId,
    metadata: { before: fact.value.slice(0, 500), after: value.slice(0, 500) },
  });
}

export async function rejectFacts(ctx: TenantContext, factIds: string[]) {
  assertCan(ctx, "facts.review");
  const res = await tenantDb(ctx).companyFact.updateMany({
    where: { id: { in: factIds } },
    data: { status: "REJECTED", reviewedById: ctx.userId, reviewedAt: new Date() },
  });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "fact.rejected", metadata: { count: res.count } });
  return res.count;
}

export async function addUserFact(ctx: TenantContext, key: string, value: string) {
  assertCan(ctx, "facts.review");
  const existing = await tenantDb(ctx).companyFact.findMany({ where: { key, status: "VERIFIED" }, select: { value: true } });
  const norm = (s: string) => s.toLocaleLowerCase("tr").replace(/\s+/g, " ").trim();
  if (existing.some((f) => norm(f.value) === norm(value))) throw new AppError("CONFLICT", "Bu bilgi zaten kayıtlı.", { value: "Zaten var" });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "fact.added", metadata: { key } });
  return tenantDb(ctx).companyFact.create({
    data: {
      companyId: ctx.companyId,
      key,
      value,
      source: "USER",
      status: "VERIFIED",
      reviewedById: ctx.userId,
      reviewedAt: new Date(),
    },
  });
}

/** "Firmayı böyle anladım" özetini onaylar veya düzeltir. */
export async function reviewSummary(ctx: TenantContext, action: "verify" | "correct", correctedText?: string) {
  assertCan(ctx, "facts.review");
  const db = tenantDb(ctx);
  const profile = await db.companyProfile.findUnique({ where: { companyId: ctx.companyId } });
  if (!profile?.aiSummary && action === "verify") throw new AppError("NOT_FOUND", "Onaylanacak özet yok.");
  await db.companyProfile.update({
    where: { companyId: ctx.companyId },
    data: {
      aiSummary: action === "correct" ? correctedText : profile?.aiSummary,
      aiSummaryStatus: "VERIFIED",
    },
  });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: `company.summary.${action === "verify" ? "verified" : "corrected"}` });
}

/**
 * Onaylanmış bir "product" fact'ini ürün kataloğuna ekler.
 * "Ad — açıklama" biçimindeki değer ayrıştırılır.
 */
export async function promoteFactToProduct(ctx: TenantContext, factId: string) {
  assertCan(ctx, "product.write");
  const db = tenantDb(ctx);
  const fact = await db.companyFact.findUnique({ where: { id: factId } });
  if (!fact || fact.key !== "product") throw new AppError("NOT_FOUND", "Ürün bilgisi bulunamadı.");
  const [name, ...rest] = fact.value.split(" — ");
  const product = await db.product.create({
    data: {
      companyId: ctx.companyId,
      name: (name ?? fact.value).slice(0, 200),
      description: rest.join(" — ") || null,
      status: "VERIFIED",
      source: fact.source === "USER" ? "USER" : "WEBSITE",
      sourceRef: fact.sourceRef,
    },
  });
  if (fact.status !== "VERIFIED") {
    await db.companyFact.update({ where: { id: factId }, data: { status: "VERIFIED", reviewedById: ctx.userId, reviewedAt: new Date() } });
  }
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "product.created_from_fact", entityType: "Product", entityId: product.id });
  return product;
}

/**
 * AI satış içeriği üretirken kullanılacak TEK şirket bağlamı kaynağı (Faz 3'te mesaj üretimi bunu kullanır).
 * Yalnızca VERIFIED fact'ler, onaylı + aktif ürünler ve onaylı özet döner.
 */
export async function buildVerifiedCompanyContext(ctx: Pick<TenantContext, "companyId">) {
  const db = tenantDb(ctx);
  const [company, facts, products, memories] = await Promise.all([
    db.company.findUniqueOrThrow({ where: { id: ctx.companyId }, include: { profile: true } }),
    db.companyFact.findMany({ where: { status: "VERIFIED" }, select: { key: true, value: true } }),
    db.product.findMany({
      where: { status: "VERIFIED", active: true },
      select: { name: true, description: true, applications: true, industries: true, certifications: true, minOrder: true, deliveryTime: true, technicalSpecs: true },
    }),
    db.companyMemory.findMany({ where: { status: "ACTIVE" }, select: { type: true, content: true } }),
  ]);
  const profile = company.profile;
  return {
    name: company.name,
    website: company.website,
    summary: profile?.aiSummaryStatus === "VERIFIED" ? profile.aiSummary : null,
    sector: profile?.sector ?? null,
    facts,
    products,
    rules: memories,
  };
}
