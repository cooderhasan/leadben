import "server-only";
import type { Prisma } from "@prisma/client";
import type { z } from "zod";
import { tenantDb, type TenantDb } from "@/server/tenancy/tenant-db";
import { assertCan } from "@/server/tenancy/permissions";
import type { TenantContext } from "@/server/tenancy/types";
import { audit } from "@/server/audit/audit";
import { AppError } from "@/lib/errors";
import { parseSpecs, type productSchema } from "@/lib/validation";

export async function listProducts(ctx: TenantContext, filter: { status?: "PENDING" | "VERIFIED"; q?: string } = {}) {
  assertCan(ctx, "product.read");
  const where: Prisma.ProductWhereInput = {};
  if (filter.status) where.status = filter.status;
  if (filter.q) where.OR = [{ name: { contains: filter.q, mode: "insensitive" } }, { sku: { contains: filter.q, mode: "insensitive" } }];
  return tenantDb(ctx).product.findMany({
    where,
    include: { category: { select: { id: true, name: true } }, _count: { select: { documents: true } } },
    orderBy: [{ status: "asc" }, { active: "desc" }, { name: "asc" }],
  });
}

export async function getProduct(ctx: TenantContext, id: string) {
  assertCan(ctx, "product.read");
  const product = await tenantDb(ctx).product.findUnique({
    where: { id },
    include: { category: true, documents: { include: { document: { select: { id: true, title: true, kind: true } } } } },
  });
  if (!product) throw new AppError("NOT_FOUND", "Ürün bulunamadı.");
  return product;
}

export async function listCategories(ctx: TenantContext) {
  return tenantDb(ctx).productCategory.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { products: true } } } });
}

async function resolveCategory(db: TenantDb, companyId: string, name: string | null | undefined) {
  if (!name) return null;
  const cat = await db.productCategory.upsert({
    where: { companyId_name: { companyId, name } },
    create: { companyId, name },
    update: {},
  });
  return cat.id;
}

function toData(input: z.infer<typeof productSchema>) {
  return {
    name: input.name,
    sku: input.sku ?? null,
    description: input.description ?? null,
    technicalSpecs: (parseSpecs(input.technicalSpecsText) ?? undefined) as Prisma.InputJsonValue | undefined,
    materials: input.materials,
    dimensions: input.dimensions ?? null,
    applications: input.applications,
    industries: input.industries,
    minOrder: input.minOrder ?? null,
    priceRange: input.priceRange ?? null,
    deliveryTime: input.deliveryTime ?? null,
    certifications: input.certifications,
  };
}

/** Kullanıcının elle girdiği ürün doğrudan VERIFIED olur (şirketin kendi beyanı). */
export async function createProduct(ctx: TenantContext, input: z.infer<typeof productSchema>) {
  assertCan(ctx, "product.write");
  const db = tenantDb(ctx);
  const categoryId = await resolveCategory(db, ctx.companyId, input.categoryName);
  const product = await db.product.create({
    data: { ...toData(input), companyId: ctx.companyId, categoryId, status: "VERIFIED", source: "USER", active: input.active ?? true },
  });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "product.created", entityType: "Product", entityId: product.id });
  return product;
}

/** Düzenleme + kaydetme ürünü onaylar (AI'ın çıkardığı PENDING ürünler için "Düzelt ve onayla"). */
export async function updateProduct(ctx: TenantContext, id: string, input: z.infer<typeof productSchema>) {
  assertCan(ctx, "product.write");
  const db = tenantDb(ctx);
  const existing = await db.product.findUnique({ where: { id }, select: { id: true, status: true } });
  if (!existing) throw new AppError("NOT_FOUND", "Ürün bulunamadı.");
  const categoryId = await resolveCategory(db, ctx.companyId, input.categoryName);
  await db.product.update({
    where: { id },
    data: { ...toData(input), categoryId, status: "VERIFIED", active: input.active ?? true },
  });
  await audit({
    companyId: ctx.companyId,
    userId: ctx.userId,
    action: existing.status === "PENDING" ? "product.verified_with_edits" : "product.updated",
    entityType: "Product",
    entityId: id,
  });
}

export async function verifyProducts(ctx: TenantContext, ids: string[]) {
  assertCan(ctx, "product.write");
  const res = await tenantDb(ctx).product.updateMany({
    where: { id: { in: ids }, status: "PENDING" },
    data: { status: "VERIFIED", active: true },
  });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "product.verified", metadata: { count: res.count } });
  return res.count;
}

export async function setProductActive(ctx: TenantContext, id: string, active: boolean) {
  assertCan(ctx, "product.write");
  await tenantDb(ctx).product.updateMany({ where: { id, status: "VERIFIED" }, data: { active } });
}

export async function deleteProduct(ctx: TenantContext, id: string) {
  assertCan(ctx, "product.write");
  const res = await tenantDb(ctx).product.deleteMany({ where: { id } });
  if (res.count === 0) throw new AppError("NOT_FOUND", "Ürün bulunamadı.");
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "product.deleted", entityType: "Product", entityId: id });
}
