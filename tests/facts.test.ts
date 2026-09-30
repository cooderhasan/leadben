import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { rawDb } from "@/server/db";
import { addUserFact, buildVerifiedCompanyContext, rejectFacts } from "@/server/services/facts";
import { createTenant, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await rawDb.$disconnect();
});

describe("şirket bilgisi ekleme / kaldırma", () => {
  it("elle eklenen bilgi onaylı olarak satış bağlamına girer; tekrarı eklenmez; kaldırılan çıkar", async () => {
    const a = await createTenant("A");
    const f = await addUserFact(a, "industry_served", "Raylı sistemler");
    expect(f).toMatchObject({ status: "VERIFIED", source: "USER" });
    await expect(addUserFact(a, "industry_served", "  raylı SİSTEMLER ")).rejects.toThrow(/zaten kayıtlı/);

    const ctx1 = await buildVerifiedCompanyContext(a);
    expect(JSON.stringify(ctx1)).toContain("Raylı sistemler");

    await rejectFacts(a, [f.id]);
    const ctx2 = await buildVerifiedCompanyContext(a);
    expect(JSON.stringify(ctx2)).not.toContain("Raylı sistemler");
  });

  it("başka şirketin bilgisini kaldıramaz; izleyici ekleyemez", async () => {
    const a = await createTenant("A");
    const b = await createTenant("B");
    const f = await addUserFact(a, "industry_served", "Havacılık");
    expect(await rejectFacts(b, [f.id])).toBe(0);
    expect((await rawDb.companyFact.findUniqueOrThrow({ where: { id: f.id } })).status).toBe("VERIFIED");
    const viewer = await createTenant("V", "VIEWER");
    await expect(addUserFact(viewer, "industry_served", "Denizcilik")).rejects.toThrow();
  });
});
