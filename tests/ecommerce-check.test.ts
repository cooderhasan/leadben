import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { rawDb } from "@/server/db";
import { checkLeadsEcommerce, queueEcommerceCheckAfterImport, setEcommerceProspecting, startEcommerceCheck } from "@/server/services/ecommerce-check";
import { listLeads, saveDiscoveredLeads, updateLeadContactInfo, type EcomFilter } from "@/server/services/leads";
import { normalizeCompanyName } from "@/lib/lead-normalize";
import type { TenantContext } from "@/server/tenancy/types";
import { createTenant, resetDb, startSite } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await rawDb.$disconnect();
});

async function lead(ctx: TenantContext, name: string, website: string | null, extra: Record<string, unknown> = {}) {
  return rawDb.lead.create({
    data: { companyId: ctx.companyId, companyName: name, normalizedName: normalizeCompanyName(name), website, ...extra },
  });
}

const ALLOW = "User-agent: *\nAllow: /";

describe("site kontrolü (gerçek HTTP, AI'sız)", () => {
  it("tanıtım sitesi, pazaryeri bağlantısı ve e-ticaret sitesini ayırır", async () => {
    const ctx = await createTenant("Satıcı");
    const info = await startSite({ "/robots.txt": ALLOW, "/": "<html><body><h1>Konya Oto Parça</h1><p>Tel: 0332 000 00 00</p></body></html>" });
    const mp = await startSite({ "/robots.txt": ALLOW, "/": "<html><body><a href='https://www.trendyol.com/magaza/x-m-1'>Trendyol mağazamız</a></body></html>" });
    const shop = await startSite({ "/robots.txt": ALLOW, "/": "<html><body class='woocommerce'><a href='/sepet'>Sepet</a></body></html>" });
    try {
      const a = await lead(ctx, "Tanıtımcı", `${info.url}/`);
      const b = await lead(ctx, "Pazaryerci", `${mp.url}/`);
      const c = await lead(ctx, "Mağazacı", `${shop.url}/`);
      const res = await checkLeadsEcommerce(ctx.companyId, [a.id, b.id, c.id]);
      expect(res.total).toBe(3);

      const get = (id: string) => rawDb.lead.findUniqueOrThrow({ where: { id } });
      const [sa, sb, sc] = await Promise.all([get(a.id), get(b.id), get(c.id)]);
      expect(sa.ecommerceStatus).toBe("INFO_SITE");
      expect(sa.siteIssues).toContain("no_https");
      expect(sb.ecommerceStatus).toBe("MARKETPLACE_ONLY");
      expect(sb.marketplaces).toEqual(["Trendyol"]);
      // Test sunucusu http: ödeme alan ama HTTPS'siz site revizyon adayıdır
      expect(sc.ecommerceStatus).toBe("OUTDATED_ECOMMERCE");
      expect(sc.ecommercePlatform).toBe("WooCommerce");
      expect(sc.ecommerceCheckedAt).not.toBeNull();
    } finally {
      info.server.close();
      mp.server.close();
      shop.server.close();
    }
  });

  it("robots.txt yasağında karar verilmez, açılmayan site SITE_DOWN", async () => {
    const ctx = await createTenant("Satıcı");
    const blocked = await startSite({ "/robots.txt": "User-agent: *\nDisallow: /", "/": "<html><body>x</body></html>" });
    try {
      const a = await lead(ctx, "Yasaklı", `${blocked.url}/`);
      const b = await lead(ctx, "Kapalı", "http://127.0.0.1:1/");
      const res = await checkLeadsEcommerce(ctx.companyId, [a.id, b.id]);
      expect(res.blocked).toBe(1);
      expect((await rawDb.lead.findUniqueOrThrow({ where: { id: a.id } })).ecommerceStatus).toBeNull();
      expect((await rawDb.lead.findUniqueOrThrow({ where: { id: b.id } })).ecommerceStatus).toBe("SITE_DOWN");
    } finally {
      blocked.server.close();
    }
  });

  it("başka şirketin lead'ine dokunmaz (tenant izolasyonu)", async () => {
    const a = await createTenant("A");
    const b = await createTenant("B");
    const foreign = await lead(b, "B'nin firması", null);
    const res = await checkLeadsEcommerce(a.companyId, [foreign.id]);
    expect(res.total).toBe(0);
    expect((await rawDb.lead.findUniqueOrThrow({ where: { id: foreign.id } })).ecommerceStatus).toBeNull();
    await expect(startEcommerceCheck(a, [foreign.id])).rejects.toThrow(/seçin/);
  });

  it("izleyici rolü kontrol başlatamaz, mod ayarını yalnızca yönetici değiştirir", async () => {
    const viewer = await createTenant("V", "VIEWER");
    await expect(startEcommerceCheck(viewer, ["x"])).rejects.toThrow(/yetkiniz yok/);
    const member = await createTenant("M", "MEMBER");
    await expect(setEcommerceProspecting(member, true)).rejects.toThrow(/yetkiniz yok/);
  });
});

describe("kayıt ve filtre", () => {
  it("sitesiz / sosyal medyalı lead kaydedilirken siteye bakmadan işaretlenir", async () => {
    const ctx = await createTenant("Satıcı");
    const res = await saveDiscoveredLeads(
      ctx.companyId,
      [
        { companyName: "Sitesiz Oto", phone: "0332 111 11 11", sourceType: "GOOGLE_MAPS" },
        { companyName: "İnstagramcı Oto", website: "https://instagram.com/oto", sourceType: "GOOGLE_MAPS" },
        { companyName: "Siteli Oto", website: "https://siteli-oto.test", sourceType: "GOOGLE_MAPS" },
      ],
      { provider: "apify" },
    );
    const rows = await rawDb.lead.findMany({ where: { id: { in: res.leadIds } }, orderBy: { companyName: "asc" } });
    expect(Object.fromEntries(rows.map((r) => [r.companyName, r.ecommerceStatus]))).toEqual({
      "İnstagramcı Oto": "SOCIAL_ONLY",
      "Siteli Oto": null,
      "Sitesiz Oto": "NO_WEBSITE",
    });
  });

  it("site adresi değişince eski sonuç silinir", async () => {
    const ctx = await createTenant("Satıcı");
    const l = await lead(ctx, "Firma", "https://eski.test", { ecommerceStatus: "HAS_ECOMMERCE", ecommercePlatform: "Ticimax", siteIssues: ["no_https"] });
    await updateLeadContactInfo(ctx, { id: l.id, website: "https://yeni.test" });
    const saved = await rawDb.lead.findUniqueOrThrow({ where: { id: l.id } });
    expect(saved.ecommerceStatus).toBeNull();
    expect(saved.ecommercePlatform).toBeNull();
    expect(saved.siteIssues).toEqual([]);
    // Telefon düzeltmesi durumu bozmaz
    await rawDb.lead.update({ where: { id: l.id }, data: { ecommerceStatus: "INFO_SITE" } });
    await updateLeadContactInfo(ctx, { id: l.id, phone: "0332 222 22 22" });
    expect((await rawDb.lead.findUniqueOrThrow({ where: { id: l.id } })).ecommerceStatus).toBe("INFO_SITE");
  });

  it("fırsat filtresi modern e-ticareti gizler, kontrol edilmemişleri gösterir; arama ile birlikte çalışır", async () => {
    const ctx = await createTenant("Satıcı");
    await lead(ctx, "Konya Modern", "https://a.test", { ecommerceStatus: "HAS_ECOMMERCE" });
    await lead(ctx, "Konya Eski", "https://b.test", { ecommerceStatus: "OUTDATED_ECOMMERCE" });
    await lead(ctx, "Konya Sitesiz", null, { ecommerceStatus: "NO_WEBSITE" });
    await lead(ctx, "Konya Bakılmadı", "https://c.test");
    const names = async (ecom: EcomFilter, q?: string) =>
      (await listLeads(ctx, { ecom, q, sort: "name" })).rows.map((r) => r.companyName);

    expect(await names("opportunity")).toEqual(["Konya Bakılmadı", "Konya Eski", "Konya Sitesiz"]);
    expect(await names("revision")).toEqual(["Konya Eski"]);
    expect(await names("has")).toEqual(["Konya Modern"]);
    expect(await names("all")).toHaveLength(4);
    expect(await names("opportunity", "sitesiz")).toEqual(["Konya Sitesiz"]);
  });

  it("aramadan sonra otomatik kontrol yalnızca mod açıkken kuyruğa girer", async () => {
    const ctx = await createTenant("Satıcı");
    const l = await lead(ctx, "Firma", "https://a.test");
    expect(await queueEcommerceCheckAfterImport(ctx.companyId, [l.id], ctx.userId)).toBeNull();
    await setEcommerceProspecting(ctx, true);
    const jobId = await queueEcommerceCheckAfterImport(ctx.companyId, [l.id], ctx.userId);
    expect(jobId).toBeTruthy();
    const job = await rawDb.job.findUniqueOrThrow({ where: { id: jobId! } });
    expect(job.type).toBe("lead.check_ecommerce");
    expect(job.companyId).toBe(ctx.companyId);
  });
});
