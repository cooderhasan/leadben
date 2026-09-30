import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import { rawDb } from "@/server/db";
import { detectContactForm } from "@/server/web/fetch-site";
import { findLeadEmails, pickContactFormUrl } from "@/server/services/lead-intelligence";
import { normalizeCompanyName } from "@/lib/lead-normalize";
import type { TenantContext } from "@/server/tenancy/types";
import { createTenant, resetDb, startSite } from "./helpers";

const $ = (html: string) => cheerio.load(html);

describe("iletişim formu tespiti", () => {
  it("mesaj alanı olan formu tanır", () => {
    expect(detectContactForm($(`<form><input name="ad"><input name="email"><textarea name="mesaj"></textarea></form>`))).toBe(true);
    expect(detectContactForm($(`<form action="/contact"><textarea id="message"></textarea><button>Gönder</button></form>`))).toBe(true);
  });

  it("arama kutusu, bülten ve giriş formunu saymaz", () => {
    expect(detectContactForm($(`<form><input type="search" name="q"><button>Ara</button></form>`))).toBe(false);
    expect(detectContactForm($(`<form><input name="newsletter_email"><button>Abone ol</button></form>`))).toBe(false);
    expect(detectContactForm($(`<form><input name="kullanici"><input name="parola" type="password"></form>`))).toBe(false);
    // Mesaj alanı var ama arama formu → elenir
    expect(detectContactForm($(`<form><input name="search"><textarea name="notes"></textarea></form>`))).toBe(false);
  });

  it("formsuz sayfada false döner", () => {
    expect(detectContactForm($(`<div><p>İletişim: 0212 000 00 00</p></div>`))).toBe(false);
  });
});

describe("form sayfası seçimi", () => {
  it("adresinde iletişim geçen sayfayı tercih eder", () => {
    const pages = [
      { url: "https://a.test/urunler", hasContactForm: true },
      { url: "https://a.test/iletisim", hasContactForm: true },
    ];
    expect(pickContactFormUrl(pages)).toBe("https://a.test/iletisim");
    expect(pickContactFormUrl([...pages].reverse())).toBe("https://a.test/iletisim");
  });

  it("İngilizce contact adresini de tanır", () => {
    expect(pickContactFormUrl([
      { url: "https://a.test/about", hasContactForm: true },
      { url: "https://a.test/contact-us", hasContactForm: true },
    ])).toBe("https://a.test/contact-us");
  });

  it("iletişim sayfası yoksa formu olan ilk sayfayı alır; hiç form yoksa null", () => {
    expect(pickContactFormUrl([{ url: "https://a.test/destek", hasContactForm: true }])).toBe("https://a.test/destek");
    expect(pickContactFormUrl([{ url: "https://a.test/", hasContactForm: false }])).toBeNull();
  });
});

beforeEach(resetDb);
afterAll(async () => {
  await rawDb.$disconnect();
});

async function lead(ctx: TenantContext, name: string, website: string) {
  return rawDb.lead.create({
    data: { companyId: ctx.companyId, companyName: name, normalizedName: normalizeCompanyName(name), website },
  });
}

describe("e-posta araması iletişim formunu kaydeder", () => {
  it("adres yoksa form sayfasının adresi lead'e yazılır", async () => {
    const ctx = await createTenant("A");
    const site = await startSite({
      "/robots.txt": "User-agent: *\nAllow: /",
      "/": "<html><body><a href='/iletisim'>İletişim</a><p>Yay üretimi</p></body></html>",
      "/iletisim": "<html><body><h1>Bize ulaşın</h1><form><input name='ad'><textarea name='mesaj'></textarea></form></body></html>",
    });
    try {
      const l = await lead(ctx, "Formlu Firma", `${site.url}/`);
      const res = await findLeadEmails(ctx.companyId, [l.id]);
      expect(res.found).toBe(0);
      expect(res.items[0]!.contactFormUrl).toContain("/iletisim");
      const saved = await rawDb.lead.findUniqueOrThrow({ where: { id: l.id } });
      expect(saved.contactFormUrl).toContain("/iletisim");
      expect(saved.genericEmail).toBeNull();
    } finally {
      site.server.close();
    }
  });

  it("e-posta bulunduysa form aranmaz (gereksiz kanal gösterilmez)", async () => {
    const ctx = await createTenant("A");
    const site = await startSite({
      "/robots.txt": "User-agent: *\nAllow: /",
      "/": "<html><body><a href='/iletisim'>İletişim</a></body></html>",
      // Adres sitenin kendi alan adında olmalı (başka alan adı "ajans adresi" sayılıp seçilmez)
      "/iletisim": "<html><body><a href='mailto:info@127.0.0.1'>info</a><form><textarea name='mesaj'></textarea></form></body></html>",
    });
    try {
      const l = await lead(ctx, "Adresli Firma", `${site.url}/`);
      const res = await findLeadEmails(ctx.companyId, [l.id]);
      expect(res.found).toBe(1);
      const saved = await rawDb.lead.findUniqueOrThrow({ where: { id: l.id } });
      expect(saved.contactFormUrl).toBeNull();
    } finally {
      site.server.close();
    }
  });

  it("form da yoksa alan boş kalır", async () => {
    const ctx = await createTenant("A");
    const site = await startSite({
      "/robots.txt": "User-agent: *\nAllow: /",
      "/": "<html><body><p>Telefonla arayın: 0212 000 00 00</p></body></html>",
    });
    try {
      const l = await lead(ctx, "Formsuz Firma", `${site.url}/`);
      await findLeadEmails(ctx.companyId, [l.id]);
      const saved = await rawDb.lead.findUniqueOrThrow({ where: { id: l.id } });
      expect(saved.contactFormUrl).toBeNull();
    } finally {
      site.server.close();
    }
  });
});
