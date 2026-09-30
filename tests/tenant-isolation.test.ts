import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { rawDb } from "@/server/db";
import { tenantDb, TENANT_MODELS } from "@/server/tenancy/tenant-db";
import { createTenant, resetDb } from "./helpers";

describe("tenant modelleri listesi", () => {
  it("companyId alanı olan her model TENANT_MODELS içinde", () => {
    const withCompanyId = Prisma.dmmf.datamodel.models
      .filter((m) => m.name !== "Company" && m.fields.some((f) => f.name === "companyId"))
      .map((m) => m.name);
    const missing = withCompanyId.filter((n) => !TENANT_MODELS.has(n as Prisma.ModelName));
    expect(missing).toEqual([]);
  });
});

describe("tenant izolasyonu", () => {
  beforeEach(resetDb);
  afterAll(() => rawDb.$disconnect());

  it("A şirketi B'nin ürünlerini okuyamaz, güncelleyemez, silemez", async () => {
    const a = await createTenant("Firma A");
    const b = await createTenant("Firma B");
    const bProduct = await tenantDb(b).product.create({ data: { companyId: b.companyId, name: "B Gizli Ürün" } });
    await tenantDb(a).product.create({ data: { companyId: a.companyId, name: "A Ürünü" } });

    const dbA = tenantDb(a);
    expect((await dbA.product.findMany()).map((p) => p.name)).toEqual(["A Ürünü"]);
    expect(await dbA.product.findUnique({ where: { id: bProduct.id } })).toBeNull();
    expect(await dbA.product.findFirst({ where: { name: "B Gizli Ürün" } })).toBeNull();
    expect(await dbA.product.count()).toBe(1);

    const upd = await dbA.product.updateMany({ where: { id: bProduct.id }, data: { name: "hacked" } });
    expect(upd.count).toBe(0);
    await expect(dbA.product.update({ where: { id: bProduct.id }, data: { name: "hacked" } })).rejects.toThrow();
    const del = await dbA.product.deleteMany({ where: { id: bProduct.id } });
    expect(del.count).toBe(0);
    await expect(dbA.product.delete({ where: { id: bProduct.id } })).rejects.toThrow();

    const still = await rawDb.product.findUniqueOrThrow({ where: { id: bProduct.id } });
    expect(still.name).toBe("B Gizli Ürün");
  });

  it("başka şirkete kayıt oluşturulamaz ve companyId değiştirilemez", async () => {
    const a = await createTenant("Firma A");
    const b = await createTenant("Firma B");
    const dbA = tenantDb(a);
    await expect(dbA.product.create({ data: { companyId: b.companyId, name: "x" } })).rejects.toThrow(/başka bir şirkete/);
    await expect(
      dbA.product.createMany({ data: [{ companyId: a.companyId, name: "ok" }, { companyId: b.companyId, name: "x" }] }),
    ).rejects.toThrow();
    const p = await dbA.product.create({ data: { companyId: a.companyId, name: "p" } });
    await expect(dbA.product.update({ where: { id: p.id }, data: { companyId: b.companyId } })).rejects.toThrow(/companyId/);
    expect(await rawDb.product.count({ where: { companyId: b.companyId } })).toBe(0);
  });

  it("Company modeli yalnızca kendi kaydını görür ve günceller", async () => {
    const a = await createTenant("Firma A");
    const b = await createTenant("Firma B");
    const dbA = tenantDb(a);
    const found = await dbA.company.findUnique({ where: { id: b.companyId } });
    expect(found?.id).toBe(a.companyId); // where.id zorla kendi ID'sine çevrilir
    await dbA.company.update({ where: { id: b.companyId }, data: { name: "Değişti" } });
    expect((await rawDb.company.findUniqueOrThrow({ where: { id: b.companyId } })).name).toBe("Firma B");
    expect((await rawDb.company.findUniqueOrThrow({ where: { id: a.companyId } })).name).toBe("Değişti");
    await expect(dbA.company.update({ where: { id: a.companyId }, data: { creditBalance: 999999 } })).rejects.toThrow(/creditBalance/);
  });

  it("kimlik tablolarına tenant bağlamında erişilemez", async () => {
    const a = await createTenant("Firma A");
    await expect(tenantDb(a).user.findMany()).rejects.toThrow(/erişilemez/);
    await expect(tenantDb(a).session.findMany()).rejects.toThrow(/erişilemez/);
  });

  it("upsert başka şirketin kaydını güncelleyemez", async () => {
    const a = await createTenant("Firma A");
    const b = await createTenant("Firma B");
    await tenantDb(b).productCategory.create({ data: { companyId: b.companyId, name: "Ortak" } });
    const cat = await tenantDb(a).productCategory.upsert({
      where: { companyId_name: { companyId: a.companyId, name: "Ortak" } },
      create: { companyId: a.companyId, name: "Ortak" },
      update: {},
    });
    expect(cat.companyId).toBe(a.companyId);
    expect(await rawDb.productCategory.count({ where: { name: "Ortak" } })).toBe(2);
  });
});
