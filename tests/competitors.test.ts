import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { rawDb } from "@/server/db";
import { __setAIProviderForTests } from "@/server/ai";
import { drainInlineJobs } from "@/server/jobs/queue";
import { runSchedulerTick } from "@/server/jobs/scheduler";
import { addedText, sentences, setCompetitorMonitoring, startCompetitorScan } from "@/server/services/competitors";
import { MockAIProvider, createTenant, resetDb, startSite } from "./helpers";

describe("rakip metin farkı (birim)", () => {
  it("yalnızca yeni eklenen cümleleri döndürür; aynı sayfa aynıysa hiçbir şey döndürmez", () => {
    const a = { url: "u1", title: "", hash: "h1", text: "Yaylar üretiyoruz. ISO 9001 belgeliyiz." };
    const b = { url: "u1", title: "", hash: "h2", text: "Yaylar üretiyoruz. ISO 9001 belgeliyiz. Gebze'de yeni tesisimizi açtık." };
    expect(sentences(b.text)).toHaveLength(3);
    expect(addedText([a], [b])).toEqual([{ url: "u1", added: "Gebze'de yeni tesisimizi açtık." }]);
    expect(addedText([a], [{ ...a }])).toEqual([]);
  });
});

beforeEach(resetDb);
afterEach(() => __setAIProviderForTests(null));
afterAll(async () => {
  await rawDb.$disconnect();
});

const page = (body: string) => `<html><head><title>Rakip Yay</title></head><body><h1>Rakip Yay</h1><p>${body}</p></body></html>`;
const BASE = "Rakip Yay 1990'dan beri basma ve çekme yay üretmektedir. Firmamız ISO 9001 kalite belgesine sahiptir. Otomotiv ve beyaz eşya sektörlerine hizmet veriyoruz.";

describe("rakip taraması", () => {
  it("ilk tarama profil çıkarır; değişmeyen site AI çağırmaz ve kredi iade edilir; yeni içerikten kanıtlı sinyal çıkar", async () => {
    const a = await createTenant("Aktif Yay");
    const pages: Record<string, string> = { "/robots.txt": "User-agent: *\nAllow: /", "/": page(BASE) };
    const { url, server } = await startSite(pages);
    try {
      const comp = await rawDb.competitor.create({ data: { companyId: a.companyId, name: "Rakip Yay", website: url } });
      const ai = new MockAIProvider((input) => {
        const sys = input.system ?? "";
        if (sys.includes("EKLENEN metin")) {
          return JSON.stringify({
            signals: [
              { type: "NEW_FACILITY", title: "Gebze'de yeni tesis", description: "Kapasite artıyor", evidence: "Gebze'de 5000 m2 yeni üretim tesisimizi açtık" },
              // Eski içerikten "yeni" diye sunulan uydurma sinyal — atılmalı
              { type: "OTHER", title: "ISO belgesi aldı", description: null, evidence: "Firmamız ISO 9001 kalite belgesine sahiptir" },
            ],
          });
        }
        return JSON.stringify({
          summary: "Basma ve çekme yay üreticisi.",
          products: ["Basma yay", "Çekme yay"],
          claims: [
            { statement: "ISO 9001 belgeli", evidence: "Firmamız ISO 9001 kalite belgesine sahiptir" },
            { statement: "IATF belgeli", evidence: "IATF 16949 belgemiz vardır" },
          ],
        });
      });
      __setAIProviderForTests(ai);
      const credits = async () => (await rawDb.company.findUniqueOrThrow({ where: { id: a.companyId } })).creditBalance;
      const start = await credits();

      // 1) İlk tarama: profil, kanıtsız iddia (IATF) atılır, 2 kredi
      await startCompetitorScan(a, comp.id);
      await drainInlineJobs();
      const first = await rawDb.websiteAnalysis.findFirstOrThrow({ where: { targetId: comp.id } });
      expect(first.summary).toBe("Basma ve çekme yay üreticisi.");
      expect((first.result as { claims: Array<{ statement: string }> }).claims.map((c) => c.statement)).toEqual(["ISO 9001 belgeli"]);
      expect(await credits()).toBe(start - 2);

      // 2) Değişiklik yok: AI çağrılmaz, kredi iade
      const callsBefore = ai.calls.length;
      await startCompetitorScan(a, comp.id);
      await drainInlineJobs();
      expect(ai.calls.length).toBe(callsBefore);
      expect(await credits()).toBe(start - 2);

      // 3) Yeni cümle: yalnızca yeni metinden kanıtlanan sinyal kaydedilir
      pages["/"] = page(`${BASE} Gebze'de 5000 m2 yeni üretim tesisimizi açtık.`);
      await startCompetitorScan(a, comp.id);
      await drainInlineJobs();
      const signals = await rawDb.competitorSignal.findMany({ where: { competitorId: comp.id } });
      expect(signals.map((s) => s.title)).toEqual(["Gebze'de yeni tesis"]);
      expect(signals[0]!.type).toBe("NEW_FACILITY");
      // Değişikliği değerlendiren AI'a eski cümleler gönderilmedi
      const changesPrompt = ai.calls.at(-1)!.messages[0]!.content as string;
      expect(changesPrompt).toContain("Gebze");
      expect(changesPrompt).not.toContain("1990'dan beri");
      expect(await credits()).toBe(start - 4);
    } finally {
      server.close();
    }
  });

  it("izlenen rakip haftada bir kuyruğa girer; izleme kapalıysa girmez; başka şirket izlemeyi değiştiremez", async () => {
    const a = await createTenant("A");
    const b = await createTenant("B");
    const comp = await rawDb.competitor.create({ data: { companyId: a.companyId, name: "R", website: "https://rakip.example" } });
    expect((await runSchedulerTick()).competitorScans).toBe(0);
    await expect(setCompetitorMonitoring(b, comp.id, true)).rejects.toThrow(/bulunamadı/);
    await setCompetitorMonitoring(a, comp.id, true);
    // Ağ çağrısı yapılmasın: kuyruğa alındığını doğrulayıp işi çalıştırmadan iptal et
    const res = await runSchedulerTick();
    expect(res.competitorScans).toBe(1);
    await rawDb.job.updateMany({ where: { type: "competitor.scan" }, data: { status: "CANCELLED" } });
    await drainInlineJobs();
    expect((await runSchedulerTick()).competitorScans).toBe(0);
  });
});
