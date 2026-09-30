import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { rawDb } from "@/server/db";
import { __setAIProviderForTests } from "@/server/ai";
import { drainInlineJobs } from "@/server/jobs/queue";
import { bulkDeleteLeads, bulkUpdateLeadStatus, listLeads, resolveLeadSelection, saveDiscoveredLeads } from "@/server/services/leads";
import { getLastPreparation, planPreparation, startPreparation } from "@/server/services/lead-intelligence";
import { addLeadsToCampaign } from "@/server/services/campaigns";
import type { RawLead } from "@/server/providers/lead-source/types";
import type { TenantContext } from "@/server/tenancy/types";
import { MockAIProvider, createTenant, resetDb, startSite } from "./helpers";

beforeEach(resetDb);
afterEach(() => __setAIProviderForTests(null));
afterAll(async () => {
  await rawDb.$disconnect();
});

const balance = async (companyId: string) => (await rawDb.company.findUniqueOrThrow({ where: { id: companyId } })).creditBalance;

async function seed(ctx: TenantContext, items: Array<Partial<RawLead> & { companyName: string }>, provider: string) {
  const { leadIds } = await saveDiscoveredLeads(ctx.companyId, items.map((i) => ({ sourceType: "MANUAL" as const, ...i })), { provider });
  return leadIds;
}

describe("filtreler ve seçim", () => {
  it("kaynak ve e-posta filtresi; 'filtreye uyan tümü' sunucuda yeniden uygulanır; başka şirket karışmaz", async () => {
    const a = await createTenant("A");
    const b = await createTenant("B");
    await seed(a, [{ companyName: "Harita 1", genericEmail: "info@h1.com" }, { companyName: "Harita 2" }], "apify");
    await seed(a, [{ companyName: "OSB 1" }, { companyName: "OSB 2", genericEmail: "info@osb2.com" }], "directory");
    const [bLead] = await seed(b, [{ companyName: "B Firma" }], "directory");

    expect((await listLeads(a, { source: "directory" })).total).toBe(2);
    expect((await listLeads(a, { email: "no" })).rows.map((r) => r.companyName).sort()).toEqual(["Harita 2", "OSB 1"]);
    expect((await listLeads(a, { source: "maps", email: "yes" })).rows.map((r) => r.companyName)).toEqual(["Harita 1"]);

    expect(await resolveLeadSelection(a, { filter: { source: "directory" } })).toHaveLength(2);
    // İstemciden gelen başka şirketin id'si seçime girmez
    expect(await resolveLeadSelection(a, { ids: [bLead!] })).toEqual([]);
  });

  it("toplu durum ve silme yalnızca kendi lead'lerini etkiler; izleyici yapamaz", async () => {
    const a = await createTenant("A");
    const b = await createTenant("B");
    const ids = await seed(a, [{ companyName: "X" }, { companyName: "Y" }], "manual");
    const [bLead] = await seed(b, [{ companyName: "Z" }], "manual");
    expect(await bulkUpdateLeadStatus(a, [...ids, bLead!], "NURTURE")).toBe(2);
    expect((await rawDb.lead.findUniqueOrThrow({ where: { id: bLead } })).status).toBe("NEW");
    expect(await bulkDeleteLeads(a, [ids[0]!, bLead!])).toBe(1);
    expect(await rawDb.lead.count({ where: { id: bLead } })).toBe(1);
    const viewer = await createTenant("V", "VIEWER");
    await expect(bulkDeleteLeads(viewer, ids)).rejects.toThrow();
  });
});

describe("kampanyaya ekleme", () => {
  it("seçilen lead'ler eklenir; zaten ekli / engelli olan atlanır; e-postasız gönderilemez işaretlenir", async () => {
    const a = await createTenant("A");
    const [withEmail, noEmail, blocked] = await seed(a, [{ companyName: "E", genericEmail: "info@e-firma.com" }, { companyName: "N" }, { companyName: "S" }], "manual");
    await rawDb.lead.update({ where: { id: blocked }, data: { suppressed: true, status: "SUPPRESSED" } });
    const campaign = await rawDb.campaign.create({ data: { companyId: a.companyId, name: "K", targetDescription: "t", status: "DRAFT" } });

    const r = await addLeadsToCampaign(a, campaign.id, [withEmail!, noEmail!, blocked!]);
    expect(r).toMatchObject({ added: 2, skipped: 1, noEmail: 1 });
    const rows = await rawDb.campaignLead.findMany({ where: { campaignId: campaign.id } });
    expect(rows.find((x) => x.leadId === withEmail)?.complianceStatus).toBe("SENDABLE");
    expect(rows.find((x) => x.leadId === noEmail)?.complianceStatus).toBe("DO_NOT_SEND");

    expect((await addLeadsToCampaign(a, campaign.id, [withEmail!])).added).toBe(0);
    await rawDb.campaign.update({ where: { id: campaign.id }, data: { status: "ARCHIVED" } });
    await expect(addLeadsToCampaign(a, campaign.id, [noEmail!])).rejects.toThrow(/eklenemez/);
  });
});

describe("Hazırla", () => {
  const researchJson = JSON.stringify({
    summary: "Otobüs kapı kilitleri üreten firma.",
    industry: "Otomotiv",
    subIndustry: null,
    products: ["Acil çıkış kapı kilitleri"],
    employeeCountMin: null,
    employeeCountMax: null,
    verified: [{ statement: "Kapı kilidi üretir", evidence: "acil çıkış kapı kilitleri" }],
    assumptions: [],
    signals: [],
    genericEmail: null,
    phone: null,
    socialProfiles: {},
  });
  const scoreJson = JSON.stringify({
    productFit: 25,
    industryFit: 18,
    sizeFit: 8,
    buyingSignal: 0,
    matchedProducts: [],
    explanation: "Kapı kilitlerinde yay kullanılır.",
    verifiedFacts: ["Kapı kilidi üretir"],
    assumptions: [],
    excludedReason: null,
  });

  it("plan ve kredi tahmini: sitesi olan analiz (2), olmayan yalnızca puan (1); e-postası olana e-posta araması yok", async () => {
    const a = await createTenant("A");
    const [site, noSite, siteWithEmail] = await seed(
      a,
      [{ companyName: "S", website: "s-firma.com" }, { companyName: "N" }, { companyName: "E", website: "e-firma.com", genericEmail: "info@e-firma.com" }],
      "manual",
    );
    const p = await planPreparation(a, [site!, noSite!, siteWithEmail!], { email: true, research: true, score: true });
    expect(p).toMatchObject({ research: 2, scoreOnly: 1, emailOnly: 0, credits: 5 });
    const emailOnly = await planPreparation(a, [site!, noSite!, siteWithEmail!], { email: true, research: false, score: false });
    expect(emailOnly).toMatchObject({ research: 0, scoreOnly: 0, emailOnly: 1, credits: 0 });
  });

  it("uçtan uca: sırayla analiz + puan; site açılmazsa yalnızca puan ve fark iade; özet", async () => {
    const a = await createTenant("A");
    const site = await startSite({
      "/robots.txt": "User-agent: *\nAllow: /",
      "/": `<html><body><h1>Kilit A.Ş.</h1><p>Otobüsler için acil çıkış kapı kilitleri ve merdiven basamakları üretiyoruz. Alüminyum ve paslanmaz çelikten kaynaklı, bükümlü ve CNC işlenmiş parçaları tasarlayıp üretiyor, otomotiv sanayisine yarı ve tam mamul olarak teslim ediyoruz. Bize info@127.0.0.1 adresinden yazın.</p></body></html>`,
    });
    try {
      const [ok, dead, noSite] = await seed(
        a,
        [{ companyName: "Kilit A.Ş.", website: site.url }, { companyName: "Kapalı Site", website: "http://kapali-site.invalid" }, { companyName: "Sitesiz" }],
        "manual",
      );
      __setAIProviderForTests(new MockAIProvider((input) => (input.system?.includes("puanla") ? scoreJson : researchJson)));
      const before = await balance(a.companyId);
      const res = await startPreparation(a, [ok!, dead!, noSite!], { email: true, research: true, score: true });
      expect(res.credits).toBe(5);
      expect(await balance(a.companyId)).toBe(before - 5);
      await drainInlineJobs();

      const last = await getLastPreparation(a);
      expect(last).toMatchObject({ status: "SUCCEEDED", total: 3, researched: 1, scored: 3, failed: 0, refunded: 1 });
      // Kapalı sitenin analiz ücreti (2) yerine yalnızca puan (1) alındı → 1 iade
      expect(await balance(a.companyId)).toBe(before - 4);
      expect((await rawDb.lead.findUniqueOrThrow({ where: { id: ok } })).aiSummary).toMatch(/kapı kilitleri/);
      expect(await rawDb.lead.count({ where: { id: { in: [ok!, dead!, noSite!] }, fitScore: { not: null } } })).toBe(3);

      // Aynı anda ikinci hazırlık yok; izleyici başlatamaz
      const viewer = await createTenant("V", "VIEWER");
      await expect(startPreparation(viewer, [ok!], { email: true, research: true, score: true })).rejects.toThrow();
    } finally {
      site.server.close();
    }
  });
});
