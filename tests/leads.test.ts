import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { rawDb } from "@/server/db";
import { __setAIProviderForTests } from "@/server/ai";
import { __setLeadSourceProviderForTests } from "@/server/providers/lead-source";
import type { LeadSearchQuery, LeadSourceProvider, RawLead } from "@/server/providers/lead-source/types";
import { ApifyLeadSourceProvider } from "@/server/providers/lead-source/apify";
import { csvToRawLeads, parseCsv } from "@/server/providers/lead-source/csv";
import { drainInlineJobs } from "@/server/jobs/queue";
import { createManualLead, deleteLead, getLead, listLeads, saveDiscoveredLeads, updateLeadStatus } from "@/server/services/leads";
import {
  importLeadsCsv,
  startLeadResearch,
  startLeadScoring,
  startLeadSearch,
  verifyResearch,
} from "@/server/services/lead-intelligence";
import { leadResearchSchema } from "@/server/ai/prompts/lead-research";
import { extractDomain, isGenericEmail, nameSimilarity, normalizeCompanyName, normalizePhone } from "@/lib/lead-normalize";
import { computeReachability, finalizeScore, SCORE_MAX, UNVERIFIED_CAPS } from "@/lib/lead-scoring";
import { MockAIProvider, createTenant, resetDb, startSite } from "./helpers";

// ── Birim ──────────────────────────────────────────────────────────────

describe("lead normalizasyonu", () => {
  it("firma adındaki unvan eklerini ve Türkçe karakter farkını yok sayar", () => {
    expect(normalizeCompanyName("Aktif Yay San. ve Tic. A.Ş.")).toBe("aktif-yay");
    expect(normalizeCompanyName("AKTİF YAY SANAYİ TİCARET LTD. ŞTİ.")).toBe("aktif-yay");
    expect(normalizeCompanyName("Çelik Pres Otomotiv")).toBe(normalizeCompanyName("Celik Pres Otomotiv A.S."));
    expect(nameSimilarity("Yıldız Makina Kalıp", "Yildiz Makina")).toBeGreaterThan(0.6);
  });

  it("alan adını çıkarır, sosyal medya/pazaryeri adreslerini firma alan adı saymaz", () => {
    expect(extractDomain("https://www.Aktifyay.com.tr/urunler?x=1")).toBe("aktifyay.com.tr");
    expect(extractDomain("aktifyay.com.tr")).toBe("aktifyay.com.tr");
    expect(extractDomain("https://instagram.com/aktifyay")).toBeNull();
    expect(extractDomain("yok")).toBeNull();
    expect(extractDomain("")).toBeNull();
  });

  it("telefonu TR varsayımıyla E.164'e çevirir", () => {
    expect(normalizePhone("0532 123 45 67")).toBe("+905321234567");
    expect(normalizePhone("(0224) 555 44 33")).toBe("+902245554433");
    expect(normalizePhone("5321234567")).toBe("+905321234567");
    expect(normalizePhone("+90 532 123 45 67")).toBe("+905321234567");
    expect(normalizePhone("0049 30 123456")).toBe("+4930123456");
    expect(normalizePhone("123")).toBeNull();
  });

  it("kurumsal genel e-postayı kişisel adresten ayırır", () => {
    expect(isGenericEmail("info@firma.com")).toBe(true);
    expect(isGenericEmail("satis@firma.com.tr")).toBe(true);
    expect(isGenericEmail("ahmet.yilmaz@firma.com")).toBe(false);
  });
});

describe("CSV içe aktarma ayrıştırıcı", () => {
  it("noktalı virgül ayraçlı, tırnaklı ve BOM'lu Excel CSV'sini okur", () => {
    const csv = '﻿Firma Adı;Web Sitesi;Telefon;İl;Not\r\n"Aktif Yay; Tel";aktifyay.com.tr;0224 000 00 00;Bursa;x\r\n;boş.com;;;\r\n"Tırnak ""içeren"" A.Ş.";;;İstanbul;\r\n';
    const rows = parseCsv(csv);
    expect(rows[1]![0]).toBe("Aktif Yay; Tel");
    const res = csvToRawLeads(csv);
    expect(res.leads).toHaveLength(2);
    expect(res.leads[0]).toMatchObject({ companyName: "Aktif Yay; Tel", website: "aktifyay.com.tr", city: "Bursa", sourceType: "CSV_IMPORT" });
    expect(res.leads[1]!.companyName).toBe('Tırnak "içeren" A.Ş.');
    expect(res.skippedRows).toBe(1);
    expect(res.unknownHeaders).toEqual(["Not"]);
  });

  it("firma adı sütunu yoksa hiçbir satırı almaz", () => {
    expect(csvToRawLeads("a,b\n1,2").leads).toHaveLength(0);
  });
});

describe("puanlama kuralları", () => {
  it("kanıt yoksa sinyal/ölçek/ürün uyumunu sınırlar, toplamı kodda hesaplar", () => {
    const s = finalizeScore(
      { productFit: 30, industryFit: 20, sizeFit: 15, buyingSignal: 20 },
      { verifiedSignalCount: 0, hasSizeData: false, researched: false, reachability: 9 },
    );
    expect(s.buyingSignal).toBe(UNVERIFIED_CAPS.buyingSignal);
    expect(s.sizeFit).toBe(UNVERIFIED_CAPS.sizeFit);
    expect(s.productFit).toBe(UNVERIFIED_CAPS.productFit);
    expect(s.capped.sort()).toEqual(["buyingSignal", "productFit", "sizeFit"]);
    expect(s.total).toBe(s.productFit + s.industryFit + s.sizeFit + s.buyingSignal + 9);
  });

  it("kanıt varsa sınırlamaz; aralık dışı değerleri kırpar", () => {
    const s = finalizeScore(
      { productFit: 99, industryFit: -5, sizeFit: 10.6, buyingSignal: 18 },
      { verifiedSignalCount: 2, hasSizeData: true, researched: true, reachability: 50 },
    );
    expect(s).toMatchObject({ productFit: SCORE_MAX.productFit, industryFit: 0, sizeFit: 11, buyingSignal: 18, reachability: SCORE_MAX.reachability, capped: [] });
  });

  it("ulaşılabilirlik yalnızca veriden hesaplanır", () => {
    expect(computeReachability({})).toBe(0);
    expect(computeReachability({ genericEmail: "info@x.com", phone: "+90", website: "x.com", contactCount: 1, linkedin: "l" })).toBe(15);
  });
});

describe("araştırma doğrulaması (halüsinasyon koruması)", () => {
  const corpus = "Firmamız 2024 yılında Gebze'de yeni tesis yatırımı yaptı. 250 çalışanımızla otomotiv sektörüne hizmet veriyoruz. info@ornek.com";
  const base = leadResearchSchema.parse({
    summary: "Otomotiv yan sanayi firması.",
    industry: "Otomotiv",
    subIndustry: null,
    verified: [
      { statement: "Gebze'de yeni tesis", evidence: "Gebze'de yeni tesis yatırımı yaptı" },
      { statement: "ISO 9001 belgeli", evidence: "ISO 9001 kalite belgesine sahibiz" },
    ],
    signals: [
      { type: "NEW_FACILITY", title: "Gebze tesisi", evidence: "yeni tesis yatırımı yaptı", confidence: 0.9 },
      { type: "HIRING", title: "Uydurma alım", evidence: "50 mühendis alıyoruz", confidence: 0.9 },
    ],
    employeeCountMin: 250,
    employeeCountMax: 250,
    genericEmail: "info@ornek.com",
  });

  it("kanıtı kaynakta olmayan bilgi 'doğrulanmış' sayılmaz, sinyal atılır", () => {
    const v = verifyResearch(base, corpus);
    expect(v.verified.map((x) => x.statement)).toEqual(["Gebze'de yeni tesis"]);
    expect(v.downgraded).toBe(1);
    expect(v.assumptions.some((a) => a.statement === "ISO 9001 belgeli")).toBe(true);
    expect(v.signals.map((s) => s.title)).toEqual(["Gebze tesisi"]);
    expect(v.employeeCountMin).toBe(250);
    expect(v.genericEmail).toBe("info@ornek.com");
  });

  it("kaynakta geçmeyen çalışan sayısı ve kişisel e-posta yazılmaz", () => {
    const v = verifyResearch({ ...base, employeeCountMin: 900, employeeCountMax: 1200, genericEmail: "ahmet@ornek.com" }, corpus);
    expect(v.employeeCountMin).toBeNull();
    expect(v.genericEmail).toBeNull();
  });
});

describe("Apify eşleme", () => {
  it("Google Haritalar kaydını RawLead'e çevirir, kapanmış işletmeyi atar", () => {
    const p = new ApifyLeadSourceProvider("token");
    expect(
      p.toRawLead({ title: "Aktif Yay", website: "https://aktifyay.com.tr", phoneUnformatted: "+902240000000", city: "Bursa", placeId: "p1", categoryName: "Yay imalatı" }),
    ).toMatchObject({ companyName: "Aktif Yay", externalId: "p1", sourceType: "GOOGLE_MAPS", category: "Yay imalatı" });
    expect(p.toRawLead({ title: "Kapalı", permanentlyClosed: true })).toBeNull();
    const input = p.buildInput({ keywords: ["yay imalatı", "tel büküm"], cities: ["Bursa"], limit: 20 });
    expect(input).toMatchObject({ searchStringsArray: ["yay imalatı", "tel büküm"], locationQuery: "Bursa, Türkiye", maxCrawledPlacesPerSearch: 10 });
  });

  it("token yoksa anlaşılır hata verir", () => {
    expect(() => new ApifyLeadSourceProvider("")).toThrow(/APIFY_TOKEN/);
  });
});

// ── Entegrasyon (gerçek Postgres) ──────────────────────────────────────

class FakeLeadSource implements LeadSourceProvider {
  readonly name = "fake";
  readonly sourceType = "GOOGLE_MAPS" as const;
  starts: LeadSearchQuery[] = [];
  polls = 0;
  constructor(private readonly leads: RawLead[], private readonly pendingPolls = 1, private readonly fail = false) {}
  async startSearch(q: LeadSearchQuery) {
    this.starts.push(q);
    return { runId: `run-${this.starts.length}`, provider: this.name, status: "RUNNING" as const };
  }
  async fetchResults() {
    this.polls++;
    if (this.fail) return { status: "FAILED" as const, leads: [] };
    if (this.polls <= this.pendingPolls) return { status: "RUNNING" as const, leads: [] };
    return { status: "SUCCEEDED" as const, leads: this.leads };
  }
}

const raw = (companyName: string, extra: Partial<RawLead> = {}): RawLead => ({ companyName, sourceType: "GOOGLE_MAPS", ...extra });

const balance = async (companyId: string) =>
  (await rawDb.company.findUniqueOrThrow({ where: { id: companyId }, select: { creditBalance: true } })).creditBalance;

beforeEach(resetDb);
afterEach(() => {
  __setAIProviderForTests(null);
  __setLeadSourceProviderForTests(null);
});
afterAll(async () => {
  await rawDb.$disconnect();
});

describe("lead dedupe ve kaydetme", () => {
  it("alan adı, telefon veya ad+şehir eşleşen firmayı tekrar oluşturmaz; eksik alanları tamamlar", async () => {
    const a = await createTenant("Satıcı A");
    const first = await saveDiscoveredLeads(a.companyId, [raw("Aktif Yay San. Tic. A.Ş.", { website: "https://aktifyay.com.tr", city: "Bursa", externalId: "g1" })], { provider: "fake" });
    expect(first.created).toBe(1);

    const second = await saveDiscoveredLeads(
      a.companyId,
      [
        raw("AKTİF YAY", { website: "http://www.aktifyay.com.tr/iletisim", phone: "0224 111 22 33", externalId: "g1" }), // alan adı
        raw("Başka İsim Ltd", { phone: "+90 224 111 22 33" }), // telefon
        raw("Aktif Yay Sanayi", { city: "bursa" }), // ad + şehir
        raw("Aktif Yay Sanayi", { city: "Ankara" }), // farklı şehir → farklı firma
        raw("   "), // atlanır
      ],
      { provider: "fake" },
    );
    expect(second).toMatchObject({ created: 1, merged: 3, skipped: 1 });

    const leads = await rawDb.lead.findMany({ where: { companyId: a.companyId }, orderBy: { createdAt: "asc" } });
    expect(leads).toHaveLength(2);
    expect(leads[0]!.phone).toBe("0224 111 22 33"); // eksik alan tamamlandı
    expect(leads[0]!.companyName).toBe("Aktif Yay San. Tic. A.Ş."); // dolu alan ezilmedi
    // Aynı sağlayıcı + externalId ikinci kez kaynak kaydı oluşturmaz
    expect(await rawDb.leadSource.count({ where: { leadId: leads[0]!.id, externalId: "g1" } })).toBe(1);
  });

  it("kişisel iletişim bilgisi lead'e değil LeadContact'a, dayanaksız (NONE) yazılır", async () => {
    const a = await createTenant("Satıcı A");
    const res = await saveDiscoveredLeads(
      a.companyId,
      [raw("Firma X", { personalContacts: [{ fullName: "Ahmet Y", email: "Ahmet@FirmaX.com" }, { email: "ahmet@firmax.com" }] })],
      { provider: "fake" },
    );
    const contacts = await rawDb.leadContact.findMany({ where: { leadId: res.leadIds[0] } });
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({ email: "ahmet@firmax.com", type: "PERSONAL", communicationBasis: "NONE" });
  });

  it("elle ekleme ve CSV aynı dedupe kurallarını kullanır, kredi harcamaz", async () => {
    const a = await createTenant("Satıcı A");
    const before = await balance(a.companyId);
    const m = await createManualLead(a, { companyName: "Demir Kalıp", website: "demirkalip.com", sourceType: "MANUAL" });
    expect(m.merged).toBe(false);
    const csv = await importLeadsCsv(a, "Firma,Web,İl\nDemir Kalıp A.Ş.,https://demirkalip.com,Kocaeli\nYeni Firma,,İzmir\n");
    expect(csv).toMatchObject({ created: 1, merged: 1 });
    expect(await balance(a.companyId)).toBe(before);
    await expect(importLeadsCsv(a, "x,y\n1,2")).rejects.toThrow(/firma adı/i);
  });
});

describe("lead yetki ve tenant izolasyonu", () => {
  it("başka şirketin lead'i okunamaz, güncellenemez, silinemez, puanlanamaz", async () => {
    const a = await createTenant("A");
    const b = await createTenant("B");
    const { leadIds } = await saveDiscoveredLeads(b.companyId, [raw("B'nin Lead'i")], { provider: "fake" });
    const bLead = leadIds[0]!;

    await expect(getLead(a, bLead)).rejects.toThrow(/bulunamadı/);
    await expect(updateLeadStatus(a, bLead, "WON")).rejects.toThrow(/bulunamadı/);
    await expect(deleteLead(a, bLead)).rejects.toThrow(/bulunamadı/);
    expect((await listLeads(a)).total).toBe(0);

    __setAIProviderForTests(new MockAIProvider(() => "{}"));
    await expect(startLeadScoring(a, [bLead])).rejects.toThrow(/bulunamadı/);
    expect((await rawDb.lead.findUniqueOrThrow({ where: { id: bLead } })).status).toBe("NEW");
  });

  it("İzleyici (VIEWER) lead okuyabilir ama arama/ekleme yapamaz", async () => {
    const v = await createTenant("V", "VIEWER");
    await expect(listLeads(v)).resolves.toMatchObject({ total: 0 });
    await expect(createManualLead(v, raw("X"))).rejects.toThrow(/yetki/);
    __setLeadSourceProviderForTests(new FakeLeadSource([]));
    await expect(startLeadSearch(v, "otomotiv firmaları")).rejects.toThrow(/yetki/);
  });
});

describe("lead arama işi", () => {
  const searchAI = () =>
    new MockAIProvider(() =>
      JSON.stringify({ keywords: ["otomotiv yan sanayi"], industries: ["Otomotiv"], country: "Türkiye", cities: ["Bursa"], districts: [], requestedLimit: null, interpretation: "Bursa'daki otomotiv yan sanayi firmaları" }),
    );

  it("doğal dili sorguya çevirir, dedupe eder ve yalnızca yeni lead'leri ücretlendirir", async () => {
    const a = await createTenant("A");
    await saveDiscoveredLeads(a.companyId, [raw("Mevcut Firma", { website: "mevcut.com" })], { provider: "fake" });
    const source = new FakeLeadSource([raw("Yeni 1", { website: "yeni1.com" }), raw("Yeni 2"), raw("Mevcut Firma AŞ", { website: "https://mevcut.com" })], 2);
    __setLeadSourceProviderForTests(source);
    __setAIProviderForTests(searchAI());

    const before = await balance(a.companyId);
    const res = await startLeadSearch(a, "Bursa'da otomotiv yan sanayi", 10);
    expect(res.reserved).toBe(10);
    expect(await balance(a.companyId)).toBe(before - 10); // önden ayrıldı
    await drainInlineJobs();

    expect(source.starts).toHaveLength(1);
    expect(source.starts[0]).toMatchObject({ keywords: ["otomotiv yan sanayi"], cities: ["Bursa"], limit: 10 });
    const job = await rawDb.job.findUniqueOrThrow({ where: { id: res.jobId } });
    expect(job.status).toBe("SUCCEEDED");
    expect(job.result).toMatchObject({ found: 3, created: 2, merged: 1 });
    expect((job.payload as { runId?: string }).runId).toBe("run-1");
    expect(await balance(a.companyId)).toBe(before - 2); // 8 kredi iade
    expect(await rawDb.lead.count({ where: { companyId: a.companyId } })).toBe(3);
  });

  it("kaynak başarısız olursa krediyi tamamen iade eder", async () => {
    const a = await createTenant("A");
    __setLeadSourceProviderForTests(new FakeLeadSource([], 0, true));
    __setAIProviderForTests(searchAI());
    const before = await balance(a.companyId);
    const res = await startLeadSearch(a, "otomotiv", 5);
    await drainInlineJobs();
    expect((await rawDb.job.findUniqueOrThrow({ where: { id: res.jobId } })).status).toBe("FAILED");
    expect(await balance(a.companyId)).toBe(before);
  });

  it("AI yokken arama ifadesini olduğu gibi kullanır; yetersiz kredide başlamaz", async () => {
    const a = await createTenant("A");
    const source = new FakeLeadSource([]);
    __setLeadSourceProviderForTests(source);
    // AI sağlayıcısı enjekte edilmedi ve test ortamında API anahtarı yok
    delete process.env.ANTHROPIC_API_KEY;
    const { resetEnvCache } = await import("@/server/env");
    resetEnvCache();
    await startLeadSearch(a, "tel büküm atölyesi", 3);
    await drainInlineJobs();
    expect(source.starts[0]!.keywords).toEqual(["tel büküm atölyesi"]);

    await rawDb.company.update({ where: { id: a.companyId }, data: { creditBalance: 2 } });
    await expect(startLeadSearch(a, "tel büküm", 3)).rejects.toThrow(/kredi/);
  });

  it("devam eden arama varken ikinci arama başlatılamaz", async () => {
    const a = await createTenant("A");
    __setLeadSourceProviderForTests(new FakeLeadSource([], 1));
    __setAIProviderForTests(searchAI());
    await rawDb.job.create({ data: { companyId: a.companyId, type: "lead.search", status: "RUNNING", payload: {} } });
    await expect(startLeadSearch(a, "otomotiv", 5)).rejects.toThrow(/Devam eden/);
  });
});

describe("lead araştırma ve puanlama", () => {
  const SITE = {
    "/robots.txt": "User-agent: *\nAllow: /",
    "/": `<html><head><title>Örnek Otomotiv</title></head><body><h1>Örnek Otomotiv Parça</h1>
      <p>Örnek Otomotiv, 1998'den bu yana Bursa'da otomotiv yan sanayi için metal pres parçaları üretmektedir.
      2025 yılında Gebze'de yeni tesis yatırımı yaptık. 180 çalışanımızla hizmet veriyoruz.
      Bize info@ornekoto.com adresinden ulaşabilirsiniz. Ürünlerimizde yay ve tel form parçaları kullanılmaktadır.</p></body></html>`,
  };

  const researchJson = JSON.stringify({
    summary: "Bursa'da otomotiv yan sanayi için metal pres parçaları üreten firma.",
    industry: "Otomotiv yan sanayi",
    subIndustry: "Metal pres",
    products: ["Metal pres parçaları"],
    employeeCountMin: 180,
    employeeCountMax: 180,
    verified: [
      { statement: "Metal pres parçaları üretir", evidence: "otomotiv yan sanayi için metal pres parçaları üretmektedir" },
      { statement: "IATF 16949 sertifikalı", evidence: "IATF 16949 sertifikamız vardır" },
    ],
    assumptions: [{ statement: "Yay tedarikçisi arıyor olabilir", reason: "Ürünlerinde yay kullanılıyor" }],
    signals: [{ type: "NEW_FACILITY", title: "Gebze'de yeni tesis", evidence: "Gebze'de yeni tesis yatırımı yaptık", publishedAt: "2025-03-01", confidence: 0.8 }],
    genericEmail: "info@ornekoto.com",
    phone: null,
    socialProfiles: {},
  });

  const scoreJson = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      productFit: 28,
      industryFit: 18,
      sizeFit: 12,
      buyingSignal: 16,
      matchedProducts: ["Basma Yay", "Uydurma Ürün"],
      explanation: "Firma ürünlerinde yay kullanıyor ve yeni tesis yatırımı yaptı.",
      verifiedFacts: ["Metal pres parçaları üretir"],
      assumptions: [],
      excludedReason: null,
      ...extra,
    });

  it("siteyi okur, kanıtsız bilgiyi varsayıma indirir, sinyal ekler ve puanlar", async () => {
    const a = await createTenant("Aktif Yay");
    await rawDb.product.create({ data: { companyId: a.companyId, name: "Basma Yay", status: "VERIFIED", source: "USER", active: true } });
    const { url, server } = await startSite(SITE);
    try {
      const { leadIds } = await saveDiscoveredLeads(a.companyId, [raw("Örnek Otomotiv", { website: url })], { provider: "fake" });
      const leadId = leadIds[0]!;
      const ai = new MockAIProvider((input) => (input.system?.includes("puanla") ? scoreJson() : researchJson));
      __setAIProviderForTests(ai);

      const before = await balance(a.companyId);
      await startLeadResearch(a, leadId);
      expect(await balance(a.companyId)).toBe(before - 2);
      await drainInlineJobs();

      const lead = await getLead(a, leadId);
      const enrichment = lead.enrichment as { verified: Array<{ statement: string }>; assumptions: Array<{ statement: string }>; downgraded: number };
      expect(enrichment.verified.map((v) => v.statement)).toEqual(["Metal pres parçaları üretir"]);
      expect(enrichment.downgraded).toBe(1);
      expect(enrichment.assumptions.map((x) => x.statement)).toContain("IATF 16949 sertifikalı");
      expect(lead.genericEmail).toBe("info@ornekoto.com");
      expect(lead.employeeCountMin).toBe(180);
      expect(lead.signals).toHaveLength(1);
      expect(lead.signals[0]).toMatchObject({ type: "NEW_FACILITY", verified: true });
      expect(lead.lastVerifiedAt).not.toBeNull();

      const score = lead.scores[0]!;
      // İzin verilen ürünler dışındaki "Uydurma Ürün" atılır
      expect((score.verifiedFacts as { matchedProducts: string[] }).matchedProducts).toEqual(["Basma Yay"]);
      // Kanıt var (sinyal + ölçek + araştırma) → sınır yok; ulaşılabilirlik: e-posta 5 + site 3
      expect(score).toMatchObject({ productFit: 28, industryFit: 18, sizeFit: 12, buyingSignal: 16, reachability: 8, total: 82 });
      expect(lead.fitScore).toBe(82);
      expect(lead.status).toBe("QUALIFIED");

      // Satıcı bağlamı yalnızca doğrulanmış bilgiyle kurulur; lead verisi untrusted içinde
      const scorePrompt = ai.calls.find((c) => c.system?.includes("puanla"))!.messages[0]!.content as string;
      expect(scorePrompt).toContain("<untrusted source=\"lead-data\">");
      expect(scorePrompt).toContain("Basma Yay");
    } finally {
      server.close();
    }
  });

  it("araştırılmamış lead'in puanı kanıt eksikliği nedeniyle sınırlanır", async () => {
    const a = await createTenant("A");
    const { leadIds } = await saveDiscoveredLeads(a.companyId, [raw("Sadece Dizin", { phone: "02240000000" })], { provider: "fake" });
    __setAIProviderForTests(new MockAIProvider(() => scoreJson({ productFit: 30, buyingSignal: 20, sizeFit: 15, industryFit: 20 })));
    await startLeadScoring(a, leadIds);
    await drainInlineJobs();
    const lead = await getLead(a, leadIds[0]!);
    // 15 (ürün sınırı) + 20 + 7 (ölçek sınırı) + 4 (sinyal sınırı) + 4 (telefon)
    expect(lead.fitScore).toBe(50);
    expect(lead.scores[0]!.assumptions as string[]).toEqual(expect.arrayContaining([expect.stringContaining("Kanıt eksikliği")]));
  });

  it("site okunamazsa iş başarısız olur ve kredi iade edilir", async () => {
    const a = await createTenant("A");
    const { url, server } = await startSite({ "/robots.txt": "User-agent: *\nAllow: /", "/": "<html><body></body></html>" });
    try {
      const { leadIds } = await saveDiscoveredLeads(a.companyId, [raw("Boş Site", { website: url })], { provider: "fake" });
      __setAIProviderForTests(new MockAIProvider(() => researchJson));
      const before = await balance(a.companyId);
      await startLeadResearch(a, leadIds[0]!);
      await drainInlineJobs();
      expect(await balance(a.companyId)).toBe(before);
      const job = await rawDb.job.findFirstOrThrow({ where: { companyId: a.companyId, type: "lead.enrich" } });
      expect(job.status).toBe("FAILED");
      expect(job.attempts).toBe(1); // kalıcı hata tekrar denenmez
    } finally {
      server.close();
    }
  });

  it("web sitesi olmayan lead araştırılamaz", async () => {
    const a = await createTenant("A");
    const { leadIds } = await saveDiscoveredLeads(a.companyId, [raw("Sitesiz")], { provider: "fake" });
    __setAIProviderForTests(new MockAIProvider(() => researchJson));
    await expect(startLeadResearch(a, leadIds[0]!)).rejects.toThrow(/web sitesi/);
  });
});
