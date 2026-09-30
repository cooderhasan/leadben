import * as cheerio from "cheerio";
import type { EcommerceStatus } from "@prisma/client";

/**
 * E-ticaret durumu tespiti (e-ticaret fırsatı modu). AI KULLANILMAZ: karar sitenin kodundaki
 * ölçülebilir işaretlere dayanır (altyapı izi, sepet bağlantısı, pazaryeri bağlantısı, eski site işaretleri).
 * Böylece "e-ticareti yok" iddiası uydurulamaz; her karar gerekçesiyle (evidence) saklanır.
 */

// ── Altyapı izleri ─────────────────────────────────────────────────────

/** HTML (küçük harf) içinde aranır. Sıra önemli: özel Türk altyapıları genel olanlardan önce. */
const PLATFORMS: Array<[string, RegExp]> = [
  ["Ticimax", /ticimax/],
  ["İdeaSoft", /ideasoft|myideasoft/],
  ["ikas", /myikas\.com|ikas\.com\/|cdn\.ikas/],
  ["T-Soft", /\bt-soft\b|tsoftstatic|\/tsoft/],
  ["Projesoft", /projesoft/],
  ["Faprika", /faprika/],
  ["PlatinMarket", /platinmarket/],
  ["Shopier", /shopier\.com/],
  ["Shopify", /cdn\.shopify\.com|shopify\.theme/],
  ["WooCommerce", /woocommerce/],
  ["OpenCart", /route=checkout\/cart|route=product\/product|catalog\/view\/theme/],
  ["PrestaShop", /prestashop/],
  ["Magento", /mage\/cookies|magento/],
  ["Wix Stores", /wixstores|wix-ecommerce/],
];

/** Kendi sitesindeki sepet / ödeme yolları */
const CART_PATH = /\/(sepet|sepetim|cart|basket|checkout|odeme|sepete-ekle|shopping-cart)(\/|\.|\?|$)/i;
/** Ürün satın alma düğmesi metinleri */
const ADD_TO_CART = /sepete ekle|sepete at|add to cart|sepetim/i;

// ── Pazaryerleri ───────────────────────────────────────────────────────

const MARKETPLACES: Array<[string, RegExp]> = [
  ["Trendyol", /(^|\.)trendyol\.com$/],
  ["Hepsiburada", /(^|\.)hepsiburada\.com$/],
  ["N11", /(^|\.)n11\.com$/],
  ["Amazon", /(^|\.)amazon\.com\.tr$/],
  ["Çiçeksepeti", /(^|\.)ciceksepeti\.com$/],
  ["PttAVM", /(^|\.)pttavm\.com$/],
  ["Sahibinden", /(^|\.)sahibinden\.com$/],
];

/** Web sitesi yerine girilen sosyal medya / kartvizit adresleri */
const SOCIAL_HOST = /(^|\.)(instagram\.com|facebook\.com|fb\.com|linkedin\.com|twitter\.com|x\.com|youtube\.com|tiktok\.com|wa\.me|whatsapp\.com|google\.com|business\.site|linktr\.ee|g\.page)$/i;

export function marketplaceOfHost(host: string): string | null {
  const h = host.toLowerCase().replace(/^www\./, "");
  return MARKETPLACES.find(([, re]) => re.test(h))?.[0] ?? null;
}

function hostOf(website: string): string {
  try {
    return new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

// ── Eski / kötü site işaretleri ────────────────────────────────────────

export const SITE_ISSUE_LABELS = {
  no_https: "HTTPS (SSL) yok",
  no_viewport: "Mobil uyumlu değil",
  old_copyright: "Uzun süredir güncellenmemiş (eski telif yılı)",
  old_jquery: "Eski JavaScript kütüphanesi (jQuery 1.x)",
  flash: "Flash içerik",
  old_ie: "Eski Internet Explorer uyumluluk kodu",
  old_wordpress: "Eski WordPress sürümü",
} as const;
export type SiteIssue = keyof typeof SITE_ISSUE_LABELS;

/** Ağırlık ≥ 2 olan e-ticaret sitesi "revizyon adayı" sayılır */
const ISSUE_WEIGHT: Record<SiteIssue, number> = {
  no_https: 2,
  no_viewport: 2,
  flash: 2,
  old_ie: 2,
  old_copyright: 1,
  old_jquery: 1,
  old_wordpress: 1,
};
export const OUTDATED_THRESHOLD = 2;

export function issueWeight(issues: readonly string[]): number {
  return issues.reduce((s, i) => s + (ISSUE_WEIGHT[i as SiteIssue] ?? 0), 0);
}

// ── Sayfa sinyalleri ───────────────────────────────────────────────────

export interface ShopSignals {
  platform: string | null;
  /** Sepet / ödeme bağlantısı (ilk bulunan) */
  cartUrl: string | null;
  addToCart: boolean;
  marketplaces: Array<{ name: string; url: string }>;
  issues: SiteIssue[];
  /** Sayfadaki en yeni telif yılı (varsa) */
  copyrightYear: number | null;
}

/**
 * Tek sayfanın e-ticaret işaretleri. `$` metin çıkarılmadan ÖNCE verilmelidir (script etiketleri gerekir).
 * Saf fonksiyon.
 */
export function detectShopSignals($: cheerio.CheerioAPI, html: string, pageUrl: URL, now = new Date()): ShopSignals {
  const lower = html.toLowerCase();
  const platform = PLATFORMS.find(([, re]) => re.test(lower))?.[0] ?? null;

  let cartUrl: string | null = null;
  const marketplaces = new Map<string, string>();
  $("a[href]").each((_, el) => {
    let u: URL;
    try {
      u = new URL($(el).attr("href") ?? "", pageUrl);
    } catch {
      return;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return;
    const mp = marketplaceOfHost(u.hostname);
    if (mp && !marketplaces.has(mp)) marketplaces.set(mp, `${u.origin}${u.pathname}`);
    if (!cartUrl && hostOf(u.hostname) === hostOf(pageUrl.hostname) && CART_PATH.test(decodeURIComponentSafe(u.pathname))) cartUrl = u.toString();
  });
  const buttons = $("button, a, input[type='submit'], input[type='button']")
    .map((_, el) => `${$(el).text()} ${$(el).attr("value") ?? ""} ${$(el).attr("title") ?? ""}`)
    .get()
    .join(" ");
  const addToCart = ADD_TO_CART.test(buttons);

  const issues: SiteIssue[] = [];
  if (pageUrl.protocol === "http:") issues.push("no_https");
  if ($("meta[name='viewport' i]").length === 0 && !/name=["']?viewport/i.test(html)) issues.push("no_viewport");
  // Script içindeki kütüphane lisansları ("Copyright 2012 jQuery…") sayılmaz → yalnızca görünür metin
  const visible = $("body").clone();
  visible.find("script, style, noscript, template").remove();
  const copyrightYear = latestCopyrightYear(visible.text());
  if (copyrightYear !== null && copyrightYear <= now.getFullYear() - 3) issues.push("old_copyright");
  if (/jquery[-.]?1\.\d|jquery\/1\.\d|jquery\.min\.js\?ver=1\./.test(lower)) issues.push("old_jquery");
  if (/\.swf\b|shockwave-flash/.test(lower)) issues.push("flash");
  if (/ie=(emulateie)?[5-8]\b/.test(lower)) issues.push("old_ie");
  const wp = $("meta[name='generator' i]").attr("content")?.match(/wordpress\s+(\d+)/i);
  if (wp && Number(wp[1]) < 5) issues.push("old_wordpress");

  return { platform, cartUrl, addToCart, marketplaces: [...marketplaces].map(([name, url]) => ({ name, url })), issues, copyrightYear };
}

/** Test kolaylığı için: HTML'den doğrudan */
export function detectShopSignalsHtml(html: string, pageUrl: URL, now = new Date()): ShopSignals {
  return detectShopSignals(cheerio.load(html), html, pageUrl, now);
}

function decodeURIComponentSafe(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** "© 2012-2016", "Copyright 2019" → en büyük yıl. Yıl aralığı yoksa null. */
export function latestCopyrightYear(text: string): number | null {
  let max: number | null = null;
  for (const m of text.matchAll(/(?:©|\(c\)|copyright|telif)\s*(?:[^\d\n]{0,20})?((?:19|20)\d{2})(?:\s*[-–]\s*((?:19|20)\d{2}))?/gi)) {
    for (const y of [m[1], m[2]]) {
      const n = Number(y);
      if (y && n >= 1995 && n <= 2100 && (max === null || n > max)) max = n;
    }
  }
  return max;
}

// ── Sınıflandırma ──────────────────────────────────────────────────────

export interface EcommerceVerdict {
  status: EcommerceStatus;
  platform: string | null;
  marketplaces: string[];
  issues: SiteIssue[];
  /** Kullanıcıya gösterilen gerekçe (kanıt) */
  evidence: string;
}

/**
 * Siteyi açmadan karar verilebilen durumlar: site yok / yalnızca sosyal medya / pazaryeri mağaza adresi.
 * Siteyi açmak gerekiyorsa null döner.
 */
export function classifyWithoutFetch(website: string | null | undefined): EcommerceVerdict | null {
  if (!website?.trim()) return { status: "NO_WEBSITE", platform: null, marketplaces: [], issues: [], evidence: "Kayıtlı web sitesi yok." };
  const host = hostOf(website);
  if (!host) return { status: "NO_WEBSITE", platform: null, marketplaces: [], issues: [], evidence: "Kayıtlı web adresi geçersiz." };
  const mp = marketplaceOfHost(host);
  if (mp) return { status: "MARKETPLACE_ONLY", platform: null, marketplaces: [mp], issues: [], evidence: `Web sitesi yerine ${mp} mağazası kayıtlı.` };
  if (SOCIAL_HOST.test(host)) return { status: "SOCIAL_ONLY", platform: null, marketplaces: [], issues: [], evidence: `Web sitesi yerine sosyal medya / kartvizit sayfası kayıtlı (${host}).` };
  return null;
}

/** Taranan sayfaların sinyallerinden karar. Saf fonksiyon. */
export function classifyFromSignals(pages: ShopSignals[]): EcommerceVerdict {
  const platform = pages.find((p) => p.platform)?.platform ?? null;
  const cartUrl = pages.find((p) => p.cartUrl)?.cartUrl ?? null;
  const addToCart = pages.some((p) => p.addToCart);
  const marketplaces = [...new Set(pages.flatMap((p) => p.marketplaces.map((m) => m.name)))];
  // Eski site işaretleri ana sayfadan (ilk sayfa) alınır; HTTPS her sayfada aynıdır
  const issues = pages[0]?.issues ?? [];
  const shop = Boolean(platform || cartUrl || addToCart);

  if (shop) {
    const why = platform ? `${platform} altyapısı` : cartUrl ? `sepet bağlantısı (${new URL(cartUrl).pathname})` : "\"Sepete ekle\" düğmesi";
    const outdated = issueWeight(issues) >= OUTDATED_THRESHOLD;
    return {
      status: outdated ? "OUTDATED_ECOMMERCE" : "HAS_ECOMMERCE",
      platform,
      marketplaces,
      issues,
      evidence: outdated
        ? `E-ticaret sitesi var (${why}) ama eski: ${issues.map((i) => SITE_ISSUE_LABELS[i]).join(", ")}.`
        : `E-ticaret sitesi var: ${why}.`,
    };
  }
  if (marketplaces.length) {
    return { status: "MARKETPLACE_ONLY", platform: null, marketplaces, issues, evidence: `Kendi sitesinde satış yok; ${marketplaces.join(", ")} mağazasına bağlantı var.` };
  }
  return {
    status: "INFO_SITE",
    platform: null,
    marketplaces,
    issues,
    evidence: issues.length
      ? `Tanıtım sitesi, satış yok. Eksikler: ${issues.map((i) => SITE_ISSUE_LABELS[i]).join(", ")}.`
      : "Tanıtım sitesi var, sepet / online satış yok.",
  };
}

// ── Etiketler ve fırsat grupları ────────────────────────────────────────

export const ECOMMERCE_STATUS_LABELS: Record<EcommerceStatus, string> = {
  NO_WEBSITE: "Sitesi yok",
  SOCIAL_ONLY: "Yalnızca sosyal medya",
  SITE_DOWN: "Sitesi açılmıyor",
  INFO_SITE: "Tanıtım sitesi (satış yok)",
  MARKETPLACE_ONLY: "Yalnızca pazaryerinde",
  OUTDATED_ECOMMERCE: "Eski e-ticaret (revizyon)",
  HAS_ECOMMERCE: "E-ticareti var",
};

export const ECOMMERCE_STATUS_TONE: Record<EcommerceStatus, "success" | "warning" | "accent" | "neutral"> = {
  NO_WEBSITE: "success",
  SOCIAL_ONLY: "success",
  SITE_DOWN: "success",
  INFO_SITE: "success",
  MARKETPLACE_ONLY: "accent",
  OUTDATED_ECOMMERCE: "warning",
  HAS_ECOMMERCE: "neutral",
};

/** Satılabilir durumlar (modern e-ticareti olanlar hariç her şey) */
export const OPPORTUNITY_STATUSES: EcommerceStatus[] = ["NO_WEBSITE", "SOCIAL_ONLY", "SITE_DOWN", "INFO_SITE", "MARKETPLACE_ONLY", "OUTDATED_ECOMMERCE"];
