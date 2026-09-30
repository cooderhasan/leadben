import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { rawDb } from "@/server/db";
import { __setLeadSourceProviderForTests, __setWebSearchProviderForTests, type WebSearchProvider } from "@/server/providers/lead-source";
import { drainInlineJobs } from "@/server/jobs/queue";
import { saveDiscoveredLeads } from "@/server/services/leads";
import { getLastWebsiteDiscovery, pickWebsite, startWebsiteDiscovery, websiteQuery } from "@/server/services/lead-intelligence";
import { createTenant, resetDb } from "./helpers";

beforeEach(resetDb);
afterEach(() => {
  __setWebSearchProviderForTests(null);
  __setLeadSourceProviderForTests(null);
});
afterAll(async () => {
  await rawDb.$disconnect();
});

const balance = async (companyId: string) => (await rawDb.company.findUniqueOrThrow({ where: { id: companyId } })).creditBalance;

/** Sorguya göre sonuç döndüren sahte arama sağlayıcısı */
function fakeWeb(results: Record<string, Array<{ title: string; url: string }>>): WebSearchProvider & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async startRawSearch(q) {
      queries.push(...q);
      return "run-1";
    },
    async fetchRawResults() {
      return new Map(Object.entries(results));
    },
  };
}

describe("firma adından site bulma", () => {
  it("ünvan eklerini atıp arama sorgusu üretir", () => {
    expect(websiteQuery("AKPLAS PLASTIK KALIP SAN. VE TIC. A.S.", "Dilovası")).toBe("AKPLAS PLASTIK KALIP Dilovası resmi web sitesi");
    expect(websiteQuery("Ali KÖSE", null)).toBe("Ali KÖSE resmi web sitesi");
  });

  it("alan adı veya başlık firma adıyla örtüşen sonucu seçer; dizin ve alakasız sonuçları eler", () => {
    const results = [
      { title: "Akplas Plastik - Firma Rehberi", url: "https://www.firmasec.com/akplas" },
      { title: "Plastik kalıp nedir?", url: "https://blog.ornek.com/plastik-kalip" },
      { title: "Akplas Plastik Kalıp San. ve Tic. A.Ş.", url: "https://www.akplas.com.tr/tr" },
    ];
    expect(pickWebsite("AKPLAS PLASTIK KALIP SAN. VE TIC. A.S.", results).website).toBe("https://www.akplas.com.tr/");
    // Eşleşme yoksa bağlanmaz (yanlış firma riski)
    const none = pickWebsite("ZZZ Metal Sanayi", [{ title: "Başka bir firma", url: "https://baskafirma.com" }]);
    expect(none.website).toBeNull();
    expect(none.reason).toMatch(/eşleşen site bulunamadı/);
    expect(pickWebsite("X Firma", []).reason).toMatch(/Arama sonucu dönmedi/);
  });

  it("uçtan uca: bulunan site kaydedilir, bulunamayanın kredisi iade edilir", async () => {
    const a = await createTenant("A");
    const { leadIds } = await saveDiscoveredLeads(
      a.companyId,
      [
        { companyName: "AKPLAS PLASTIK KALIP SAN. VE TIC. A.S.", sourceType: "DIRECTORY" },
        { companyName: "Bulunamaz Metal Ltd. Şti.", sourceType: "DIRECTORY" },
      ],
      { provider: "directory" },
    );
    const [akplas, yok] = leadIds;
    __setWebSearchProviderForTests(
      fakeWeb({
        "AKPLAS PLASTIK KALIP resmi web sitesi": [{ title: "Akplas Plastik Kalıp A.Ş.", url: "https://www.akplas.com.tr/" }],
        "Bulunamaz Metal resmi web sitesi": [{ title: "Alakasız site", url: "https://baska-site.com/" }],
      }),
    );

    const before = await balance(a.companyId);
    const res = await startWebsiteDiscovery(a, leadIds);
    expect(res).toMatchObject({ count: 2, cost: 2 });
    await drainInlineJobs();

    expect((await rawDb.lead.findUniqueOrThrow({ where: { id: akplas } })).website).toBe("https://www.akplas.com.tr/");
    expect((await rawDb.lead.findUniqueOrThrow({ where: { id: akplas } })).domain).toBe("akplas.com.tr");
    expect((await rawDb.lead.findUniqueOrThrow({ where: { id: yok } })).website).toBeNull();
    // 1 bulundu → 1 kredi, diğeri iade
    expect(await balance(a.companyId)).toBe(before - 1);
    expect(await getLastWebsiteDiscovery(a)).toMatchObject({ status: "SUCCEEDED", total: 2, found: 1, notFound: 1 });
  });

  it("sitesi olanlar atlanır; izleyici başlatamaz", async () => {
    const a = await createTenant("A");
    const { leadIds } = await saveDiscoveredLeads(a.companyId, [{ companyName: "Siteli", website: "siteli.com", sourceType: "MANUAL" }], { provider: "manual" });
    __setWebSearchProviderForTests(fakeWeb({}));
    await expect(startWebsiteDiscovery(a, leadIds)).rejects.toThrow(/web sitesi zaten var/);
    const viewer = await createTenant("V", "VIEWER");
    await expect(startWebsiteDiscovery(viewer, leadIds)).rejects.toThrow();
  });
});
