import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { rawDb } from "@/server/db";
import { drainInlineJobs } from "@/server/jobs/queue";
import { saveDiscoveredLeads, updateLeadContactInfo } from "@/server/services/leads";
import { listCallQueue, logCall } from "@/server/services/calls";
import { findLeadEmails, getLastEmailDiscovery, startEmailDiscovery } from "@/server/services/lead-intelligence";
import { pickCompanyEmail } from "@/lib/lead-normalize";
import { crawlSite, decodeCfEmail, extractPage, originCandidates } from "@/server/web/fetch-site";
import type { TenantContext } from "@/server/tenancy/types";
import { createTenant, resetDb, startSite } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await rawDb.$disconnect();
});

async function leads(ctx: TenantContext, items: Array<{ name: string; phone?: string; email?: string; website?: string; score?: number }>) {
  const { leadIds } = await saveDiscoveredLeads(
    ctx.companyId,
    items.map((i) => ({ companyName: i.name, phone: i.phone, genericEmail: i.email, website: i.website, sourceType: "GOOGLE_MAPS" as const })),
    { provider: "fake" },
  );
  for (const [n, id] of leadIds.entries()) if (items[n]!.score !== undefined) await rawDb.lead.update({ where: { id }, data: { fitScore: items[n]!.score } });
  return leadIds;
}

// ── E-posta bulma ─────────────────────────────────────────────────────

describe("kurumsal e-posta seçimi", () => {
  it("sitenin kendi alan adındaki genel kutuyu seçer; kişisel, İK ve başka alan adını seçmez", () => {
    expect(pickCompanyEmail(["ahmet@firma.com.tr", "ik@firma.com.tr", "info@firma.com.tr", "satinalma@firma.com.tr"], "https://www.firma.com.tr")).toBe("satinalma@firma.com.tr");
    expect(pickCompanyEmail(["info@webajansi.com"], "firma.com.tr")).toBeNull();
    expect(pickCompanyEmail(["ahmet@firma.com.tr"], "firma.com.tr")).toBeNull();
    expect(pickCompanyEmail(["noreply@firma.com.tr", "info@mail.firma.com.tr"], "firma.com.tr")).toBe("info@mail.firma.com.tr");
    // Ücretsiz serviste yalnızca firma adını taşıyan adres
    expect(pickCompanyEmail(["aktifyay@gmail.com"], "aktifyay.com.tr")).toBe("aktifyay@gmail.com");
    expect(pickCompanyEmail(["mehmet1980@gmail.com"], "aktifyay.com.tr")).toBeNull();
    // Firma adıyla açılmış kutular kurumsaldır; kişi adı değildir (gerçek sitelerden örnekler)
    expect(pickCompanyEmail(["trend@trendmakine.com"], "trendmakine.com")).toBe("trend@trendmakine.com");
    expect(pickCompanyEmail(["otopehlivan@gmail.com"], "pehlivanoto.com")).toBe("otopehlivan@gmail.com");
    expect(pickCompanyEmail(["murat@unlumakine.com"], "unlumakine.com")).toBeNull();
    expect(pickCompanyEmail(["info@demsay.com"], "nefdem.com")).toBeNull();
    // Genel kutu, firma adlı kutudan önce gelir
    expect(pickCompanyEmail(["trend@trendmakine.com", "info@trendmakine.com"], "trendmakine.com")).toBe("info@trendmakine.com");
  });

  it("Cloudflare ile gizlenmiş adresi çözer", () => {
    const key = 0x42;
    const hex = key.toString(16) + [..."info@firma.com"].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, "0")).join("");
    expect(decodeCfEmail(hex)).toBe("info@firma.com");
    expect(decodeCfEmail("zz")).toBeNull();
    const page = extractPage(`<a href="/cdn-cgi/l/email-protection#${hex}">[email protected]</a>`, new URL("https://firma.com/"));
    expect(page.emails).toContain("info@firma.com");
  });

  it("site taranır, iletişim sayfası sayfa sınırına takılmaz; bulunan adres kaydedilir, AI/kredi kullanılmaz", async () => {
    const a = await createTenant("A");
    const site = await startSite({
      "/": `<html><body><h1>Firma</h1>
        <a href="/hakkimizda">Hakkımızda</a><a href="/urunler">Ürünler</a><a href="/uretim">Üretim</a><a href="/kalite">Kalite</a>
        <a href="/iletisim">İletişim</a></body></html>`,
      "/hakkimizda": "<p>Hakkımızda</p>",
      "/urunler": "<p>Ürünler</p>",
      "/uretim": "<p>Üretim</p>",
      "/kalite": "<p>Kalite</p>",
      "/iletisim": `<p>Bize yazın: <a href="mailto:satis@127.0.0.1">satis</a></p>`,
    });
    try {
      const [withSite, noSite] = await leads(a, [{ name: "Siteli", website: site.url }, { name: "Sitesiz", phone: "02242223344" }]);
      const credits = (await rawDb.company.findUniqueOrThrow({ where: { id: a.companyId } })).creditBalance;
      // maxPages 3 → ana sayfa + 2; iletişim sayfası sırada 5. olmasına rağmen taranmalı
      const res = await findLeadEmails(a.companyId, [withSite!, noSite!]);
      expect(site.hits).toContain("/iletisim");
      // Sitesiz lead atlanır (sayılmaz)
      expect(res).toMatchObject({ found: 1, notFound: 0, blocked: 0, failed: 0 });
      expect(res.items).toEqual([{ leadId: withSite, name: "Siteli", outcome: "found", email: "satis@127.0.0.1" }]);
      expect((await rawDb.lead.findUniqueOrThrow({ where: { id: withSite } })).genericEmail).toBe("satis@127.0.0.1");
      expect((await rawDb.company.findUniqueOrThrow({ where: { id: a.companyId } })).creditBalance).toBe(credits);
    } finally {
      site.server.close();
    }
  });

  it("toplu e-posta araması yalnızca sitesi olup e-postası eksik lead'leri kuyruğa alır", async () => {
    const a = await createTenant("A");
    const b = await createTenant("B");
    // .invalid alan adları DNS'te hemen başarısız olur (dışarıya istek gitmez)
    const [ok, hasEmail] = await leads(a, [{ name: "X", website: "http://x-firma.invalid" }, { name: "Y", website: "http://y-firma.invalid", email: "info@y-firma.invalid" }]);
    const [other] = await leads(b, [{ name: "Z", website: "http://z-firma.invalid" }]);
    const res = await startEmailDiscovery(a, [ok!, hasEmail!, other!]);
    expect(res.count).toBe(1);
    await drainInlineJobs();
    // Özet: .invalid siteye ulaşılamaz → "ulaşılamadı" sayılır; B şirketi A'nın aramasını görmez
    const last = await getLastEmailDiscovery(a);
    expect(last).toMatchObject({ status: "SUCCEEDED", total: 1, found: 0, notFound: 0, blocked: 0, failed: 1 });
    expect(last!.items).toMatchObject([{ leadId: ok, name: "X", outcome: "failed", reason: expect.stringMatching(/Alan adı bulunamadı/), currentEmail: null }]);
    expect(await getLastEmailDiscovery(b)).toBeNull();
    const viewer = await createTenant("V", "VIEWER");
    await expect(startEmailDiscovery(viewer, [ok!])).rejects.toThrow();
  });
});

describe("site tarama sırası", () => {
  it("ürünler sayfasının alt sayfaları (anahtar kelimesiz de olsa) genel sayfalardan önce taranır", async () => {
    const site = await startSite({
      "/": `<a href="/urunler.html">Ürünler</a><a href="/blog.html">Blog</a><a href="/haberler.html">Haberler</a>`,
      "/urunler.html": `<a href="/dm.html"><img src="dm.png"></a><a href="/oto.html"><img src="oto.png"></a><a href="/iletisim.html">İletişim</a>`,
      "/dm.html": "<p>Raylı sistemler için yolcu kapıları üretiyoruz.</p>",
      "/oto.html": "<p>Otobüs acil çıkış kapı kilitleri.</p>",
      "/iletisim.html": "<p>info@firma.com</p>",
      "/blog.html": "<p>blog</p>",
      "/haberler.html": "<p>haber</p>",
    });
    try {
      const c = await crawlSite(site.url, { maxPages: 5, ensureContactPage: true, allowPrivateHosts: true });
      expect(c.pages.map((p) => new URL(p.url).pathname)).toEqual(["/", "/urunler.html", "/iletisim.html", "/dm.html", "/oto.html"]);
    } finally {
      site.server.close();
    }
  });
});

describe("site adresi yedekleri ve sosyal medya", () => {
  it("kayıtlı adres önce, sonra https (www'suz/www'li), en son http denenir", () => {
    expect(originCandidates(new URL("http://www.trendmakine.com/")).map(String)).toEqual([
      "http://www.trendmakine.com/",
      "https://trendmakine.com/",
      "https://www.trendmakine.com/",
      "http://trendmakine.com/",
    ]);
    expect(originCandidates(new URL("http://127.0.0.1:8080/")).map(String)).toEqual(["http://127.0.0.1:8080/"]);
  });

  it("web sitesi olarak sosyal medya kayıtlıysa taranmaz, nedeni yazılır", async () => {
    const a = await createTenant("A");
    const [l] = await leads(a, [{ name: "Demir Kalıp", website: "https://www.instagram.com/demir_kalip" }]);
    const res = await findLeadEmails(a.companyId, [l!]);
    expect(res.items).toEqual([{ leadId: l, name: "Demir Kalıp", outcome: "notFound", reason: expect.stringMatching(/sosyal medya/) }]);
  });
});

describe("iletişim bilgisi düzenleme", () => {
  it("hızlı e-posta ekleme yalnızca e-postayı değiştirir (telefon / site korunur)", async () => {
    const a = await createTenant("A");
    const [l] = await leads(a, [{ name: "Trend", website: "trendmakine.com", phone: "0362 111 22 33" }]);
    await updateLeadContactInfo(a, { id: l!, genericEmail: "trend@trendmakine.com" });
    expect(await rawDb.lead.findUniqueOrThrow({ where: { id: l } })).toMatchObject({ genericEmail: "trend@trendmakine.com", normalizedPhone: "+903621112233", domain: "trendmakine.com" });
  });

  it("kurumsal ve firma adlı adres kaydedilir; kişisel adres reddedilir; başka şirket / izleyici değiştiremez", async () => {
    const a = await createTenant("A");
    const b = await createTenant("B");
    const [l] = await leads(a, [{ name: "Kırpart", website: "kirpart.com.tr" }]);
    await updateLeadContactInfo(a, { id: l!, website: "kirpart.com.tr", phone: "0224 111 22 33", genericEmail: "Info@Kirpart.com.tr" });
    expect(await rawDb.lead.findUniqueOrThrow({ where: { id: l } })).toMatchObject({ genericEmail: "info@kirpart.com.tr", normalizedPhone: "+902241112233", domain: "kirpart.com.tr" });
    await updateLeadContactInfo(a, { id: l!, website: "kirpart.com.tr", genericEmail: "kirpart@gmail.com" });
    await expect(updateLeadContactInfo(a, { id: l!, website: "kirpart.com.tr", genericEmail: "ahmet.yilmaz@kirpart.com.tr" })).rejects.toThrow(/kişiye ait/);
    await expect(updateLeadContactInfo(b, { id: l!, genericEmail: "info@x.com" })).rejects.toThrow(/bulunamadı/);
    const viewer = await createTenant("V", "VIEWER");
    await expect(updateLeadContactInfo(viewer, { id: l!, genericEmail: "info@x.com" })).rejects.toThrow();
  });
});

// ── Arama listesi ─────────────────────────────────────────────────────

describe("arama listesi", () => {
  it("telefonu olanları puan sırasıyla listeler; başka şirketin lead'i görünmez", async () => {
    const a = await createTenant("A");
    const b = await createTenant("B");
    await leads(a, [
      { name: "Düşük", phone: "02121112233", score: 30 },
      { name: "Yüksek", phone: "02121112234", score: 85 },
      { name: "Telefonsuz", score: 99 },
    ]);
    await leads(b, [{ name: "Başkası", phone: "02121112235", score: 90 }]);
    const q = await listCallQueue(a);
    expect(q.map((r) => r.companyName)).toEqual(["Yüksek", "Düşük"]);
  });

  it("ulaşılamadı → yarın tekrar; tekrar ara → seçilen tarihte, bugünkü listeden çıkar", async () => {
    const a = await createTenant("A");
    const [l1, l2] = await leads(a, [{ name: "A1", phone: "02121112233" }, { name: "A2", phone: "02121112234" }]);
    const r1 = await logCall(a, { leadId: l1!, outcome: "NO_ANSWER" });
    expect(r1.nextCallAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    const at = new Date(Date.now() + 3 * 86_400_000);
    await logCall(a, { leadId: l2!, outcome: "CALL_BACK", at, note: "Pazartesi satın alma müdürü dönüyor" });
    expect(await listCallQueue(a, { view: "due" })).toHaveLength(0);
    expect((await listCallQueue(a, { view: "later" })).map((r) => r.id).sort()).toEqual([l1, l2].sort());
    expect(await rawDb.task.findFirstOrThrow({ where: { leadId: l2 } })).toMatchObject({ title: "Tekrar arayın", description: "Pazartesi satın alma müdürü dönüyor" });
    await expect(logCall(a, { leadId: l2!, outcome: "CALL_BACK", at: new Date(Date.now() - 86_400_000) })).rejects.toThrow(/ileri bir tarih/);
  });

  it("6 kez ulaşılamayan firma bugünkü listeden düşer; ulaşılınca sayaç sıfırlanır", async () => {
    const a = await createTenant("A");
    const [l] = await leads(a, [{ name: "A1", phone: "02121112233" }]);
    for (let i = 0; i < 5; i++) await logCall(a, { leadId: l!, outcome: i % 2 ? "BUSY" : "NO_ANSWER" });
    expect((await rawDb.lead.findUniqueOrThrow({ where: { id: l } })).callAttempts).toBe(5);
    const last = await logCall(a, { leadId: l!, outcome: "NO_ANSWER" });
    expect(last.nextCallAt).toBeNull();
    expect(await listCallQueue(a, { view: "due" })).toHaveLength(0);
    expect(await listCallQueue(a, { view: "all" })).toHaveLength(1);
  });

  it("ilgileniyor → fırsat + görev + durum; ilgilenmiyor ve yanlış numara listeden çıkarır", async () => {
    const a = await createTenant("A");
    const [l1, l2, l3] = await leads(a, [
      { name: "İlgili", phone: "02121112233" },
      { name: "İlgisiz", phone: "02121112234" },
      { name: "Yanlış", phone: "02121112235" },
    ]);
    const r = await logCall(a, { leadId: l1!, outcome: "CATALOG_REQUESTED", email: "satinalma@ilgili.com" });
    expect(r.opportunityId).toBeTruthy();
    const lead = await rawDb.lead.findUniqueOrThrow({ where: { id: l1 } });
    expect(lead).toMatchObject({ status: "INTERESTED", genericEmail: "satinalma@ilgili.com", nextCallAt: null });
    expect(await rawDb.task.count({ where: { leadId: l1, title: "Katalog / bilgi gönderin" } })).toBe(1);

    await logCall(a, { leadId: l2!, outcome: "NOT_INTERESTED" });
    await logCall(a, { leadId: l3!, outcome: "WRONG_NUMBER" });
    expect((await rawDb.lead.findUniqueOrThrow({ where: { id: l2 } })).status).toBe("LOST");
    // Kapanan (ilgisiz / yanlış numara) listeden çıkar; ilgilenen "Tümü"nde kalır ama bugünkü listede değil
    expect((await listCallQueue(a, { view: "all" })).map((x) => x.id)).toEqual([l1]);
    expect(await listCallQueue(a, { view: "due" })).toHaveLength(0);
  });

  it("WhatsApp izni: cep telefonu zorunlu; izinli kişi kaydı oluşur ve CallLog'da belgelenir", async () => {
    const a = await createTenant("A");
    const [l] = await leads(a, [{ name: "A1", phone: "02121112233" }]);
    await expect(logCall(a, { leadId: l!, outcome: "WHATSAPP_CONSENT", mobilePhone: "02121112233" })).rejects.toThrow(/cep telefonu/);
    expect(await rawDb.callLog.count()).toBe(0);

    await logCall(a, { leadId: l!, outcome: "WHATSAPP_CONSENT", mobilePhone: "0532 111 22 33", contactName: "Ayşe Hanım" });
    const c = await rawDb.leadContact.findFirstOrThrow({ where: { leadId: l } });
    expect(c).toMatchObject({ phone: "+905321112233", fullName: "Ayşe Hanım", consentStatus: "GRANTED", communicationBasis: "EXPLICIT_CONSENT", type: "PERSONAL" });
    expect(c.sourceUrl).toMatch(/^call:/);
    expect(await rawDb.callLog.findFirstOrThrow({ where: { leadId: l } })).toMatchObject({ outcome: "WHATSAPP_CONSENT", phone: "+902121112233" });
  });

  it("ret bildiren kişinin izni arama kaydıyla geri açılamaz", async () => {
    const a = await createTenant("A");
    const [l] = await leads(a, [{ name: "A1", phone: "02121112233" }]);
    await rawDb.leadContact.create({ data: { companyId: a.companyId, leadId: l!, phone: "+905321112233", source: "MANUAL", optOut: true, consentStatus: "WITHDRAWN" } });
    await expect(logCall(a, { leadId: l!, outcome: "WHATSAPP_CONSENT", mobilePhone: "05321112233" })).rejects.toThrow(/ret bildirmiş/);
  });

  it("bir daha aranmak istemiyor → telefon engel listesine; aynı numara başka lead'de de listelenmez", async () => {
    const a = await createTenant("A");
    const [l1, l2] = await leads(a, [
      { name: "Şube 1", phone: "0212 111 22 33" },
      { name: "Şube 2", phone: "+90 212 111 22 33" },
    ]);
    await logCall(a, { leadId: l1!, outcome: "DO_NOT_CALL" });
    expect(await rawDb.suppressionRecord.findFirst({ where: { companyId: a.companyId, type: "PHONE", value: "+902121112233" } })).not.toBeNull();
    expect((await listCallQueue(a, { view: "all" })).map((r) => r.id)).not.toContain(l2);
  });

  it("izleyici arama kaydedemez; başka şirketin lead'i bulunamaz", async () => {
    const a = await createTenant("A");
    const b = await createTenant("B");
    const [lb] = await leads(b, [{ name: "B1", phone: "02121112233" }]);
    await expect(logCall(a, { leadId: lb!, outcome: "NO_ANSWER" })).rejects.toThrow(/bulunamadı/);
    const viewer = await createTenant("V", "VIEWER");
    await expect(logCall(viewer, { leadId: lb!, outcome: "NO_ANSWER" })).rejects.toThrow();
  });
});
