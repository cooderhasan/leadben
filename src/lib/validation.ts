import { z } from "zod";
import { FACT_KEYS, type FactKey } from "./facts";

/** "a, b\nc" → ["a","b","c"] — virgül veya satır sonuyla ayrılmış liste alanları. */
export const listField = (max = 50, itemMax = 200) =>
  z.preprocess(
    (v) => {
      if (Array.isArray(v)) return v;
      if (typeof v !== "string") return [];
      return v
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    },
    z.array(z.string().max(itemMax)).max(max),
  );

/** Yalnızca satır sonuyla ayrılan liste (öğeler virgül içerebilir: kurallar, ürün adları). */
export const lineListField = (max = 50, itemMax = 500) =>
  z.preprocess(
    (v) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/\n+/).map((s) => s.trim()).filter(Boolean) : []),
    z.array(z.string().max(itemMax)).max(max),
  );

const optText = (max: number) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : typeof v === "string" ? v.trim() : v), z.string().max(max).nullable().optional());

const optInt = z.preprocess(
  (v) => (v === "" || v === null || v === undefined ? null : Number(String(v).replace(/[.\s]/g, ""))),
  z.number().int().min(0).max(10_000_000).nullable().optional(),
);

/**
 * Para/sayı girişini ayrıştırır. TR ("500.000,50", "50.000") ve EN ("500,000.50", "1250.5") biçimleri.
 * Hem nokta hem virgül varsa sondaki ondalık ayracıdır; tek başına "1.234.567" / "50.000" binlik sayılır.
 */
export function parseMoney(input: string): number {
  const s = input.trim().replace(/[\s₺$€]|TL/gi, "");
  if (!s) return NaN;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot !== -1 && lastComma !== -1) {
    return lastComma > lastDot ? Number(s.replace(/\./g, "").replace(",", ".")) : Number(s.replace(/,/g, ""));
  }
  if (lastComma !== -1) return /,\d{1,2}$/.test(s) ? Number(s.replace(",", ".")) : Number(s.replace(/,/g, ""));
  if (lastDot !== -1 && /^\d{1,3}(\.\d{3})+$/.test(s)) return Number(s.replace(/\./g, ""));
  return Number(s);
}

const optMoney = z.preprocess(
  (v) => {
    if (v === "" || v === null || v === undefined) return null;
    return parseMoney(String(v));
  },
  z.number().min(0).max(1e13).nullable().optional(),
);

const optBool = z.preprocess(
  (v) => (v === "yes" || v === "true" || v === true ? true : v === "no" || v === "false" || v === false ? false : null),
  z.boolean().nullable().optional(),
);

export const registerSchema = z.object({
  name: z.string().trim().min(2, "Adınızı girin.").max(100),
  email: z.string().trim().email("Geçerli bir e-posta girin.").max(200),
  password: z.string().min(10, "Parola en az 10 karakter olmalı.").max(200),
  companyName: z.string().trim().min(2, "Firma adını girin.").max(150),
});

export const loginSchema = z.object({
  email: z.string().trim().email("Geçerli bir e-posta girin."),
  password: z.string().min(1, "Parolanızı girin."),
});

export const websiteSchema = z.object({
  website: z.string().trim().min(3, "Web sitesi adresini girin.").max(500),
});

export const companyInfoSchema = z.object({
  name: z.string().trim().min(2, "Firma adını girin.").max(150),
  website: optText(500),
  sector: optText(200),
  subSector: optText(200),
  country: optText(100),
  city: optText(100),
  serviceRegions: listField(30, 100),
  sizeBand: optText(50),
  employeeCount: optInt,
  description: optText(2000),
});

export const productionInfoSchema = z.object({
  minOrder: optText(300),
  priceRangeNote: optText(300),
  avgOrderValue: optMoney,
  productionCapacity: optText(500),
  deliveryTime: optText(300),
  customManufacturing: optBool,
  certifications: listField(30, 150),
  productNames: lineListField(50, 200),
});

export const targetMarketSchema = z.object({
  name: z.string().trim().min(2).max(150).default("Ana hedef pazar"),
  businessModel: optText(20),
  industries: listField(30, 150),
  subIndustries: listField(30, 150),
  countries: listField(30, 100),
  cities: listField(50, 100),
  minEmployees: optInt,
  maxEmployees: optInt,
  minRevenue: optMoney,
  customerTypes: listField(20, 150),
  decisionMakerRoles: listField(20, 150),
  notes: optText(2000),
});

export const salesInfoSchema = z.object({
  currency: z.enum(["TRY", "USD", "EUR"]).default("TRY"),
  avgSaleValue: optMoney,
  salesCycleDays: optInt,
  monthlySalesTarget: optMoney,
  existingCustomerTypes: listField(20, 150),
  existingCustomerExamples: listField(30, 150),
});

export const competitorSchema = z.object({
  name: z.string().trim().min(1, "Rakip adını girin.").max(150),
  website: optText(500),
  strengths: listField(15, 200),
  weaknesses: listField(15, 200),
  notes: optText(1000),
});

export const exclusionsSchema = z.object({
  industries: listField(30, 150),
  cities: listField(50, 100),
  customerTypes: listField(20, 150),
  rules: lineListField(20, 500),
  notes: optText(2000),
});

export const productSchema = z.object({
  name: z.string().trim().min(1, "Ürün adını girin.").max(200),
  sku: optText(100),
  categoryName: optText(200),
  description: optText(3000),
  technicalSpecsText: optText(5000),
  materials: listField(20, 100),
  dimensions: optText(300),
  applications: listField(30, 200),
  industries: listField(30, 150),
  minOrder: optText(200),
  priceRange: optText(200),
  deliveryTime: optText(200),
  certifications: listField(20, 150),
  active: optBool,
});

export const memorySchema = z.object({
  type: z.enum(["RULE", "PREFERENCE", "FACT"]),
  content: z.string().trim().min(5, "Kuralı en az birkaç kelimeyle yazın.").max(1000),
});

export const factAddSchema = z.object({
  key: z.enum(Object.keys(FACT_KEYS) as [FactKey, ...FactKey[]], { errorMap: () => ({ message: "Bilgi türünü seçin" }) }),
  value: z.string().trim().min(2, "Değer girin.").max(500),
});

export const factEditSchema = z.object({
  factId: z.string().min(1),
  value: z.string().trim().min(1, "Değer boş olamaz.").max(1500),
});

// ── Lead (Faz 2) ──────────────────────────────────────────────────────
export const leadSearchFormSchema = z.object({
  prompt: z.string().trim().min(3, "Ne tür firmalar aradığınızı yazın").max(1000),
  limit: z.preprocess((v) => (v === "" || v == null ? undefined : Number(v)), z.number().int().min(1).max(500).optional()),
  source: z.enum(["auto", "maps", "web"]).default("auto"),
});

export const manualLeadSchema = z.object({
  companyName: z.string().trim().min(2, "Firma adı gerekli").max(300),
  website: optText(500),
  phone: optText(50),
  genericEmail: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().email("Geçerli bir e-posta girin").max(200).nullable().optional(),
  ),
  city: optText(120),
  district: optText(120),
  address: optText(500),
  category: optText(200),
});

export const leadContactSchema = z.object({
  id: z.string().min(1),
  website: optText(500),
  phone: optText(50),
  genericEmail: optText(200),
});

export const LEAD_STATUSES = [
  "NEW", "RESEARCHING", "QUALIFIED", "CONTACT_READY", "CONTACTED", "REPLIED", "INTERESTED",
  "QUALIFIED_OPPORTUNITY", "QUOTE_REQUESTED", "PROPOSAL_SENT", "NEGOTIATION", "WON", "LOST", "NURTURE", "SUPPRESSED",
] as const;

export const leadStatusSchema = z.object({
  id: z.string().min(1),
  status: z.enum(LEAD_STATUSES),
});

// ── E-posta / kampanya (Faz 3) ──────────────────────────────────────────
export const senderSettingsSchema = z.object({
  fromName: z.string().trim().min(2, "Gönderen adı gerekli").max(100),
  fromEmail: z.string().trim().toLowerCase().email("Geçerli bir e-posta girin").max(200),
  replyTo: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().toLowerCase().email("Geçerli bir e-posta girin").max(200).nullable().optional(),
  ),
  /** Ticari iletide gönderici kimliği (6563 s.K.) — ticari unvan */
  legalName: z.string().trim().min(3, "Ticari unvan gerekli").max(200),
  postalAddress: z.string().trim().min(10, "Açık adres gerekli").max(400),
  phone: optText(50),
  signature: optText(600),
});

export const campaignCreateSchema = z.object({
  name: z.string().trim().min(3, "Kampanya adı gerekli").max(120),
  targetDescription: z.string().trim().min(10, "Hedefi birkaç cümleyle anlatın").max(1500),
  productIds: z.preprocess((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]), z.array(z.string().min(1)).max(20)),
  minScore: z.preprocess((v) => (v === "" || v == null ? undefined : Number(v)), z.number().int().min(0).max(100).optional()),
  maxLeads: z.preprocess((v) => (v === "" || v == null ? undefined : Number(v)), z.number().int().min(1).max(500).optional()),
  /** Mesaj dili — yurt dışı kampanyalarda AI İngilizce yazar */
  language: z.preprocess((v) => (v === "" || v == null ? undefined : v), z.enum(["tr", "en"]).optional()),
});

export const manualReplySchema = z.object({
  leadId: z.string().min(1),
  fromAddress: z.string().trim().toLowerCase().email("Yanıtı gönderen adresi girin").max(200),
  subject: optText(300),
  body: z.string().trim().min(2, "Yanıt metnini yapıştırın").max(50_000),
});

const OPP_STAGES = ["NEW", "QUALIFIED", "CONTACTED", "INTERESTED", "QUOTE", "NEGOTIATION", "WON", "LOST"] as const;
const LOST_REASONS = ["PRICE", "DELIVERY", "PRODUCT_MISMATCH", "COMPETITOR", "TIMING", "NO_RESPONSE", "WRONG_CONTACT", "OTHER"] as const;
const optDate = z.preprocess(
  (v) => (v === "" || v == null ? null : new Date(String(v))),
  z.date().refine((d) => !Number.isNaN(d.getTime()), "Geçerli bir tarih girin").nullable().optional(),
);

export const opportunityUpdateSchema = z.object({
  id: z.string().min(1),
  stage: z.enum(OPP_STAGES),
  value: optMoney,
  probability: z.preprocess((v) => (v === "" || v == null ? null : Number(v)), z.number().int().min(0).max(100).nullable().optional()),
  expectedCloseAt: optDate,
  lostReason: z.preprocess((v) => (v === "" ? null : v), z.enum(LOST_REASONS).nullable().optional()),
  lostNote: optText(1000),
});

export const taskCreateSchema = z.object({
  title: z.string().trim().min(3, "Görev başlığı gerekli").max(200),
  description: optText(2000),
  leadId: z.preprocess((v) => (v === "" ? null : v), z.string().min(1).nullable().optional()),
  dueAt: optDate,
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"),
});

/** Teklif kalemleri formdan dizi olarak gelir: item_name[], item_qty[], item_unit[], item_price[], item_note[], item_productId[] */
const arr = (v: unknown) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
export const proposalFormSchema = z
  .object({
    id: z.string().min(1),
    currency: z.enum(["TRY", "USD", "EUR"]).default("TRY"),
    validUntil: optDate,
    deliveryTerms: optText(600),
    terms: optText(2000),
    item_name: z.preprocess(arr, z.array(z.string().max(200))),
    item_qty: z.preprocess(arr, z.array(z.string().max(30))),
    item_unit: z.preprocess(arr, z.array(z.string().max(30))),
    item_price: z.preprocess(arr, z.array(z.string().max(30))),
    item_note: z.preprocess(arr, z.array(z.string().max(400))),
    item_productId: z.preprocess(arr, z.array(z.string().max(40))),
  })
  .transform((v) => ({
    id: v.id,
    currency: v.currency,
    validUntil: v.validUntil ?? null,
    deliveryTerms: v.deliveryTerms ?? null,
    terms: v.terms ?? null,
    items: v.item_name
      .map((name, i) => {
        const qty = v.item_qty[i]?.trim() ? parseMoney(v.item_qty[i]!) : NaN;
        const price = v.item_price[i]?.trim() ? parseMoney(v.item_price[i]!) : NaN;
        return {
          productId: v.item_productId[i]?.trim() || null,
          name: name.trim(),
          quantity: Number.isFinite(qty) && qty > 0 ? qty : null,
          unit: v.item_unit[i]?.trim() || null,
          unitPrice: Number.isFinite(price) && price >= 0 ? price : null,
          note: v.item_note[i]?.trim() || null,
        };
      })
      .filter((i) => i.name.length > 0),
  }));

export const messageEditSchema = z.object({
  id: z.string().min(1),
  subject: z.string().trim().min(3, "Konu gerekli").max(150),
  body: z.string().trim().min(40, "Mesaj çok kısa").max(5000),
});

/** "Tel çapı: 0,5–8 mm" satırlarını anahtar/değer nesnesine çevirir. */
export function parseSpecs(text: string | null | undefined): Record<string, string> | null {
  if (!text) return null;
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k && v) out[k.slice(0, 100)] = v.slice(0, 300);
  }
  return Object.keys(out).length ? out : null;
}

export function specsToText(specs: unknown): string {
  if (!specs || typeof specs !== "object") return "";
  return Object.entries(specs as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join("\n");
}

export const CALL_OUTCOMES = [
  "NO_ANSWER",
  "BUSY",
  "WRONG_NUMBER",
  "CALL_BACK",
  "NOT_INTERESTED",
  "INTERESTED",
  "CATALOG_REQUESTED",
  "MEETING_SET",
  "WHATSAPP_CONSENT",
  "EMAIL_OBTAINED",
  "DO_NOT_CALL",
] as const;

export const callLogSchema = z.object({
  leadId: z.string().min(1),
  outcome: z.enum(CALL_OUTCOMES, { errorMap: () => ({ message: "Görüşme sonucunu seçin" }) }),
  note: optText(2000),
  /** İstemci yerel saati ISO'ya çevirip gönderir (sunucu UTC'dir) */
  at: optDate,
  mobilePhone: optText(40),
  contactName: optText(200),
  email: optText(300),
});
