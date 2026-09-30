import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { rawDb } from "@/server/db";
import { __setAIProviderForTests } from "@/server/ai";
import { __setLeadSourceProviderForTests } from "@/server/providers/lead-source";
import { ApifyWebSearchProvider, companyNameFromTitle } from "@/server/providers/lead-source/apify-web";
import type { LeadSearchQuery, LeadSourceProvider, RawLead } from "@/server/providers/lead-source/types";
import { drainInlineJobs } from "@/server/jobs/queue";
import { applyListFilter, getLastListImport, mapStructuredRecords, parseListFilter, startLeadSearch, startListImport, verifyListCompanies } from "@/server/services/lead-intelligence";
import { findDataTableSource, htmlToListText, parseDataTableJson } from "@/server/web/fetch-site";
import { MockAIProvider, createTenant, resetDb, startSite } from "./helpers";

beforeEach(resetDb);
afterEach(() => {
  __setAIProviderForTests(null);
  __setLeadSourceProviderForTests(null);
});
afterAll(async () => {
  await rawDb.$disconnect();
});

const balance = async (companyId: string) => (await rawDb.company.findUniqueOrThrow({ where: { id: companyId } })).creditBalance;

// ── Web araması ────────────────────────────────────────────────────────

describe("web araması kaynağı", () => {
  const web = new ApifyWebSearchProvider("token");

  it("sorguyu Google aramalarına çevirir (konum eklenir, sayfa sayısı hedefe göre)", () => {
    const input = web.buildInput({ keywords: ["pres makinası üreticisi", "hidrolik pres imalatı"], cities: ["Konya"], limit: 40 });
    expect(input).toMatchObject({ queries: "pres makinası üreticisi Konya\nhidrolik pres imalatı Konya", maxPagesPerQuery: 3, countryCode: "tr", languageCode: "tr" });
    expect(web.buildInput({ keywords: ["x"], limit: 5 })).toMatchObject({ maxPagesPerQuery: 1 });
  });

  it("dizin, pazaryeri, sosyal medya ve haber sitelerini eler; aynı alan adını bir kez alır", () => {
    const leads = web.toRawLeads([
      {
        searchQuery: { term: "pres makinası üreticisi" },
        organicResults: [
          { title: "Özkan Pres | Hidrolik Pres Makinaları", url: "https://www.ozkanpres.com.tr/urunler" },
          { title: "Özkan Pres İletişim", url: "https://ozkanpres.com.tr/iletisim" },
          { title: "Pres makinası ilanları - sahibinden.com", url: "https://www.sahibinden.com/pres" },
          { title: "En iyi 10 pres firması", url: "https://www.firmasec.com/pres" },
          { title: "Pres üreticisi Instagram", url: "https://instagram.com/ozkan" },
          { title: "Pres sektörü büyüyor", url: "https://www.dunya.com/haber/1" },
          { title: "Ticaret Bakanlığı", url: "https://ticaret.gov.tr/pres" },
          { title: "Yıldız Makina - Pres ve Kalıp", url: "http://yildizmakina.com/" },
        ],
      },
    ]);
    expect(leads.map((l) => [l.companyName, l.website])).toEqual([
      ["Özkan Pres", "https://www.ozkanpres.com.tr/"],
      ["Yıldız Makina", "http://yildizmakina.com/"],
    ]);
    expect(leads[0]).toMatchObject({ sourceType: "WEB_SEARCH", category: "pres makinası üreticisi", externalId: "ozkanpres.com.tr" });
  });

  it("başlıktan firma adını seçer (alan adıyla örtüşen parça, yoksa en kısa)", () => {
    expect(companyNameFromTitle("Hidrolik Pres Makinaları | Özkan Pres", "ozkanpres.com.tr")).toBe("Özkan Pres");
    expect(companyNameFromTitle("Anasayfa - Metal Form A.Ş.", "mf.com")).toBe("Anasayfa");
  });

  it("kaynak seçimi: Otomatik'te AI'ın seçimi, elle seçilince o kullanılır", async () => {
    const a = await createTenant("A");
    const starts: LeadSearchQuery[] = [];
    const fake: LeadSourceProvider = {
      name: "fake",
      sourceType: "WEB_SEARCH",
      startSearch: async (q) => (starts.push(q), { runId: "r", provider: "fake", status: "RUNNING" }),
      fetchResults: async () => ({ status: "SUCCEEDED", leads: [] as RawLead[] }),
    };
    __setLeadSourceProviderForTests(fake);
    __setAIProviderForTests(
      new MockAIProvider(() =>
        JSON.stringify({ keywords: ["pres makinası üreticisi"], industries: [], country: "Türkiye", cities: [], districts: [], requestedLimit: null, source: "web", interpretation: "Pres makinası üreticileri" }),
      ),
    );
    const auto = await startLeadSearch(a, "kalıp yayı kullanan pres makinası üreticileri", 5);
    expect(auto.source).toBe("web");
    await drainInlineJobs();
    const manual = await startLeadSearch(a, "kalıp yayı kullanan pres makinası üreticileri", 5, "maps");
    expect(manual.source).toBe("maps");
    expect(((await rawDb.job.findUniqueOrThrow({ where: { id: manual.jobId } })).payload as { source: string }).source).toBe("maps");
    await drainInlineJobs();
  });
});

// ── Liste sayfası ──────────────────────────────────────────────────────

const LIST_HTML = `<html><head><title>OSB Firmalar</title></head><body>
  <nav>Anasayfa Hakkımızda</nav>
  <h1>Üye Firmalar</h1>
  <table>
    <tr><th>Firma</th><th>Sektör</th><th>Telefon</th><th>Web</th></tr>
    <tr><td>Aydın Metal San. Ltd. Şti.</td><td>Metal işleme</td><td>(0262) 751 12 34</td><td><a href="https://www.aydinmetal.com.tr">aydinmetal.com.tr</a></td></tr>
    <tr><td>Kaya Plastik A.Ş.</td><td>Plastik enjeksiyon</td><td>0262 751 55 66</td><td>info@kayaplastik.com</td></tr>
  </table>
  <footer>© OSB</footer>
</body></html>`;

describe("liste sayfasından içe aktarma", () => {
  it("HTML tabloyu satır korumalı metne çevirir; dış bağlantıları sona ekler", () => {
    const text = htmlToListText(LIST_HTML, new URL("https://osb.org.tr/firmalar"));
    expect(text).toContain("Aydın Metal San. Ltd. Şti. | Metal işleme | (0262) 751 12 34 | aydinmetal.com.tr");
    expect(text).toContain("Kaya Plastik A.Ş. | Plastik enjeksiyon");
    expect(text).toContain("SAYFADAKİ BAĞLANTILAR:\nhttps://www.aydinmetal.com.tr");
    expect(text).not.toContain("Anasayfa Hakkımızda");
  });

  it("uydurulan firma ve bilgiler kaydedilmez; kişisel e-posta alınmaz", () => {
    const text = htmlToListText(LIST_HTML, new URL("https://osb.org.tr/firmalar")) + "\nDemir Döküm | döküm | ahmet.demir@demirdokum.com";
    const { leads, dropped } = verifyListCompanies(
      [
        { name: "Aydın Metal San. Ltd. Şti.", website: "aydinmetal.com.tr", phone: "0262 751 12 34", email: null, city: null, district: null, sector: "Metal işleme" },
        { name: "Kaya Plastik A.Ş.", website: "kayaplastik.com", phone: "0262 751 99 99", email: "info@kayaplastik.com", city: "Kocaeli", district: null, sector: null },
        { name: "Hayali Firma A.Ş.", website: "hayali.com", phone: null, email: null, city: null, district: null, sector: null },
        { name: "Demir Döküm", website: null, phone: null, email: "ahmet.demir@demirdokum.com", city: null, district: null, sector: null },
        { name: "Aydın Metal San. Ltd. Şti.", website: null, phone: null, email: null, city: null, district: null, sector: null },
      ],
      text,
      "https://osb.org.tr/firmalar",
    );
    expect(dropped).toBe(2); // hayali + tekrar
    expect(leads[0]).toMatchObject({ companyName: "Aydın Metal San. Ltd. Şti.", website: "aydinmetal.com.tr", phone: "0262 751 12 34", category: "Metal işleme", sourceType: "DIRECTORY" });
    // Metinde olmayan telefon / il boşaltılır; alan adı metinde (e-postada) geçtiği için site kalır
    expect(leads[1]).toMatchObject({ companyName: "Kaya Plastik A.Ş.", website: "kayaplastik.com", phone: undefined, city: undefined, genericEmail: "info@kayaplastik.com" });
    expect(leads.find((l) => l.companyName === "Hayali Firma A.Ş.")).toBeUndefined();
    expect(leads[2]).toMatchObject({ companyName: "Demir Döküm", genericEmail: undefined });
  });

  it("uçtan uca: sayfa okunur, AI çıkarır, doğrulananlar kaydedilir; firma çıkmazsa kredi iade", async () => {
    const a = await createTenant("A");
    const site = await startSite({ "/robots.txt": "User-agent: *\nAllow: /", "/firmalar": LIST_HTML });
    try {
      __setAIProviderForTests(
        new MockAIProvider(() =>
          JSON.stringify({
            companies: [
              { name: "Aydın Metal San. Ltd. Şti.", website: "aydinmetal.com.tr", phone: "(0262) 751 12 34", email: null, city: null, district: null, sector: "Metal işleme" },
              { name: "Uydurma Makina", website: null, phone: null, email: null, city: null, district: null, sector: null },
            ],
          }),
        ),
      );
      const before = await balance(a.companyId);
      await startListImport(a, { url: `${site.url}/firmalar` });
      await drainInlineJobs();
      const last = await getLastListImport(a);
      expect(last).toMatchObject({ status: "SUCCEEDED", extracted: 2, dropped: 1, created: 1 });
      expect(await rawDb.lead.findMany({ where: { companyId: a.companyId }, select: { companyName: true, domain: true } })).toEqual([
        { companyName: "Aydın Metal San. Ltd. Şti.", domain: "aydinmetal.com.tr" },
      ]);
      expect(await balance(a.companyId)).toBe(before - 3);

      // Hiçbiri doğrulanamazsa kredi iade
      __setAIProviderForTests(new MockAIProvider(() => JSON.stringify({ companies: [{ name: "Yok Böyle Firma", website: null, phone: null, email: null, city: null, district: null, sector: null }] })));
      await startListImport(a, { text: "Liste:\nBurada gerçek firma adları var ama AI başka bir şey döndürdü.\nSatır iki\nSatır üç" });
      await drainInlineJobs();
      expect(await getLastListImport(a)).toMatchObject({ status: "SUCCEEDED", created: 0 });
      expect(await balance(a.companyId)).toBe(before - 3);
    } finally {
      site.server.close();
    }
  });

  it("robots.txt ile kapalı sayfa okunmaz, kredi iade edilir; izleyici başlatamaz", async () => {
    const a = await createTenant("A");
    const site = await startSite({ "/robots.txt": "User-agent: *\nDisallow: /", "/firmalar": LIST_HTML });
    try {
      __setAIProviderForTests(new MockAIProvider(() => JSON.stringify({ companies: [] })));
      const before = await balance(a.companyId);
      await startListImport(a, { url: `${site.url}/firmalar` });
      await drainInlineJobs();
      expect(await getLastListImport(a)).toMatchObject({ status: "FAILED", error: expect.stringMatching(/robots\.txt/) });
      expect(await balance(a.companyId)).toBe(before);
      expect(site.hits).not.toContain("/firmalar");
    } finally {
      site.server.close();
    }
    const viewer = await createTenant("V", "VIEWER");
    await expect(startListImport(viewer, { text: "x".repeat(100) })).rejects.toThrow();
  });
});

// ── Yapılandırılmış liste (DataTables) ─────────────────────────────────

const DT_PAGE = `<html><body><h1>Firma Listesi</h1><table id="t"><thead><tr><th>Firma</th><th>Sektör</th></tr></thead></table>
<script>$("#t").DataTable({ processing: true, ajax: "/data.json", columns: [{ data: "company_name" }] });</script></body></html>`;
const DT_JSON = JSON.stringify({
  draw: 0,
  data: [
    { company_name: "Acv Süspansiyon Sistemleri A.Ş.", sector_name: "Otomotiv Yedek Parça", phone_no: "3323101030", mail: null, website: "acvsuspension.com", parcel_address: "No: 9" },
    { company_name: "Acv Süspansiyon Sistemleri A.Ş.", sector_name: "Otomotiv Yedek Parça", phone_no: null, mail: null, website: null, parcel_address: "No: 10" },
    { company_name: "Mavi Gıda Ltd.", sector_name: "Gıda", phone_no: null, mail: "ahmet@mavigida.com", website: "mavigida.com", parcel_address: "-" },
    { company_name: "Yıldız Makina", sector_name: "<b>Makina</b>", phone_no: "0332 111 22 33", mail: "info@yildizmakina.com", website: "https://yildizmakina.com", parcel_address: null },
    { company_name: "", sector_name: "Boş", phone_no: null, mail: null, website: null, parcel_address: null },
  ],
});

describe("yapılandırılmış liste (DataTables)", () => {
  it("sayfadaki veri kaynağını bulur (yalnızca aynı site) ve JSON satırlarını okur", () => {
    const page = new URL("https://www.kos.org.tr/list");
    expect(findDataTableSource(`ajax: "https://www.kos.org.tr/list"`, page)?.toString()).toBe("https://www.kos.org.tr/list");
    expect(findDataTableSource(`ajax: { url: "/api/firms", type: "GET" }`, page)?.toString()).toBe("https://www.kos.org.tr/api/firms");
    expect(findDataTableSource(`ajax: "https://baska-site.com/veri"`, page)).toBeNull();
    expect(findDataTableSource("<p>tablo yok</p>", page)).toBeNull();
    expect(parseDataTableJson(DT_JSON)).toHaveLength(5);
    expect(parseDataTableJson(JSON.stringify({ aaData: [{ a: 1 }] }))).toEqual([{ a: 1 }]);
    expect(parseDataTableJson("<html>")).toBeNull();
  });

  it("alanları AI olmadan eşler; tekrar ve adsız satır atlanır; kişisel e-posta alınmaz; HTML temizlenir", () => {
    const res = mapStructuredRecords(parseDataTableJson(DT_JSON)!, "https://www.kos.org.tr/list")!;
    expect(res.dropped).toBe(2);
    expect(res.leads.map((l) => l.companyName)).toEqual(["Acv Süspansiyon Sistemleri A.Ş.", "Mavi Gıda Ltd.", "Yıldız Makina"]);
    expect(res.leads[0]).toMatchObject({ website: "acvsuspension.com", phone: "3323101030", category: "Otomotiv Yedek Parça", address: "No: 9", sourceType: "DIRECTORY" });
    expect(res.leads[1]).toMatchObject({ genericEmail: undefined, address: undefined });
    expect(res.leads[2]).toMatchObject({ genericEmail: "info@yildizmakina.com", website: "yildizmakina.com", category: "Makina" });
    expect(mapStructuredRecords([{ foo: "x", bar: "y" }], null)).toBeNull();
  });

  it("anahtar kelime filtresi sektörde veya adda arar (Türkçe harf farkı gözetmez)", () => {
    const { leads } = mapStructuredRecords(parseDataTableJson(DT_JSON)!, null)!;
    expect(parseListFilter("otomotiv, MAKİNA;  x ")).toEqual(["otomotiv", "MAKİNA"]);
    expect(applyListFilter(leads, parseListFilter("otomotiv, makina")).map((l) => l.companyName)).toEqual(["Acv Süspansiyon Sistemleri A.Ş.", "Yıldız Makina"]);
    expect(applyListFilter(leads, [])).toHaveLength(3);
  });

  it("uçtan uca: veri kaynağından AI kullanılmadan içe aktarılır, filtre uygulanır, kredi iade edilir", async () => {
    const a = await createTenant("A");
    const site = await startSite({ "/robots.txt": "User-agent: *\nAllow: /", "/list": DT_PAGE, "/data.json": DT_JSON });
    try {
      const ai = new MockAIProvider(() => JSON.stringify({ companies: [] }));
      __setAIProviderForTests(ai);
      const before = await balance(a.companyId);
      await startListImport(a, { url: `${site.url}/list`, filter: "otomotiv, makina" });
      await drainInlineJobs();
      expect(await getLastListImport(a)).toMatchObject({ status: "SUCCEEDED", structured: true, extracted: 5, dropped: 2, filteredOut: 1, created: 2 });
      expect(ai.calls).toHaveLength(0);
      expect(await balance(a.companyId)).toBe(before);
      expect((await rawDb.lead.findMany({ where: { companyId: a.companyId }, orderBy: { companyName: "asc" } })).map((l) => l.companyName)).toEqual([
        "Acv Süspansiyon Sistemleri A.Ş.",
        "Yıldız Makina",
      ]);
    } finally {
      site.server.close();
    }
  });
});
