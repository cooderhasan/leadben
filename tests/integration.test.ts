import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { rawDb } from "@/server/db";
import { __setAIProviderForTests } from "@/server/ai";
import { drainInlineJobs } from "@/server/jobs/queue";
import { consumeCredits, refundCredits } from "@/server/usage/credits";
import { authenticate, registerUser } from "@/server/auth/service";
import { startOwnWebsiteAnalysis } from "@/server/services/website-analysis";
import { correctFact, verifyFacts, buildVerifiedCompanyContext, reviewSummary } from "@/server/services/facts";
import { uploadDocument } from "@/server/services/knowledge";
import { searchKnowledge } from "@/server/knowledge/search";
import { verifyProducts } from "@/server/services/products";
import { saveExclusions, saveProductionInfo } from "@/server/services/company";
import { MockAIProvider, createTenant, resetDb, startSite } from "./helpers";

beforeEach(resetDb);
afterEach(() => __setAIProviderForTests(null));
afterAll(async () => {
  await rm("./storage-test", { recursive: true, force: true });
  await rawDb.$disconnect();
});

describe("kimlik doğrulama", () => {
  it("kayıt şirket + OWNER üyelik + deneme kredisi oluşturur", async () => {
    const { userId, companyId } = await registerUser({ name: "Hasan", email: "Hasan@Test.local", password: "guvenliParola1", companyName: "Aktif Yay" });
    const member = await rawDb.companyMember.findFirstOrThrow({ where: { userId } });
    expect(member.role).toBe("OWNER");
    const company = await rawDb.company.findUniqueOrThrow({ where: { id: companyId } });
    expect(company.creditBalance).toBe(100);
    expect(company.slug).toBe("aktif-yay");
    await expect(
      registerUser({ name: "X", email: "hasan@test.local", password: "guvenliParola1", companyName: "Y" }),
    ).rejects.toThrow(/kayıtlı/);
  });

  it("doğru parolayla girer, yanlışta reddeder ve hız sınırı uygular", async () => {
    await registerUser({ name: "A", email: "a@test.local", password: "guvenliParola1", companyName: "A" });
    await expect(authenticate("A@test.local", "guvenliParola1", "1.1.1.1")).resolves.toMatchObject({ defaultCompanyId: expect.any(String) });
    await expect(authenticate("a@test.local", "yanlis", "2.2.2.2")).rejects.toThrow(/hatalı/);
    await expect(authenticate("yok@test.local", "x", "2.2.2.2")).rejects.toThrow(/hatalı/);
    for (let i = 0; i < 5; i++) await authenticate("a@test.local", "yanlis", "3.3.3.3").catch(() => undefined);
    await expect(authenticate("a@test.local", "yanlis", "3.3.3.3")).rejects.toThrow(/Çok fazla/);
  });
});

describe("kredi sistemi", () => {
  it("atomik düşer, yetersizse hiçbir şey yazmaz, eşzamanlı isteklerde eksiye düşmez", async () => {
    const ctx = await createTenant("Kredi A"); // 100 kredi
    await consumeCredits({ companyId: ctx.companyId, operation: "document.analyze" }); // -5
    expect((await rawDb.company.findUniqueOrThrow({ where: { id: ctx.companyId } })).creditBalance).toBe(95);

    // 95 kredi / 5 = 19 başarılı; 30 eşzamanlı istek
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, () => consumeCredits({ companyId: ctx.companyId, operation: "document.analyze" })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(19);
    expect((await rawDb.company.findUniqueOrThrow({ where: { id: ctx.companyId } })).creditBalance).toBe(0);
    await expect(consumeCredits({ companyId: ctx.companyId, operation: "website.analyze" })).rejects.toThrow(/yetersiz/);
  });

  it("iade yalnızca bir kez yapılır", async () => {
    const ctx = await createTenant("Kredi B");
    const { usageId } = await consumeCredits({ companyId: ctx.companyId, operation: "website.analyze" });
    await refundCredits(usageId, "test");
    await refundCredits(usageId, "test");
    expect((await rawDb.company.findUniqueOrThrow({ where: { id: ctx.companyId } })).creditBalance).toBe(100);
  });
});

const SITE = {
  "/robots.txt": "User-agent: *\nDisallow: /gizli",
  "/": `<html><head><title>Aktif Yay — Endüstriyel Yay Üreticisi</title><meta name="description" content="Basma, çekme, kurma ve tel form yay üretimi"></head>
    <body><h1>Endüstriyel Yay Üretimi</h1>
    <a href="/hakkimizda">Hakkımızda</a> <a href="/urunler">Ürünler</a> <a href="/gizli/panel">Gizli</a>
    <p>Aktif Yay; otomotiv, beyaz eşya ve tarım makineleri sektörlerine basma yay, çekme yay, kurma yay ve tel form yay üretir.
    Müşteri teknik çizimine göre özel ölçülü üretim yapıyoruz. Kalite sistemimiz ISO 9001 belgelidir.</p>
    <p>İletişim: info@aktifyay.test</p></body></html>`,
  "/hakkimizda": `<html><head><title>Hakkımızda</title></head><body><h2>Hakkımızda</h2><p>1995'ten beri yay üretiyoruz. Otomotiv yan sanayi firmalarına tedarik sağlıyoruz.</p></body></html>`,
  "/urunler": `<html><head><title>Ürünler</title></head><body><h2>Ürünlerimiz</h2><p>Basma yay: 0,2 mm'den 12 mm'ye kadar tel çapı. Çekme yay. Kurma yay. Tel form parçalar.</p></body></html>`,
  "/gizli/panel": "<html><body>robots.txt ile engellenmiş</body></html>",
};

function analysisResponse(site: string) {
  return JSON.stringify({
    summary: "Aktif Yay, endüstriyel yay ve tel form ürünleri üreten B2B bir üreticidir. Otomotiv, beyaz eşya ve tarım makineleri öncelikli sektörleridir.",
    companyDescription: "Endüstriyel yay üreticisi",
    businessModel: "B2B",
    sector: "Endüstriyel yay üretimi",
    subSector: null,
    products: [
      { name: "Basma yay", category: "Yay", description: "0,2–12 mm tel çapı", applications: [], sourceUrl: `${site}/urunler`, evidence: "Basma yay: 0,2 mm'den 12 mm'ye kadar tel çapı" },
      { name: "Çekme yay", sourceUrl: `${site}/urunler`, evidence: "Çekme yay" },
    ],
    productCategories: ["Yay"],
    industriesServed: [
      { value: "Otomotiv", sourceUrl: `${site}/`, evidence: "otomotiv, beyaz eşya ve tarım makineleri sektörlerine", inferred: false },
      { value: "Medikal", inferred: true },
    ],
    technicalCapabilities: [{ value: "Teknik çizime göre özel ölçülü üretim", sourceUrl: `${site}/`, evidence: "Müşteri teknik çizimine göre özel ölçülü üretim yapıyoruz" }],
    certifications: [
      { value: "ISO 9001", sourceUrl: `${site}/`, evidence: "Kalite sistemimiz ISO 9001 belgelidir" },
      { value: "IATF 16949", sourceUrl: `${site}/`, evidence: "IATF 16949 sertifikalıyız" },
    ],
    productionCapacity: { value: "Yıllık 20 milyon adet", evidence: "20 milyon adet" },
    advantages: [],
    locations: [],
    keyPhrases: ["özel ölçülü üretim"],
  });
}

describe("web sitesi analizi (uçtan uca)", () => {
  it("siteyi tarar, robots.txt'ye uyar, bulguları PENDING kaydeder, uydurma sertifikayı atar", async () => {
    const { url, server, hits } = await startSite(SITE);
    try {
      const mock = new MockAIProvider(() => analysisResponse(url));
      __setAIProviderForTests(mock);
      const ctx = await createTenant("Aktif Yay");

      const { analysisId } = await startOwnWebsiteAnalysis(ctx, url);
      await drainInlineJobs();

      const analysis = await rawDb.websiteAnalysis.findUniqueOrThrow({ where: { id: analysisId } });
      expect(analysis.error).toBeNull();
      expect(analysis.status).toBe("COMPLETED");
      expect(hits).toContain("/hakkimizda");
      expect(hits).toContain("/urunler");
      expect(hits).not.toContain("/gizli/panel");

      // Güvenlik kuralları sistem prompt'unda, sayfa içeriği untrusted bloğunda
      expect(mock.calls[0]!.system).toContain("DEĞİŞMEZ KURALLAR");
      expect(mock.calls[0]!.messages[0]!.content).toContain('<untrusted source="company-website">');

      const facts = await rawDb.companyFact.findMany({ where: { companyId: ctx.companyId } });
      expect(facts.every((f) => f.status === "PENDING")).toBe(true);
      const certs = facts.filter((f) => f.key === "certification").map((f) => f.value);
      expect(certs).toEqual(["ISO 9001"]); // IATF sitede yok → atıldı
      expect(facts.some((f) => f.key === "production_capacity")).toBe(false);
      expect(facts.find((f) => f.value === "Medikal")?.source).toBe("AI_INFERRED");
      expect(facts.some((f) => f.key === "contact_email" && f.value === "info@aktifyay.test")).toBe(true);

      const profile = await rawDb.companyProfile.findUniqueOrThrow({ where: { companyId: ctx.companyId } });
      expect(profile.aiSummaryStatus).toBe("PENDING");

      // Kredi: 100 - 2
      expect((await rawDb.company.findUniqueOrThrow({ where: { id: ctx.companyId } })).creditBalance).toBe(98);

      // Onaylanmamış bilgi satış bağlamına GİRMEZ
      let context = await buildVerifiedCompanyContext(ctx);
      expect(context.summary).toBeNull();
      expect(context.facts).toHaveLength(0);

      // Onayla / Düzelt → bağlama girer
      const iso = facts.find((f) => f.value === "ISO 9001")!;
      const oto = facts.find((f) => f.value === "Otomotiv")!;
      await verifyFacts(ctx, [iso.id]);
      await correctFact(ctx, oto.id, "Otomotiv yan sanayi");
      await reviewSummary(ctx, "verify");
      context = await buildVerifiedCompanyContext(ctx);
      expect(context.summary).toContain("Aktif Yay");
      expect(context.facts.map((f) => f.value).sort()).toEqual(["ISO 9001", "Otomotiv yan sanayi"]);

      // Yeniden analiz: onaylı bilgiler korunur, tekrar PENDING olarak eklenmez
      await startOwnWebsiteAnalysis(ctx, url);
      await drainInlineJobs();
      const again = await rawDb.companyFact.findMany({ where: { companyId: ctx.companyId, value: "ISO 9001" } });
      expect(again).toHaveLength(1);
      expect(again[0]!.status).toBe("VERIFIED");
    } finally {
      server.close();
    }
  });

  it("AI başarısız olursa analiz FAILED olur ve kredi iade edilir", async () => {
    const { url, server } = await startSite(SITE);
    try {
      __setAIProviderForTests(new MockAIProvider(() => "bu json değil"));
      const ctx = await createTenant("Hata Firması");
      const { analysisId } = await startOwnWebsiteAnalysis(ctx, url);
      await drainInlineJobs();
      const a = await rawDb.websiteAnalysis.findUniqueOrThrow({ where: { id: analysisId } });
      expect(a.status).toBe("FAILED");
      expect((await rawDb.company.findUniqueOrThrow({ where: { id: ctx.companyId } })).creditBalance).toBe(100);
      const job = await rawDb.job.findFirstOrThrow({ where: { companyId: ctx.companyId } });
      expect(job.status).toBe("FAILED");
    } finally {
      server.close();
    }
  });

  it("geçersiz URL'de kredi düşmez", async () => {
    const ctx = await createTenant("URL Firması");
    await expect(startOwnWebsiteAnalysis(ctx, "ftp://x.com")).rejects.toThrow();
    expect((await rawDb.company.findUniqueOrThrow({ where: { id: ctx.companyId } })).creditBalance).toBe(100);
  });
});

describe("bilgi bankası (uçtan uca)", () => {
  const catalog = `AKTİF YAY ÜRÜN KATALOĞU

Basma Yaylar
Tel çapı 0,2 mm ile 12 mm arası. Paslanmaz çelik ve yay çeliği. Minimum sipariş 500 adet.

Çekme Yaylar
Kanca tipleri: Alman kancası, İngiliz kancası. Otomotiv ve beyaz eşya uygulamaları.

Kalite: ISO 9001 belgeli üretim.`;

  const extraction = JSON.stringify({
    documentSummary: "Aktif Yay ürün kataloğu",
    products: [
      { name: "Basma Yay", category: "Yaylar", technicalSpecs: { "Tel çapı": "0,2–12 mm" }, materials: ["Paslanmaz çelik"], minOrder: "500 adet", priceRange: "10 TL/adet", evidence: "Tel çapı 0,2 mm ile 12 mm arası" },
      { name: "Çekme Yay", category: "Yaylar", applications: ["Otomotiv", "Beyaz eşya"], evidence: "Kanca tipleri" },
    ],
    certifications: [{ value: "ISO 9001", evidence: "ISO 9001 belgeli üretim" }, { value: "AS9100", evidence: "AS9100" }],
    minOrder: { value: "500 adet", evidence: "Minimum sipariş 500 adet" },
    deliveryTime: null,
    productionCapacity: null,
    industriesServed: [],
  });

  it("dokümanı parçalar, ürünleri PENDING çıkarır, uydurma fiyat/sertifikayı atar; arama tenant izoleli", async () => {
    __setAIProviderForTests(new MockAIProvider(() => extraction));
    const a = await createTenant("Aktif Yay");
    const b = await createTenant("Rakip Firma");

    const doc = await uploadDocument(a, { name: "katalog.txt", size: catalog.length, bytes: Buffer.from(catalog) }, { kind: "CATALOG" });
    await drainInlineJobs();

    const saved = await rawDb.knowledgeDocument.findUniqueOrThrow({ where: { id: doc.id }, include: { _count: { select: { chunks: true } } } });
    expect(saved.error).toBeNull();
    expect(saved.status).toBe("READY");
    expect(saved._count.chunks).toBeGreaterThan(0);

    const products = await rawDb.product.findMany({ where: { companyId: a.companyId }, orderBy: { name: "asc" } });
    expect(products.map((p) => [p.name, p.status, p.active])).toEqual([
      ["Basma Yay", "PENDING", false],
      ["Çekme Yay", "PENDING", false],
    ]);
    expect(products[0]!.priceRange).toBeNull(); // katalogda fiyat yok → atıldı
    expect(products[0]!.minOrder).toBe("500 adet");

    const facts = await rawDb.companyFact.findMany({ where: { companyId: a.companyId } });
    expect(facts.filter((f) => f.key === "certification").map((f) => f.value)).toEqual(["ISO 9001"]);

    // Tam metin araması
    const hits = await searchKnowledge(a, "paslanmaz çelik");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.content).toContain("Paslanmaz");
    // B şirketi A'nın dokümanını bulamaz
    expect(await searchKnowledge(b, "paslanmaz çelik")).toEqual([]);
    // Yalnızca onaylı dokümanlar istenirse boş
    expect(await searchKnowledge(a, "paslanmaz", { onlyVerified: true })).toEqual([]);

    // Ürün onayı → aktif
    await verifyProducts(a, products.map((p) => p.id));
    expect(await rawDb.product.count({ where: { companyId: a.companyId, status: "VERIFIED", active: true } })).toBe(2);
    // B, A'nın ürünlerini onaylayamaz
    expect(await verifyProducts(b, products.map((p) => p.id))).toBe(0);

    expect((await rawDb.company.findUniqueOrThrow({ where: { id: a.companyId } })).creditBalance).toBe(95);
  });

  it("sahte PDF'i reddeder, kredi düşmez", async () => {
    const a = await createTenant("PDF Firması");
    await expect(
      uploadDocument(a, { name: "katalog.pdf", size: 10, bytes: Buffer.from("not a pdf!") }, { kind: "CATALOG" }),
    ).rejects.toThrow(/PDF/);
    await expect(
      uploadDocument(a, { name: "virus.exe", size: 10, bytes: Buffer.from("MZ") }, { kind: "OTHER" }),
    ).rejects.toThrow(/Desteklenen/);
    expect((await rawDb.company.findUniqueOrThrow({ where: { id: a.companyId } })).creditBalance).toBe(100);
  });
});

describe("onboarding verisi", () => {
  it("kullanıcının girdiği sertifika onaylı, kurallar şirket hafızasına yazılır; VIEWER yazamaz", async () => {
    const ctx = await createTenant("Onboarding Firması");
    await saveProductionInfo(ctx, { certifications: ["ISO 9001"], productNames: ["Basma yay", "Çekme yay"] });
    await saveProductionInfo(ctx, { certifications: ["ISO 9001"], productNames: ["Basma yay"] }); // tekrar → çoğaltmaz
    expect(await rawDb.companyFact.count({ where: { companyId: ctx.companyId, key: "certification", status: "VERIFIED" } })).toBe(1);
    expect(await rawDb.product.count({ where: { companyId: ctx.companyId, status: "VERIFIED" } })).toBe(2);

    await saveExclusions(ctx, { industries: [], cities: [], customerTypes: ["Bireysel"], rules: ["Almanya'da 5.000 adetten düşük siparişlerle ilgilenmiyoruz"] });
    const mem = await rawDb.companyMemory.findMany({ where: { companyId: ctx.companyId } });
    expect(mem.map((m) => m.content)).toEqual(["Almanya'da 5.000 adetten düşük siparişlerle ilgilenmiyoruz"]);
    expect((await buildVerifiedCompanyContext(ctx)).rules).toHaveLength(1);

    const viewer = { ...ctx, role: "VIEWER" as const };
    await expect(saveProductionInfo(viewer, { certifications: [], productNames: ["x"] })).rejects.toThrow(/yetkiniz/);
  });
});

describe("AI yapılandırılmamışken", () => {
  it("site analizi başlamaz ve kredi düşmez; doküman yine indekslenir", async () => {
    const ctx = await createTenant("AI'sız Firma");
    await expect(startOwnWebsiteAnalysis(ctx, "ornek.com.tr")).rejects.toThrow(/yapılandırılmamış/);
    const doc = await uploadDocument(ctx, { name: "not.txt", size: 80, bytes: Buffer.from("Basma yaylar otomotiv sektöründe yaygın olarak kullanılır. Tel çapı 0,5 ile 8 mm arası.") }, { kind: "CATALOG" });
    await drainInlineJobs();
    const saved = await rawDb.knowledgeDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(saved.status).toBe("READY");
    expect((await searchKnowledge(ctx, "otomotiv")).length).toBe(1);
    expect((await rawDb.company.findUniqueOrThrow({ where: { id: ctx.companyId } })).creditBalance).toBe(100);
  });
});
