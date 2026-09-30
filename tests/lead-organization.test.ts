import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { rawDb } from "@/server/db";
import {
  addLeadsToList,
  bulkAssignOwner,
  createLeadList,
  ensureJobList,
  listLeadLists,
  listLeads,
  removeLeadsFromList,
  saveDiscoveredLeads,
} from "@/server/services/leads";
import { addLeadsToCampaign } from "@/server/services/campaigns";
import type { TenantContext } from "@/server/tenancy/types";
import { createTenant, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await rawDb.$disconnect();
});

const seed = async (ctx: TenantContext, names: string[], opts: { ownerId?: string | null; listId?: string } = {}) =>
  (await saveDiscoveredLeads(ctx.companyId, names.map((companyName) => ({ companyName, sourceType: "MANUAL" as const })), { provider: "fake", ...opts })).leadIds;

describe("firma sorumlusu", () => {
  it("arama/içe aktarma sahibi yeni firmalara atanır; mevcut firmanın sorumlusu değişmez", async () => {
    const a = await createTenant("A");
    const [lead] = await seed(a, ["Ortak Firma"], { ownerId: a.userId });
    expect((await rawDb.lead.findUniqueOrThrow({ where: { id: lead } })).ownerId).toBe(a.userId);

    // Aynı firma başka bir aramada tekrar bulunursa sorumlu korunur
    await seed(a, ["Ortak Firma"], { ownerId: "baska-kullanici" });
    expect((await rawDb.lead.findUniqueOrThrow({ where: { id: lead } })).ownerId).toBe(a.userId);
  });

  it("toplu atama yapılır; ekip dışı kişiye atanamaz; filtre sorumluya göre süzer", async () => {
    const a = await createTenant("A");
    const ids = await seed(a, ["Bir", "İki", "Üç"]);
    expect(await bulkAssignOwner(a, ids.slice(0, 2), a.userId)).toBe(2);
    await expect(bulkAssignOwner(a, ids, "yabanci-kullanici-id")).rejects.toThrow(/ekibinde değil/);

    expect((await listLeads(a, { owner: a.userId })).total).toBe(2);
    expect((await listLeads(a, { owner: "none" })).rows.map((r) => r.companyName)).toEqual(["Üç"]);
    expect(await bulkAssignOwner(a, [ids[0]!], null)).toBe(1);
    expect((await listLeads(a, { owner: "none" })).total).toBe(2);
  });
});

describe("listeler", () => {
  it("iş listesi bir kez oluşturulur; firmalar listeye girer ve listeye göre süzülür", async () => {
    const a = await createTenant("A");
    const listId = await ensureJobList(a.companyId, { jobId: "job-1", name: "Bursa otomotiv", kind: "SEARCH", createdById: a.userId });
    expect(await ensureJobList(a.companyId, { jobId: "job-1", name: "Tekrar", kind: "SEARCH" })).toBe(listId);

    const inList = await seed(a, ["Liste A", "Liste B"], { listId });
    await seed(a, ["Listesiz"]);
    expect((await listLeads(a, { listId })).rows.map((r) => r.companyName).sort()).toEqual(["Liste A", "Liste B"]);
    expect((await listLeads(a, {})).total).toBe(3);

    const lists = await listLeadLists(a);
    expect(lists[0]).toMatchObject({ name: "Bursa otomotiv", kind: "SEARCH", count: 2 });

    // Elle liste: ekleme ve çıkarma
    const manual = await createLeadList(a, "Fuar takibi");
    expect((await addLeadsToList(a, manual.id, inList)).added).toBe(2);
    expect((await addLeadsToList(a, manual.id, inList)).added).toBe(0); // tekrar eklenmez
    expect(await removeLeadsFromList(a, manual.id, [inList[0]!])).toBe(1);
    expect((await listLeads(a, { listId: manual.id })).total).toBe(1);
  });

  it("başka şirketin lead'i listeye eklenmez; izleyici liste oluşturamaz", async () => {
    const a = await createTenant("A");
    const b = await createTenant("B");
    const [bLead] = await seed(b, ["B Firma"]);
    const list = await createLeadList(a, "A listesi");
    expect((await addLeadsToList(a, list.id, [bLead!])).added).toBe(0);
    const viewer = await createTenant("V", "VIEWER");
    await expect(createLeadList(viewer, "Olmaz")).rejects.toThrow();
  });
});

describe("kampanya görünürlüğü", () => {
  it("kampanyadaki / kampanyada olmayan firmalar süzülür ve çakışma uyarılır", async () => {
    const a = await createTenant("A");
    const ids = await seed(a, ["Kampanyalı", "Serbest"]);
    const first = await rawDb.campaign.create({ data: { companyId: a.companyId, name: "K1", targetDescription: "t", status: "DRAFT" } });
    await addLeadsToCampaign(a, first.id, [ids[0]!]);

    expect((await listLeads(a, { campaign: "in" })).rows.map((r) => r.companyName)).toEqual(["Kampanyalı"]);
    expect((await listLeads(a, { campaign: "out" })).rows.map((r) => r.companyName)).toEqual(["Serbest"]);

    const second = await rawDb.campaign.create({ data: { companyId: a.companyId, name: "K2", targetDescription: "t", status: "DRAFT" } });
    expect(await addLeadsToCampaign(a, second.id, ids)).toMatchObject({ added: 2, alsoInOther: 1 });
  });
});
