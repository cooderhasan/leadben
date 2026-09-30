import { describe, expect, it } from "vitest";
import { isPrivateAddress, normalizeUrl } from "@/server/web/ssrf";
import { extractPage, isAllowedByRobots, parseRobots, rankLinks } from "@/server/web/fetch-site";
import { chunkText } from "@/server/knowledge/chunker";
import { parseJsonFromText } from "@/server/ai/json";
import { evidenceFound, valueFound } from "@/server/services/evidence";
import { buildFactDrafts } from "@/server/services/website-analysis-result";
import { websiteAnalysisSchema } from "@/server/ai/prompts/website-analysis";
import { estimateCostUsd } from "@/server/ai/pricing";
import { hashPassword, validatePasswordStrength, verifyPassword } from "@/server/auth/password";
import { parseMoney, productionInfoSchema, parseSpecs, salesInfoSchema, specsToText } from "@/lib/validation";
import { normalizeCompanyName, slugify } from "@/lib/slug";
import { can } from "@/server/tenancy/permissions";

describe("SSRF koruması", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
  ])("%s özel adres", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700::1111"])("%s genel adres", (ip) =>
    expect(isPrivateAddress(ip)).toBe(false),
  );

  it("URL normalize eder ve geçersizleri reddeder", () => {
    expect(normalizeUrl("aktifyay.com.tr").toString()).toBe("https://aktifyay.com.tr/");
    expect(normalizeUrl("http://x.com/a#b").toString()).toBe("http://x.com/a");
    expect(() => normalizeUrl("ftp://x.com")).toThrow();
    expect(() => normalizeUrl("javascript:alert(1)")).toThrow();
    expect(() => normalizeUrl("http://user:pass@x.com")).toThrow();
    expect(() => normalizeUrl("localhost")).toThrow();
  });
});

describe("robots.txt", () => {
  const txt = `User-agent: *\nDisallow: /admin\nDisallow: /private/\n\nUser-agent: AISalesOS-SiteAnalyzer\nDisallow: /urunler`;
  it("bota özel kuralı uygular", () => {
    const rules = parseRobots(txt, "AISalesOS-SiteAnalyzer/1.0");
    expect(isAllowedByRobots("/urunler/yay", rules)).toBe(false);
    expect(isAllowedByRobots("/admin", rules)).toBe(true);
  });
  it("genel kuralı uygular", () => {
    const rules = parseRobots(txt, "BaskaBot/1.0");
    expect(isAllowedByRobots("/admin/x", rules)).toBe(false);
    expect(isAllowedByRobots("/hakkimizda", rules)).toBe(true);
  });
  it("Disallow: / tüm siteyi engeller", () => {
    expect(isAllowedByRobots("/", parseRobots("User-agent: *\nDisallow: /", "x"))).toBe(false);
  });
  it("joker karakterli kural tüm siteyi engellemez", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /*?\nDisallow: /*.pdf$\nDisallow: /wp-admin/", "x");
    expect(isAllowedByRobots("/", rules)).toBe(true);
    expect(isAllowedByRobots("/urunler", rules)).toBe(true);
    expect(isAllowedByRobots("/urunler?s=yay", rules)).toBe(false);
    expect(isAllowedByRobots("/katalog.pdf", rules)).toBe(false);
    expect(isAllowedByRobots("/katalog.pdf.html", rules)).toBe(true);
    expect(isAllowedByRobots("/wp-admin/x", rules)).toBe(false);
  });
  it("Allow kuralı ve boş Disallow dikkate alınır", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /\nAllow: /$\nAllow: /hakkimizda", "x");
    expect(isAllowedByRobots("/", rules)).toBe(true);
    expect(isAllowedByRobots("/hakkimizda", rules)).toBe(true);
    expect(isAllowedByRobots("/gizli", rules)).toBe(false);
    expect(isAllowedByRobots("/x", parseRobots("User-agent: *\nDisallow:", "x"))).toBe(true);
  });
});

describe("sayfa içeriği çıkarma", () => {
  const html = `<html><head><title>Aktif Yay | Basma Yay</title><meta name="description" content="Endüstriyel yay"></head>
    <body><nav><a href="/hakkimizda">Hakkımızda</a><a href="/urunler/basma-yay">Basma</a><a href="https://baska.com/x">dış</a>
    <a href="mailto:info@aktifyay.test">mail</a><a href="tel:+902121234567">tel</a></nav>
    <h1>Basma Yay Üretimi</h1><script>var x = "gizli";</script><p>Satış: satis@aktifyay.test · 0212 123 45 67</p></body></html>`;
  const page = extractPage(html, new URL("https://aktifyay.test/"));
  it("başlık, meta, başlıklar, iletişim ve iç linkleri alır", () => {
    expect(page.title).toBe("Aktif Yay | Basma Yay");
    expect(page.metaDescription).toBe("Endüstriyel yay");
    expect(page.headings).toContain("Basma Yay Üretimi");
    expect(page.emails).toEqual(expect.arrayContaining(["info@aktifyay.test", "satis@aktifyay.test"]));
    expect(page.phones.length).toBeGreaterThan(0);
    expect(page.links).toContain("https://aktifyay.test/hakkimizda");
    expect(page.links.some((l) => l.includes("baska.com"))).toBe(false);
    expect(page.text).not.toContain("gizli");
  });
  it("öncelikli sayfaları sıralar", () => {
    const ranked = rankLinks(
      ["https://a.test/blog/haber", "https://a.test/urunler", "https://a.test/hakkimizda", "https://a.test/katalog.pdf"],
      new URL("https://a.test/"),
    );
    expect(ranked[0]).toBe("https://a.test/hakkimizda");
    expect(ranked).toContain("https://a.test/urunler");
    expect(ranked).not.toContain("https://a.test/katalog.pdf");
    expect(ranked).not.toContain("https://a.test/blog/haber");
  });
});

describe("chunker", () => {
  it("boş metinde parça üretmez", () => expect(chunkText("   ")).toEqual([]));
  it("uzun metni sınırlar içinde ve örtüşmeli parçalar", () => {
    const para = "Basma yaylar otomotiv sektöründe kullanılır. ".repeat(40);
    const text = Array.from({ length: 6 }, (_, i) => `Bölüm ${i}. ${para}`).join("\n\n");
    const chunks = chunkText(text, { target: 1200, overlap: 150 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(2400 + 200);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
    expect(chunks.every((c) => c.tokenCount > 0)).toBe(true);
  });
});

describe("AI JSON ayrıştırma", () => {
  it("kod bloğu ve açıklama metnini tolere eder", () => {
    expect(parseJsonFromText('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonFromText('İşte sonuç: {"a": [1,2]} umarım yardımcı olur')).toEqual({ a: [1, 2] });
    expect(parseJsonFromText("[1,2]")).toEqual([1, 2]);
    expect(() => parseJsonFromText("json yok")).toThrow();
  });
});

describe("kanıt kontrolü", () => {
  const corpus = "Firmamız ISO 9001:2015 ve IATF 16949 belgelerine sahiptir. Yıllık 12 milyon adet yay üretim kapasitesi.";
  it("alıntıyı Türkçe karakter ve boşluk farklarına rağmen bulur", () => {
    expect(evidenceFound("ISO 9001:2015 ve IATF 16949 belgelerine sahiptir", corpus)).toBe(true);
    expect(evidenceFound("yillik 12 milyon adet yay", corpus)).toBe(true);
    expect(evidenceFound("AS9100 havacılık sertifikası", corpus)).toBe(false);
    expect(valueFound("IATF 16949", corpus)).toBe(true);
    expect(valueFound("ISO 14001", corpus)).toBe(false);
  });
});

describe("web analizi → fact taslakları", () => {
  const crawl = {
    homeUrl: "https://a.test/",
    skipped: [],
    pages: [
      {
        url: "https://a.test/",
        title: "Aktif Yay",
        metaDescription: "",
        headings: ["Basma Yay"],
        text: "Aktif Yay basma yay ve çekme yay üretir. ISO 9001 belgelidir. Otomotiv sektörüne hizmet veriyoruz.",
        links: [],
        emails: ["info@a.test"],
        phones: [],
        hasContactForm: false,
      },
    ],
  };
  const output = websiteAnalysisSchema.parse({
    summary: "Aktif Yay endüstriyel yay üreten bir B2B üreticidir.",
    companyDescription: "Endüstriyel yay üreticisi",
    businessModel: "B2B",
    sector: "Yay üretimi",
    subSector: null,
    products: [{ name: "Basma yay", sourceUrl: "https://a.test/", evidence: "basma yay" }],
    industriesServed: [
      { value: "Otomotiv", sourceUrl: "https://a.test/", evidence: "Otomotiv sektörüne hizmet veriyoruz", inferred: false },
      { value: "Beyaz eşya", inferred: true },
    ],
    certifications: [
      { value: "ISO 9001", evidence: "ISO 9001 belgelidir" },
      { value: "IATF 16949", evidence: "IATF 16949 sertifikalı" }, // sayfada YOK → atılmalı
    ],
    productionCapacity: { value: "Yılda 50 milyon adet", evidence: "50 milyon" }, // sayfada YOK → atılmalı
  });
  const drafts = buildFactDrafts(output, crawl);
  const byKey = (k: string) => drafts.filter((d) => d.key === k).map((d) => d.value);

  it("kanıtsız sertifika ve kapasiteyi atar", () => {
    expect(byKey("certification")).toEqual(["ISO 9001"]);
    expect(byKey("production_capacity")).toEqual([]);
  });
  it("AI çıkarımını ayrı işaretler", () => {
    const inferred = drafts.find((d) => d.value === "Beyaz eşya");
    expect(inferred?.source).toBe("AI_INFERRED");
    expect(inferred?.confidence).toBe(0.5);
    const verified = drafts.find((d) => d.value === "Otomotiv");
    expect(verified?.source).toBe("WEBSITE");
    expect(verified?.confidence).toBe(0.9);
  });
  it("deterministik e-posta ve SEO başlığını ekler", () => {
    expect(byKey("contact_email")).toEqual(["info@a.test"]);
    expect(byKey("seo_title")).toEqual(["Aktif Yay"]);
  });
});

describe("parola", () => {
  it("hash doğrular, yanlış parolayı reddeder", async () => {
    const h = await hashPassword("dogruParola123");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("dogruParola123", h)).toBe(true);
    expect(await verifyPassword("yanlisParola123", h)).toBe(false);
    expect(await verifyPassword("x", "bozuk-hash")).toBe(false);
  });
  it("zayıf parolayı reddeder", () => {
    expect(validatePasswordStrength("kisa1")).not.toBeNull();
    expect(validatePasswordStrength("sadeceharfler")).not.toBeNull();
    expect(validatePasswordStrength("iyiParola2026")).toBeNull();
  });
});

describe("form doğrulama", () => {
  it("TR para biçimi ve listeleri ayrıştırır", () => {
    const r = salesInfoSchema.parse({ currency: "TRY", avgSaleValue: "50.000", monthlySalesTarget: "500.000,50", existingCustomerTypes: "OEM, Yan sanayi" });
    expect(r.avgSaleValue).toBe(50000);
    expect(r.monthlySalesTarget).toBe(500000.5);
    expect(r.existingCustomerTypes).toEqual(["OEM", "Yan sanayi"]);
  });
  it.each([
    ["50.000", 50000], ["1.234.567", 1234567], ["500.000,50", 500000.5], ["1,5", 1.5], ["1250.5", 1250.5],
    ["500,000.50", 500000.5], ["12,000", 12000], ["₺ 75.000", 75000], ["3 TL", 3],
  ] as const)("parseMoney(%s) = %s", (input, expected) => expect(parseMoney(input)).toBe(expected));
  it("ürün adlarını yalnızca satır sonundan böler", () => {
    const r = productionInfoSchema.parse({ productNames: "Basma yay, paslanmaz\nÇekme yay", certifications: "ISO 9001, IATF 16949", customManufacturing: "yes" });
    expect(r.productNames).toEqual(["Basma yay, paslanmaz", "Çekme yay"]);
    expect(r.certifications).toEqual(["ISO 9001", "IATF 16949"]);
    expect(r.customManufacturing).toBe(true);
  });
  it("teknik özellik metni ↔ nesne", () => {
    const s = parseSpecs("Tel çapı: 0,5–8 mm\nMalzeme: Paslanmaz: 302\nbozuk satır");
    expect(s).toEqual({ "Tel çapı": "0,5–8 mm", Malzeme: "Paslanmaz: 302" });
    expect(specsToText(s)).toBe("Tel çapı: 0,5–8 mm\nMalzeme: Paslanmaz: 302");
  });
});

describe("yardımcılar", () => {
  it("slug ve firma adı normalizasyonu", () => {
    expect(slugify("Aktif Yay San. ve Tic. A.Ş.")).toBe("aktif-yay-san-ve-tic-a-s");
    expect(normalizeCompanyName("ABC Otomotiv San. ve Tic. Ltd. Şti.")).toBe("abc-otomotiv");
  });
  it("maliyet tahmini", () => {
    expect(estimateCostUsd("claude-sonnet-5", 1_000_000, 0)).toBe(3);
    expect(estimateCostUsd("claude-haiku-4-5-20251001", 0, 1_000_000)).toBe(5);
  });
  it("yetki tablosu", () => {
    expect(can({ role: "VIEWER", isPlatformAdmin: false }, "product.write")).toBe(false);
    expect(can({ role: "MEMBER", isPlatformAdmin: false }, "product.write")).toBe(true);
    expect(can({ role: "MEMBER", isPlatformAdmin: false }, "member.manage")).toBe(false);
    expect(can({ role: "VIEWER", isPlatformAdmin: true }, "member.manage")).toBe(true);
  });
});

describe("middleware herkese açık yollar", () => {
  it("ret bağlantısı, webhook ve zamanlayıcı giriş istemez; uygulama sayfaları ister", async () => {
    const { isPublicPath } = await import("@/middleware");
    for (const p of ["/", "/login", "/register", "/u/abc.def.ghi", "/api/unsubscribe/abc.def.ghi", "/api/webhooks/email/resend", "/api/webhooks/email/inbound", "/api/cron/tick"]) {
      expect(isPublicPath(p), p).toBe(true);
    }
    for (const p of ["/dashboard", "/leads", "/admin", "/api/jobs/x", "/users", "/login-fake", "/uploads"]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });
});

describe("AI hata açıklaması", () => {
  it("yapılandırma hatalarını anlaşılır nedene çevirir", async () => {
    const { describeProviderError } = await import("@/server/ai");
    const { AIProviderError } = await import("@/server/ai/types");
    expect(describeProviderError(new AIProviderError('anthropic 401: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', "anthropic", 401))).toMatch(/anahtarı geçersiz/);
    expect(describeProviderError(new AIProviderError("anthropic 400: Your credit balance is too low to access the Anthropic API.", "anthropic", 400))).toMatch(/bakiye/);
    expect(describeProviderError(new AIProviderError("anthropic 404: not_found_error model: x", "anthropic", 404))).toMatch(/modeline erişim/);
    expect(describeProviderError(new AIProviderError("anthropic bağlantı hatası: fetch failed", "anthropic", undefined, true))).toMatch(/ulaşılamıyor/);
  });
});

describe("AI maliyet tahmini (OpenRouter adları)", () => {
  it("sağlayıcı önekini tanır, ücretsiz modeli 0 sayar", async () => {
    const { estimateCostUsd } = await import("@/server/ai/pricing");
    expect(estimateCostUsd("anthropic/claude-haiku-4.5", 1_000_000, 0)).toBe(1);
    expect(estimateCostUsd("anthropic/claude-sonnet-4.5", 1_000_000, 0)).toBe(3);
    expect(estimateCostUsd("meta-llama/llama-3.3-70b-instruct:free", 1_000_000, 1_000_000)).toBe(0);
    expect(estimateCostUsd("claude-haiku-4-5-20251001", 1_000_000, 0)).toBe(1);
  });
});
