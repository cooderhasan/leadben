import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { rawDb } from "@/server/db";
import { __setAIProviderForTests } from "@/server/ai";
import { saveDiscoveredLeads } from "@/server/services/leads";
import { getAnalytics } from "@/server/services/analytics";
import { askAssistant, extractNumbers, generateReport, numbersIn, unverifiedNumbers } from "@/server/services/insights";
import type { TenantContext } from "@/server/tenancy/types";
import { MockAIProvider, createTenant, resetDb } from "./helpers";

describe("sayı doğrulama", () => {
  it("TR/EN sayı biçimlerini normalize eder", () => {
    expect(extractNumbers("Yanıt oranı %12,5 ve 1.250 ileti, 3 kampanya")).toEqual(["12.5", "1250", "3"]);
  });

  it("tarih metinlerindeki sayılar veri sayılmaz (saat 09:35 iken %35 uydurma kalır)", () => {
    const allowed = numbersIn({ since: "2026-08-26T09:35:12.345Z", generatedAt: new Date("2026-08-26T09:35:12Z"), sent: 20 });
    expect(unverifiedNumbers("Sektör ortalaması %35", allowed)).toEqual(["35"]);
    expect(unverifiedNumbers("20 ileti gönderildi", allowed)).toEqual([]);
  });

  it("veride olmayan her sayıyı yakalar — küçük sayılar dahil", () => {
    const allowed = numbersIn({ sent: 40, rate: 12.5, won: 2 });
    expect(unverifiedNumbers("40 iletiden %12,5 yanıt, 2 satış", allowed)).toEqual([]);
    expect(unverifiedNumbers("5 fırsat kazandınız", allowed)).toEqual(["5"]);
    expect(unverifiedNumbers("Yanıt oranı %30", allowed)).toEqual(["30"]);
  });
});

beforeEach(resetDb);
afterEach(() => __setAIProviderForTests(null));
afterAll(async () => {
  await rawDb.$disconnect();
});

/** n gönderilmiş ileti + k yanıt (biri olumlu) içeren gerçek veri */
async function seedActivity(ctx: TenantContext, sent: number, replies: number) {
  const { leadIds } = await saveDiscoveredLeads(
    ctx.companyId,
    Array.from({ length: sent }, (_, i) => ({ companyName: `Firma ${i}`, genericEmail: `info@f${i}.com`, sourceType: "MANUAL" as const })),
    { provider: "fake" },
  );
  const campaign = await rawDb.campaign.create({ data: { companyId: ctx.companyId, name: "K1", targetDescription: "t", status: "RUNNING" } });
  for (const [i, leadId] of leadIds.entries()) {
    const conv = i < replies ? await rawDb.conversation.create({ data: { companyId: ctx.companyId, leadId, channel: "EMAIL", lastMessageAt: new Date() } }) : null;
    await rawDb.message.create({
      data: { companyId: ctx.companyId, leadId, campaignId: campaign.id, channel: "EMAIL", body: "x", status: "SENT", sentAt: new Date(), toAddress: `info@f${i}.com`, conversationId: conv?.id },
    });
    if (conv) {
      await rawDb.conversationMessage.create({
        data: { companyId: ctx.companyId, conversationId: conv.id, direction: "INBOUND", body: "y", category: i === 0 ? "INTERESTED" : "NOT_INTERESTED" },
      });
    }
  }
  return campaign;
}

describe("analitik", () => {
  it("sayılar gerçek kayıtlardan; oranlar hesaplanır; başka şirketin verisi karışmaz", async () => {
    const a = await createTenant("A");
    const b = await createTenant("B");
    await seedActivity(a, 20, 4);
    await seedActivity(b, 5, 5);
    const s = await getAnalytics(a, 30);
    expect(s.funnel).toMatchObject({ emailsSent: 20, leadsContacted: 20, replies: 4, positiveReplies: 1 });
    expect(s.rates).toMatchObject({ replyRatePct: 20, positiveReplyRatePct: 5 });
    expect(s.campaigns[0]).toMatchObject({ sent: 20, replies: 4, positive: 1, replyRatePct: 20 });
    expect(s.replyCategories).toEqual([
      { category: "NOT_INTERESTED", count: 3 },
      { category: "INTERESTED", count: 1 },
    ]);
  });
});

describe("AI rapor", () => {
  it("yeterli veri yoksa rapor üretmez ve kredi düşmez", async () => {
    const a = await createTenant("A");
    await seedActivity(a, 3, 1);
    __setAIProviderForTests(new MockAIProvider(() => "{}"));
    const before = (await rawDb.company.findUniqueOrThrow({ where: { id: a.companyId } })).creditBalance;
    await expect(generateReport(a, 30)).rejects.toThrow(/yeterli veri yok/);
    expect((await rawDb.company.findUniqueOrThrow({ where: { id: a.companyId } })).creditBalance).toBe(before);
  });

  it("veride olmayan sayı veya olmayan kanıt yolu içeren içgörü atılır; kalanlar dataBasis ile saklanır", async () => {
    const a = await createTenant("A");
    await seedActivity(a, 20, 4);
    __setAIProviderForTests(
      new MockAIProvider(() =>
        JSON.stringify({
          summary: "Son 30 günde 20 ileti gönderildi ve 4 yanıt alındı.",
          insights: [
            { type: "positive", title: "Yanıt oranı %20", body: "20 iletiden 4 yanıt geldi.", evidence: ["rates.replyRatePct", "funnel.replies"] },
            { type: "risk", title: "Uydurma", body: "Sektör ortalaması %35, siz geridesiniz.", evidence: ["rates.replyRatePct"] },
            { type: "action", title: "Olmayan kanıt", body: "Takip edin.", evidence: ["funnel.meetings"] },
          ],
        }),
      ),
    );
    const res = await generateReport(a, 30);
    expect(res).toEqual({ created: 2, dropped: 2 });
    // Aynı milisaniyede oluşabilirler → sıraya değil başlığa göre kontrol
    const rows = await rawDb.aIInsight.findMany({ where: { companyId: a.companyId } });
    expect(rows.map((r) => r.title).sort()).toEqual(["Son 30 gün özeti", "Yanıt oranı %20"]);
    const basis = rows.find((r) => r.title === "Yanıt oranı %20")!.dataBasis as { evidence: string[]; snapshot: { funnel: { emailsSent: number } } };
    expect(basis.evidence).toEqual(["rates.replyRatePct", "funnel.replies"]);
    expect(basis.snapshot.funnel.emailsSent).toBe(20);
  });

  it("hiç doğrulanabilir içerik yoksa kredi iade edilir", async () => {
    const a = await createTenant("A");
    await seedActivity(a, 20, 4);
    __setAIProviderForTests(new MockAIProvider(() => JSON.stringify({ summary: "Satışlarınız %80 arttı.", insights: [{ type: "positive", title: "Rekor dönem", body: "Bu dönemde toplam 999 teklif verildi.", evidence: ["funnel.won"] }] })));
    const before = (await rawDb.company.findUniqueOrThrow({ where: { id: a.companyId } })).creditBalance;
    await expect(generateReport(a, 30)).rejects.toThrow(/doğrulanabilir/);
    expect((await rawDb.company.findUniqueOrThrow({ where: { id: a.companyId } })).creditBalance).toBe(before);
    expect(await rawDb.aIInsight.count({ where: { companyId: a.companyId } })).toBe(0);
  });
});

describe("AI asistan", () => {
  it("cevap verilerle desteklenir; doğrulanamayan sayı uyarı ekler; lead verisi untrusted içinde gider", async () => {
    const a = await createTenant("A");
    await seedActivity(a, 20, 4);
    const ai = new MockAIProvider((_, i) => (i === 0 ? "Son 30 günde 20 ileti gönderdiniz, 4 yanıt aldınız." : "Bu ay 57 teklif verdiniz."));
    __setAIProviderForTests(ai);

    const r1 = await askAssistant(a, "Bu ay kaç ileti gönderdim?");
    expect(r1.warning).toBeNull();
    const r2 = await askAssistant(a, "Kaç teklif verdim?", [{ role: "user", content: "Bu ay kaç ileti gönderdim?" }, { role: "assistant", content: r1.answer }]);
    expect(r2.warning).toMatch(/57/);
    expect(ai.calls[0]!.system).toContain('<untrusted source="company-data">');
    // Geçmiş en fazla 6 tur + yeni soru
    expect(ai.calls[1]!.messages.at(-1)!.content).toBe("Kaç teklif verdim?");
  });

  it("izleyici de soru sorabilir ama kredi harcar; boş soru reddedilir", async () => {
    const v = await createTenant("V", "VIEWER");
    __setAIProviderForTests(new MockAIProvider(() => "Bu bilgi elimdeki verilerde yok."));
    await expect(askAssistant(v, " ")).rejects.toThrow(/soru/i);
    const before = (await rawDb.company.findUniqueOrThrow({ where: { id: v.companyId } })).creditBalance;
    await askAssistant(v, "Merhaba");
    expect((await rawDb.company.findUniqueOrThrow({ where: { id: v.companyId } })).creditBalance).toBe(before - 1);
  });
});
