/** CompanyFact anahtarları ve UI etiketleri (istemci + sunucu ortak). */
export const FACT_KEYS = {
  description: { label: "Firma tanımı", group: "Genel" },
  sector: { label: "Sektör", group: "Genel" },
  sub_sector: { label: "Alt sektör", group: "Genel" },
  business_model: { label: "İş modeli", group: "Genel" },
  product: { label: "Ürün", group: "Ürünler" },
  product_category: { label: "Ürün kategorisi", group: "Ürünler" },
  service: { label: "Hizmet", group: "Ürünler" },
  capability: { label: "Teknik kabiliyet", group: "Üretim ve kalite" },
  production_capacity: { label: "Üretim kapasitesi", group: "Üretim ve kalite" },
  certification: { label: "Sertifika / kalite belgesi", group: "Üretim ve kalite" },
  min_order: { label: "Minimum sipariş", group: "Üretim ve kalite" },
  delivery_time: { label: "Teslim süresi", group: "Üretim ve kalite" },
  industry_served: { label: "Hizmet verilen sektör", group: "Hedef pazar" },
  target_customer: { label: "Hedef müşteri", group: "Hedef pazar" },
  advantage: { label: "Avantaj", group: "Satış argümanları" },
  key_phrase: { label: "Kullanılan ifade", group: "Satış argümanları" },
  location: { label: "Lokasyon", group: "İletişim" },
  address: { label: "Adres", group: "İletişim" },
  contact_email: { label: "E-posta", group: "İletişim" },
  contact_phone: { label: "Telefon", group: "İletişim" },
  seo_title: { label: "SEO başlığı", group: "Web" },
} as const;

export type FactKey = keyof typeof FACT_KEYS;

export const FACT_GROUP_ORDER = ["Genel", "Ürünler", "Üretim ve kalite", "Hedef pazar", "Satış argümanları", "İletişim", "Web"] as const;

export function factLabel(key: string): string {
  return (FACT_KEYS as Record<string, { label: string }>)[key]?.label ?? key;
}

export function factGroup(key: string): string {
  return (FACT_KEYS as Record<string, { group: string }>)[key]?.group ?? "Diğer";
}

export const FACT_SOURCE_LABELS: Record<string, string> = {
  WEBSITE: "Web sitesi",
  DOCUMENT: "Doküman",
  USER: "Kullanıcı",
  SEED: "Demo verisi",
  AI_INFERRED: "AI çıkarımı",
};
