import { describe, expect, it } from "vitest";
import {
  classifyFromSignals,
  classifyWithoutFetch,
  detectShopSignalsHtml,
  latestCopyrightYear,
  marketplaceOfHost,
} from "@/server/web/ecommerce";
import { computeReachability, ECOMMERCE_SIGNAL_FLOOR, finalizeScore, HAS_ECOMMERCE_SIGNAL_CAP, UNVERIFIED_CAPS } from "@/lib/lead-scoring";
import { parseLeadFilter } from "@/lib/lead-filter";

const NOW = new Date("2026-09-30T00:00:00Z");
const page = (html: string, url = "https://parca.test/") => detectShopSignalsHtml(html, new URL(url), NOW);
const MODERN_HEAD = '<head><meta name="viewport" content="width=device-width"></head>';

describe("e-ticaret tespiti — siteyi açmadan", () => {
  it("site yoksa NO_WEBSITE", () => {
    expect(classifyWithoutFetch(null)?.status).toBe("NO_WEBSITE");
    expect(classifyWithoutFetch("  ")?.status).toBe("NO_WEBSITE");
  });

  it("sosyal medya / kartvizit adresi SOCIAL_ONLY", () => {
    expect(classifyWithoutFetch("https://www.instagram.com/konyaparca")?.status).toBe("SOCIAL_ONLY");
    expect(classifyWithoutFetch("konya-oto.business.site")?.status).toBe("SOCIAL_ONLY");
  });

  it("pazaryeri mağaza adresi MARKETPLACE_ONLY ve pazaryeri adı", () => {
    const v = classifyWithoutFetch("https://www.trendyol.com/magaza/konya-oto-m-12345");
    expect(v?.status).toBe("MARKETPLACE_ONLY");
    expect(v?.marketplaces).toEqual(["Trendyol"]);
    expect(classifyWithoutFetch("https://kaanoto.sahibinden.com")?.marketplaces).toEqual(["Sahibinden"]);
  });

  it("gerçek site için karar vermez (siteyi açmak gerekir)", () => {
    expect(classifyWithoutFetch("https://konyaotoparca.com")).toBeNull();
  });

  it("pazaryeri alan adı eşleşmesi alt dizgiye kanmaz", () => {
    expect(marketplaceOfHost("www.hepsiburada.com")).toBe("Hepsiburada");
    expect(marketplaceOfHost("nottrendyol.com")).toBeNull();
    expect(marketplaceOfHost("n11.com.evil.test")).toBeNull();
  });
});

describe("e-ticaret tespiti — sayfa işaretleri", () => {
  it("altyapı izinden e-ticaret (Ticimax, WooCommerce)", () => {
    expect(page(`<html>${MODERN_HEAD}<body><script src="https://static.ticimax.cloud/x.js"></script></body></html>`).platform).toBe("Ticimax");
    expect(page(`<html>${MODERN_HEAD}<body class="woocommerce-page"></body></html>`).platform).toBe("WooCommerce");
  });

  it("\"microsoft\" kelimesi T-Soft sanılmaz", () => {
    expect(page(`<html>${MODERN_HEAD}<body>Microsoft Office</body></html>`).platform).toBeNull();
  });

  it("sepet bağlantısı ve sepete ekle düğmesi", () => {
    const s = page(`<html>${MODERN_HEAD}<body><a href="/sepetim">Sepet</a><button>Sepete Ekle</button></body></html>`);
    expect(s.cartUrl).toBe("https://parca.test/sepetim");
    expect(s.addToCart).toBe(true);
  });

  it("başka sitedeki sepet bağlantısı sayılmaz, pazaryeri bağlantısı toplanır", () => {
    const s = page(`<html>${MODERN_HEAD}<body><a href="https://www.trendyol.com/sr?mid=1">Trendyol mağazamız</a><a href="https://baska.test/cart">x</a></body></html>`);
    expect(s.cartUrl).toBeNull();
    expect(s.marketplaces.map((m) => m.name)).toEqual(["Trendyol"]);
  });

  it("eski site işaretleri: http, viewport yok, eski telif, jQuery 1.x", () => {
    const s = page(
      `<html><head><script src="/js/jquery-1.8.2.min.js"></script></head><body>© 2012-2017 Konya Oto</body></html>`,
      "http://parca.test/",
    );
    expect(s.issues).toEqual(expect.arrayContaining(["no_https", "no_viewport", "old_copyright", "old_jquery"]));
    expect(s.copyrightYear).toBe(2017);
  });

  it("script içindeki kütüphane lisans yılı eski telif sayılmaz", () => {
    const s = page(`<html>${MODERN_HEAD}<body><script>/*! Copyright 2012 jQuery Foundation */</script><footer>© 2026 Konya Oto</footer></body></html>`);
    expect(s.issues).not.toContain("old_copyright");
    expect(s.copyrightYear).toBe(2026);
  });

  it("güncel, mobil uyumlu site temiz", () => {
    expect(page(`<html>${MODERN_HEAD}<body>© 2025</body></html>`).issues).toEqual([]);
  });

  it("telif yılı: aralığın büyüğü, yoksa null", () => {
    expect(latestCopyrightYear("Copyright © 2009 - 2014 Tüm hakları saklıdır")).toBe(2014);
    expect(latestCopyrightYear("Telefon: 0332 2019 45 45")).toBeNull();
  });
});

describe("e-ticaret sınıflandırması", () => {
  const clean = { platform: null, cartUrl: null, addToCart: false, marketplaces: [], issues: [], copyrightYear: null };

  it("modern e-ticaret HAS_ECOMMERCE", () => {
    const v = classifyFromSignals([{ ...clean, platform: "İdeaSoft" }]);
    expect(v.status).toBe("HAS_ECOMMERCE");
    expect(v.platform).toBe("İdeaSoft");
  });

  it("eski e-ticaret (ağırlık ≥ 2) revizyon adayı", () => {
    expect(classifyFromSignals([{ ...clean, cartUrl: "https://a.test/sepet", issues: ["no_https"] }]).status).toBe("OUTDATED_ECOMMERCE");
    expect(classifyFromSignals([{ ...clean, addToCart: true, issues: ["old_copyright", "old_jquery"] }]).status).toBe("OUTDATED_ECOMMERCE");
    // Tek hafif eksik revizyon için yeterli değil
    expect(classifyFromSignals([{ ...clean, addToCart: true, issues: ["old_copyright"] }]).status).toBe("HAS_ECOMMERCE");
  });

  it("satış yok + pazaryeri bağlantısı MARKETPLACE_ONLY", () => {
    const v = classifyFromSignals([clean, { ...clean, marketplaces: [{ name: "N11", url: "https://n11.com/magaza/x" }] }]);
    expect(v.status).toBe("MARKETPLACE_ONLY");
    expect(v.marketplaces).toEqual(["N11"]);
  });

  it("satış ve pazaryeri yok INFO_SITE, eksikler gerekçede", () => {
    const v = classifyFromSignals([{ ...clean, issues: ["no_viewport"] }]);
    expect(v.status).toBe("INFO_SITE");
    expect(v.evidence).toContain("Mobil uyumlu değil");
  });
});

describe("e-ticaret fırsatı modunda puanlama", () => {
  const ai = { productFit: 20, industryFit: 15, sizeFit: 5, buyingSignal: 3 };
  const base = { verifiedSignalCount: 0, hasSizeData: false, researched: false, reachability: 8 };

  it("mod kapalıyken (durum verilmez) eski davranış: kanıtsız sinyal sınırlanır", () => {
    expect(finalizeScore({ ...ai, buyingSignal: 18 }, base).buyingSignal).toBe(UNVERIFIED_CAPS.buyingSignal);
  });

  it("ölçülmüş fırsat durumu satın alma sinyali tabanı verir", () => {
    expect(finalizeScore(ai, { ...base, ecommerceStatus: "MARKETPLACE_ONLY" }).buyingSignal).toBe(ECOMMERCE_SIGNAL_FLOOR.MARKETPLACE_ONLY);
    expect(finalizeScore(ai, { ...base, ecommerceStatus: "NO_WEBSITE" }).buyingSignal).toBe(ECOMMERCE_SIGNAL_FLOOR.NO_WEBSITE);
  });

  it("modern e-ticareti olan firmanın sinyali sınırlanır", () => {
    const s = finalizeScore({ ...ai, buyingSignal: 18 }, { ...base, ecommerceStatus: "HAS_ECOMMERCE" });
    expect(s.buyingSignal).toBe(HAS_ECOMMERCE_SIGNAL_CAP);
    expect(s.capped).toContain("buyingSignal");
  });

  it("telefon öncelikli ulaşılabilirlik: sitesiz ama telefonlu esnaf düşük puan almaz", () => {
    expect(computeReachability({ phone: "+903320000000" }, "phone_first")).toBe(8);
    expect(computeReachability({ phone: "+903320000000" })).toBe(4);
    expect(computeReachability({ website: "x.com" }, "phone_first")).toBe(0);
  });
});

describe("lead filtresi", () => {
  it("ecom parametresi yalnızca bilinen değerleri kabul eder", () => {
    expect(parseLeadFilter((k) => (k === "ecom" ? "revision" : null)).ecom).toBe("revision");
    expect(parseLeadFilter((k) => (k === "ecom" ? "xyz" : null)).ecom).toBeUndefined();
  });
});
