import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { rawDb } from "@/server/db";
import { checkEmailQuality } from "@/lib/email-quality";
import { evaluateEmailCompliance } from "@/lib/compliance";
import { __setDnsLookupsForTests, checkMailDomain } from "@/server/providers/email/mx";
import { refreshLeadCompliance } from "@/server/services/compliance";
import { saveDiscoveredLeads } from "@/server/services/leads";
import { updateLeadContactInfo } from "@/server/services/leads";
import { createTenant, resetDb } from "./helpers";

const dnsError = (code: string) => Object.assign(new Error(code), { code });
/** MX'i olan, olmayan (ama A kaydı olan) ve hiç olmayan alan adları */
const fakeDns = {
  mx: async (host: string) => {
    if (host === "mxvar.com") return [{ exchange: "mail.mxvar.com" }];
    if (host === "sadecea.com") throw dnsError("ENODATA");
    if (host === "yok.com") throw dnsError("ENOTFOUND");
    if (host === "gecici.com") throw dnsError("ESERVFAIL");
    return [];
  },
  a: async (host: string) => {
    if (host === "sadecea.com") return ["1.2.3.4"];
    throw dnsError("ENOTFOUND");
  },
};

beforeEach(async () => {
  await resetDb();
  __setDnsLookupsForTests(fakeDns);
});
afterEach(() => __setDnsLookupsForTests(null));
afterAll(async () => {
  await rawDb.$disconnect();
});

describe("adres kalite kontrolü (DNS'siz)", () => {
  it("bozuk biçim, geçici servis, yazım hatası ve yerel alan adını yakalar", () => {
    expect(checkEmailQuality("info@firma.com.tr")).toMatchObject({ code: "ok", blocking: false, domain: "firma.com.tr" });
    expect(checkEmailQuality("bozuk-adres")).toMatchObject({ code: "invalid_syntax", blocking: true });
    expect(checkEmailQuality("info@firma")).toMatchObject({ code: "invalid_syntax", blocking: true });
    expect(checkEmailQuality("test@mailinator.com")).toMatchObject({ code: "disposable", blocking: true });
    expect(checkEmailQuality("ahmet@gmial.com")).toMatchObject({ code: "typo", blocking: true, suggestion: "ahmet@gmail.com" });
    expect(checkEmailQuality("info@sunucu.local")).toMatchObject({ code: "local_domain", blocking: true });
  });
});

describe("alan adı posta alabiliyor mu (MX / A)", () => {
  it("MX varsa ok; MX yoksa A kaydı yeterli; ikisi de yoksa no_mx; geçici DNS hatasında unknown", async () => {
    expect(await checkMailDomain("mxvar.com")).toBe("ok");
    expect(await checkMailDomain("sadecea.com")).toBe("ok");
    expect(await checkMailDomain("yok.com")).toBe("no_mx");
    expect(await checkMailDomain("gecici.com")).toBe("unknown");
    expect(await checkMailDomain("alanadidegil")).toBe("no_mx");
  });

  it("aynı alan adı ikinci kez sorulduğunda DNS'e tekrar gidilmez", async () => {
    let calls = 0;
    __setDnsLookupsForTests({ mx: async () => (calls++, [{ exchange: "m" }]), a: fakeDns.a });
    await checkMailDomain("tekrar.com");
    await checkMailDomain("tekrar.com");
    expect(calls).toBe(1);
  });
});

describe("gönderim uygunluğu", () => {
  const base = { contactType: "COMPANY_GENERIC" as const, basis: "B2B_TRADER_ADDRESS" as const, consent: "UNKNOWN" as const, optOut: false, suppressed: false };

  it("posta alamayan alan adı ve geri dönecek adres gönderilmez", () => {
    expect(evaluateEmailCompliance({ ...base, address: "info@firma.com.tr", mailDomain: "ok" }).status).toBe("SENDABLE");
    expect(evaluateEmailCompliance({ ...base, address: "info@firma.com.tr", mailDomain: "unknown" }).status).toBe("SENDABLE");
    const noMx = evaluateEmailCompliance({ ...base, address: "info@kapali.com", mailDomain: "no_mx" });
    expect(noMx.status).toBe("DO_NOT_SEND");
    expect(noMx.reasons[0]).toMatch(/posta sunucusu yok/);
    const typo = evaluateEmailCompliance({ ...base, address: "info@gmial.com" });
    expect(typo.status).toBe("DO_NOT_SEND");
    expect(typo.reasons.join(" ")).toMatch(/gmail\.com/);
  });

  it("lead uygunluğu DNS sonucunu kullanır", async () => {
    const a = await createTenant("A");
    const { leadIds } = await saveDiscoveredLeads(a.companyId, [{ companyName: "Kapalı", genericEmail: "info@yok.com", sourceType: "MANUAL" }], { provider: "fake" });
    const { best } = await refreshLeadCompliance(a.companyId, leadIds[0]!);
    expect(best).toMatchObject({ status: "DO_NOT_SEND" });
  });
});

describe("elle e-posta girişi", () => {
  it("geri dönecek adres kaydedilmez, anlaşılır hata verir", async () => {
    const a = await createTenant("A");
    const { leadIds } = await saveDiscoveredLeads(a.companyId, [{ companyName: "X", website: "mxvar.com", sourceType: "MANUAL" }], { provider: "fake" });
    const id = leadIds[0]!;
    await expect(updateLeadContactInfo(a, { id, genericEmail: "info@yok.com" })).rejects.toThrow(/e-posta alamıyor/);
    await expect(updateLeadContactInfo(a, { id, genericEmail: "info@mailinator.com" })).rejects.toThrow(/geçici/i);
    await updateLeadContactInfo(a, { id, genericEmail: "info@mxvar.com" });
    expect((await rawDb.lead.findUniqueOrThrow({ where: { id } })).genericEmail).toBe("info@mxvar.com");
  });
});

describe("firma bazlı gönderim sıklığı", () => {
  /** Lead + firma genel adresi + kişi adresi (aynı alan adı) */
  async function leadWithTwoAddresses(companyId: string) {
    const { leadIds } = await saveDiscoveredLeads(companyId, [{ companyName: "Mx Firma", genericEmail: "info@mxvar.com", sourceType: "MANUAL" }], { provider: "fake" });
    const leadId = leadIds[0]!;
    await rawDb.leadContact.create({
      data: { companyId, leadId, email: "satis@mxvar.com", type: "COMPANY_GENERIC", source: "MANUAL", communicationBasis: "B2B_TRADER_ADDRESS" },
    });
    return leadId;
  }
  const sent = (companyId: string, leadId: string, to: string, daysAgo: number) =>
    rawDb.message.create({
      data: {
        companyId,
        leadId,
        channel: "EMAIL",
        body: "x",
        status: "SENT",
        toAddress: to,
        sentAt: new Date(Date.now() - daysAgo * 86_400_000),
      },
    });

  it("aynı firmanın başka adresine 3 gün içinde ikinci ileti gitmez", async () => {
    const a = await createTenant("A");
    const leadId = await leadWithTwoAddresses(a.companyId);
    expect((await refreshLeadCompliance(a.companyId, leadId)).records.every((r) => r.status === "SENDABLE")).toBe(true);

    await sent(a.companyId, leadId, "info@mxvar.com", 1);
    const { records } = await refreshLeadCompliance(a.companyId, leadId);
    const other = records.find((r) => r.address === "satis@mxvar.com")!;
    expect(other.status).toBe("REVIEW_REQUIRED");
    expect(other.reasons[0]).toMatch(/başka bir adresine/);
  });

  it("firmaya 30 günde en fazla 2 ticari ileti; yanıt yazışmaları sayılmaz", async () => {
    const a = await createTenant("A");
    const leadId = await leadWithTwoAddresses(a.companyId);
    await sent(a.companyId, leadId, "info@mxvar.com", 20);
    await sent(a.companyId, leadId, "satis@mxvar.com", 10);

    const { records } = await refreshLeadCompliance(a.companyId, leadId);
    expect(records.every((r) => r.status === "REVIEW_REQUIRED")).toBe(true);
    expect(records[0]!.reasons[0]).toMatch(/son 30 günde 2 ticari ileti/);

    // 30 günden eski ileti sayılmaz
    await rawDb.message.updateMany({ where: { leadId }, data: { sentAt: new Date(Date.now() - 40 * 86_400_000) } });
    expect((await refreshLeadCompliance(a.companyId, leadId)).records.every((r) => r.status === "SENDABLE")).toBe(true);

    // Konuşma içindeki yanıt iletileri üst sınıra girmez
    const conv = await rawDb.conversation.create({ data: { companyId: a.companyId, leadId, channel: "EMAIL" } });
    for (let i = 0; i < 3; i++) {
      await rawDb.message.create({
        data: { companyId: a.companyId, leadId, conversationId: conv.id, channel: "EMAIL", body: "y", status: "SENT", toAddress: "info@mxvar.com", sentAt: new Date(Date.now() - i * 86_400_000) },
      });
    }
    const after = await refreshLeadCompliance(a.companyId, leadId);
    expect(after.records.find((r) => r.address === "satis@mxvar.com")!.status).toBe("SENDABLE");
  });
});
