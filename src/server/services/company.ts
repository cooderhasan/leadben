import "server-only";
import { Prisma } from "@prisma/client";
import type { z } from "zod";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { assertCan } from "@/server/tenancy/permissions";
import type { TenantContext } from "@/server/tenancy/types";
import { audit } from "@/server/audit/audit";
import type {
  companyInfoSchema,
  competitorSchema,
  exclusionsSchema,
  productionInfoSchema,
  salesInfoSchema,
  targetMarketSchema,
} from "@/lib/validation";

export const ONBOARDING_STEPS = [
  { key: "website", title: "Web sitesi" },
  { key: "company", title: "Firma bilgileri" },
  { key: "products", title: "Ürün ve üretim" },
  { key: "target", title: "Hedef müşteri" },
  { key: "sales", title: "Satış bilgileri" },
  { key: "competitors", title: "Rakipler" },
  { key: "exclusions", title: "İstenmeyen müşteriler" },
  { key: "summary", title: "Özet" },
] as const;

export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number]["key"];

export async function getCompanyOverview(ctx: TenantContext) {
  const db = tenantDb(ctx);
  const [company, pendingFacts, verifiedFacts, products, documents, targetMarkets, competitors, memories] = await Promise.all([
    db.company.findUniqueOrThrow({ where: { id: ctx.companyId }, include: { profile: true, subscription: true } }),
    db.companyFact.count({ where: { status: "PENDING" } }),
    db.companyFact.count({ where: { status: "VERIFIED" } }),
    db.product.count({ where: { status: "VERIFIED", active: true } }),
    db.knowledgeDocument.count({ where: { status: "READY" } }),
    db.targetMarket.findMany({ orderBy: [{ isExcluded: "asc" }, { priority: "desc" }, { createdAt: "asc" }] }),
    db.competitor.findMany({ orderBy: { createdAt: "asc" } }),
    db.companyMemory.count({ where: { status: "ACTIVE" } }),
  ]);
  return { company, pendingFacts, verifiedFacts, products, documents, targetMarkets, competitors, memories };
}

/** Profil tamamlanma oranı — dashboard'daki "şirketini tanıt" kartı için. */
export function profileCompleteness(o: Awaited<ReturnType<typeof getCompanyOverview>>) {
  const p = o.company.profile;
  const checks = [
    { label: "Web sitesi", done: Boolean(o.company.website) },
    { label: "Sektör", done: Boolean(p?.sector) },
    { label: "Firma özeti onaylandı", done: p?.aiSummaryStatus === "VERIFIED" },
    { label: "En az bir onaylı ürün", done: o.products > 0 },
    { label: "Hedef pazar", done: o.targetMarkets.some((t) => !t.isExcluded) },
    { label: "Satış bilgileri", done: Boolean(p?.avgSaleValue || p?.salesCycleDays) },
    { label: "Katalog / doküman", done: o.documents > 0 },
  ];
  return { checks, percent: Math.round((checks.filter((c) => c.done).length / checks.length) * 100) };
}

async function bumpOnboarding(ctx: TenantContext, step: number) {
  const db = tenantDb(ctx);
  const company = await db.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { onboardingStep: true } });
  if (step > company.onboardingStep) {
    await db.company.update({ where: { id: ctx.companyId }, data: { onboardingStep: step } });
  }
}

export async function saveCompanyInfo(ctx: TenantContext, input: z.infer<typeof companyInfoSchema>) {
  assertCan(ctx, "company.update");
  const db = tenantDb(ctx);
  await db.company.update({
    where: { id: ctx.companyId },
    data: { name: input.name, website: input.website ?? null, country: input.country ?? null, city: input.city ?? null },
  });
  await db.companyProfile.upsert({
    where: { companyId: ctx.companyId },
    create: {
      companyId: ctx.companyId,
      sector: input.sector ?? null,
      subSector: input.subSector ?? null,
      serviceRegions: input.serviceRegions,
      sizeBand: input.sizeBand ?? null,
      employeeCount: input.employeeCount ?? null,
      description: input.description ?? null,
    },
    update: {
      sector: input.sector ?? null,
      subSector: input.subSector ?? null,
      serviceRegions: input.serviceRegions,
      sizeBand: input.sizeBand ?? null,
      employeeCount: input.employeeCount ?? null,
      description: input.description ?? null,
    },
  });
  await bumpOnboarding(ctx, 2);
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "company.profile.updated", metadata: { section: "company" } });
}

export async function saveProductionInfo(ctx: TenantContext, input: z.infer<typeof productionInfoSchema>) {
  assertCan(ctx, "company.update");
  const db = tenantDb(ctx);
  await db.companyProfile.upsert({
    where: { companyId: ctx.companyId },
    create: { companyId: ctx.companyId },
    update: {
      minOrder: input.minOrder ?? null,
      priceRangeNote: input.priceRangeNote ?? null,
      avgOrderValue: input.avgOrderValue ?? null,
      productionCapacity: input.productionCapacity ?? null,
      deliveryTime: input.deliveryTime ?? null,
      customManufacturing: input.customManufacturing ?? null,
    },
  });

  // Kullanıcının kendi girdiği sertifikalar doğrudan onaylı bilgi sayılır
  const existing = await db.companyFact.findMany({ where: { key: "certification", source: "USER" }, select: { value: true } });
  const have = new Set(existing.map((f) => f.value.toLocaleLowerCase("tr-TR")));
  const newCerts = input.certifications.filter((c) => !have.has(c.toLocaleLowerCase("tr-TR")));
  if (newCerts.length) {
    await db.companyFact.createMany({
      data: newCerts.map((value) => ({
        companyId: ctx.companyId,
        key: "certification",
        value,
        source: "USER" as const,
        status: "VERIFIED" as const,
        reviewedById: ctx.userId,
        reviewedAt: new Date(),
      })),
    });
  }

  // Hızlı ürün ekleme: yalnızca adı olan, kullanıcı tarafından girilmiş (onaylı) ürünler
  if (input.productNames.length) {
    const current = await db.product.findMany({ select: { name: true } });
    const names = new Set(current.map((p) => p.name.toLocaleLowerCase("tr-TR")));
    const toCreate = input.productNames.filter((n) => !names.has(n.toLocaleLowerCase("tr-TR")));
    if (toCreate.length) {
      await db.product.createMany({
        data: toCreate.map((name) => ({ companyId: ctx.companyId, name, status: "VERIFIED" as const, source: "USER" as const })),
      });
    }
  }
  await bumpOnboarding(ctx, 3);
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "company.profile.updated", metadata: { section: "production" } });
}

export async function savePrimaryTargetMarket(ctx: TenantContext, input: z.infer<typeof targetMarketSchema>) {
  assertCan(ctx, "company.update");
  const db = tenantDb(ctx);
  const data = {
    name: input.name,
    businessModel: input.businessModel ?? null,
    industries: input.industries,
    subIndustries: input.subIndustries,
    countries: input.countries,
    cities: input.cities,
    minEmployees: input.minEmployees ?? null,
    maxEmployees: input.maxEmployees ?? null,
    minRevenue: input.minRevenue ?? null,
    customerTypes: input.customerTypes,
    decisionMakerRoles: input.decisionMakerRoles,
    notes: input.notes ?? null,
  };
  const primary = await db.targetMarket.findFirst({ where: { isExcluded: false }, orderBy: [{ priority: "desc" }, { createdAt: "asc" }] });
  if (primary) await db.targetMarket.update({ where: { id: primary.id }, data });
  else await db.targetMarket.create({ data: { ...data, companyId: ctx.companyId, priority: 10 } });
  await bumpOnboarding(ctx, 4);
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "company.target_market.saved" });
}

export async function saveSalesInfo(ctx: TenantContext, input: z.infer<typeof salesInfoSchema>) {
  assertCan(ctx, "company.update");
  await tenantDb(ctx).companyProfile.upsert({
    where: { companyId: ctx.companyId },
    create: { companyId: ctx.companyId },
    update: {
      currency: input.currency,
      avgSaleValue: input.avgSaleValue ?? null,
      salesCycleDays: input.salesCycleDays ?? null,
      monthlySalesTarget: input.monthlySalesTarget ?? null,
      existingCustomerTypes: input.existingCustomerTypes,
      existingCustomerExamples: input.existingCustomerExamples,
    },
  });
  await bumpOnboarding(ctx, 5);
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "company.profile.updated", metadata: { section: "sales" } });
}

export async function addCompetitor(ctx: TenantContext, input: z.infer<typeof competitorSchema>) {
  assertCan(ctx, "company.update");
  const c = await tenantDb(ctx).competitor.create({
    data: {
      companyId: ctx.companyId,
      name: input.name,
      website: input.website ?? null,
      strengths: input.strengths,
      weaknesses: input.weaknesses,
      notes: input.notes ?? null,
    },
  });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "competitor.created", entityType: "Competitor", entityId: c.id });
  return c;
}

export async function deleteCompetitor(ctx: TenantContext, id: string) {
  assertCan(ctx, "company.update");
  await tenantDb(ctx).competitor.deleteMany({ where: { id } });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "competitor.deleted", entityType: "Competitor", entityId: id });
}

export async function completeCompetitorsStep(ctx: TenantContext) {
  await bumpOnboarding(ctx, 6);
}

export async function saveExclusions(ctx: TenantContext, input: z.infer<typeof exclusionsSchema>) {
  assertCan(ctx, "company.update");
  const db = tenantDb(ctx);
  const data = {
    name: "İstenmeyen müşteriler",
    isExcluded: true,
    industries: input.industries,
    cities: input.cities,
    customerTypes: input.customerTypes,
    notes: input.notes ?? null,
  };
  const existing = await db.targetMarket.findFirst({ where: { isExcluded: true } });
  if (existing) await db.targetMarket.update({ where: { id: existing.id }, data });
  else await db.targetMarket.create({ data: { ...data, companyId: ctx.companyId } });

  // Serbest metin kurallar şirket hafızasına kural olarak yazılır
  if (input.rules.length) {
    const current = await db.companyMemory.findMany({ where: { type: "RULE" }, select: { content: true } });
    const have = new Set(current.map((m) => m.content.toLocaleLowerCase("tr-TR")));
    const fresh = input.rules.filter((r) => !have.has(r.toLocaleLowerCase("tr-TR")));
    if (fresh.length) {
      await db.companyMemory.createMany({
        data: fresh.map((content) => ({ companyId: ctx.companyId, type: "RULE" as const, content, createdById: ctx.userId })),
      });
    }
  }
  await bumpOnboarding(ctx, 7);
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "company.exclusions.saved" });
}

export async function completeOnboarding(ctx: TenantContext) {
  assertCan(ctx, "company.update");
  await tenantDb(ctx).company.update({
    where: { id: ctx.companyId },
    data: { onboardingStep: ONBOARDING_STEPS.length, onboardingCompletedAt: new Date() },
  });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "company.onboarding.completed" });
}

export async function skipWebsiteStep(ctx: TenantContext) {
  await bumpOnboarding(ctx, 1);
}

export function decimalToNumber(d: Prisma.Decimal | null | undefined): number | null {
  return d == null ? null : Number(d);
}
