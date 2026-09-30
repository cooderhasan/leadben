/**
 * Demo / seed verisi.
 *
 * - Sektör taksonomisi (global)
 * - Platform yöneticisi
 * - İlk pilot firma: AKTİF YAY — yalnızca spesifikasyonda verilen bilgiler.
 *   Teknik özellik, fiyat, sertifika, kapasite gibi bilgiler UYDURULMAZ; bunlar web sitesi analizi
 *   ve kullanıcı onayıyla gelir.
 *
 * Çalıştırma: npm run db:seed   (tekrar çalıştırılabilir / idempotent)
 */
import "dotenv/config";
import { rawDb as db } from "../src/server/db";
import { hashPassword } from "../src/server/auth/password";

const DEMO_EMAIL = process.env.SEED_DEMO_EMAIL ?? "demo@aktifyay.local";
const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "AktifYay2026demo";
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@aisalesos.local";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "AdminSalesOS2026";

/** Sektör taksonomisi (spec §54) — lead scoring için normalize edilmiş sektörler. */
const INDUSTRIES: Array<{ key: string; tr: string; en: string; parent?: string }> = [
  { key: "automotive", tr: "Otomotiv", en: "Automotive" },
  { key: "automotive.supplier", tr: "Otomotiv yan sanayi", en: "Automotive Supplier", parent: "automotive" },
  { key: "automotive.supplier.metal", tr: "Metal otomotiv parçaları", en: "Metal Automotive Parts", parent: "automotive.supplier" },
  { key: "automotive.supplier.plastic", tr: "Plastik otomotiv parçaları", en: "Plastic Automotive Parts", parent: "automotive.supplier" },
  { key: "automotive.oem_supplier", tr: "OEM tedarikçisi", en: "OEM Supplier", parent: "automotive" },
  { key: "defense", tr: "Savunma", en: "Defense" },
  { key: "agriculture", tr: "Tarım", en: "Agriculture" },
  { key: "agriculture.machinery", tr: "Tarım makineleri", en: "Agricultural Machinery", parent: "agriculture" },
  { key: "furniture", tr: "Mobilya", en: "Furniture" },
  { key: "white_goods", tr: "Beyaz eşya", en: "White Goods" },
  { key: "medical", tr: "Medikal", en: "Medical" },
  { key: "medical.devices", tr: "Tıbbi cihaz", en: "Medical Devices", parent: "medical" },
  { key: "aviation", tr: "Havacılık", en: "Aviation" },
  { key: "electronics", tr: "Elektronik", en: "Electronics" },
  { key: "machinery", tr: "Makine / endüstriyel üretim", en: "Machinery" },
  { key: "machinery.industrial", tr: "Endüstriyel makine", en: "Industrial Machinery", parent: "machinery" },
];

async function seedIndustries() {
  for (const i of INDUSTRIES) {
    const parent = i.parent ? await db.industry.findUnique({ where: { key: i.parent } }) : null;
    await db.industry.upsert({
      where: { key: i.key },
      create: { key: i.key, nameTr: i.tr, nameEn: i.en, parentId: parent?.id ?? null },
      update: { nameTr: i.tr, nameEn: i.en, parentId: parent?.id ?? null },
    });
  }
}

async function upsertUser(email: string, name: string, password: string, isPlatformAdmin = false) {
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return existing;
  return db.user.create({ data: { email, name, passwordHash: await hashPassword(password), isPlatformAdmin } });
}

async function seedAktifYay(userId: string) {
  let company = await db.company.findUnique({ where: { slug: "aktif-yay" } });
  if (company) {
    console.log("• Aktif Yay zaten var, atlanıyor.");
    return company;
  }

  company = await db.company.create({
    data: {
      name: "Aktif Yay",
      slug: "aktif-yay",
      country: "Türkiye",
      creditBalance: 1000,
      onboardingStep: 1,
      members: { create: { userId, role: "OWNER" } },
      subscription: { create: { plan: "GROWTH", status: "TRIALING", monthlyCredits: 1000, leadLimit: 2000 } },
      profile: {
        create: {
          sector: "Endüstriyel yay üretimi",
          description: "Endüstriyel yay ve tel form ürünleri üreten B2B üretici.",
          currency: "TRY",
        },
      },
    },
  });
  const companyId = company.id;

  await db.usageRecord.create({ data: { companyId, operation: "credit.grant", credits: 1000, refType: "seed" } });

  // Ürün grupları (spec §3, §69) — yalnızca adlar; teknik detaylar kullanıcı/katalog ile gelir
  const category = await db.productCategory.create({ data: { companyId, name: "Yaylar" } });
  const products = ["Basma Yay", "Çekme Yay", "Kurma Yay", "Tel Form Yay"];
  for (const name of products) {
    await db.product.create({
      data: { companyId, name, categoryId: category.id, status: "VERIFIED", source: "SEED", active: true },
    });
  }

  // Hedef pazar (spec §3)
  await db.targetMarket.create({
    data: {
      companyId,
      name: "Ana hedef pazar",
      businessModel: "B2B",
      priority: 10,
      industries: ["Otomotiv", "Savunma", "Tarım", "Mobilya", "Beyaz Eşya", "Medikal", "Havacılık", "Elektronik", "Makine / Endüstriyel üretim"],
      countries: ["Türkiye"],
      customerTypes: ["Üretici firma"],
    },
  });

  // Doğrulanmış temel bilgiler — spesifikasyonda firma tarafından beyan edilenler
  const facts: Array<[string, string]> = [
    ["business_model", "B2B"],
    ["product_category", "Basma Yay"],
    ["product_category", "Çekme Yay"],
    ["product_category", "Kurma Yay"],
    ["product_category", "Tel Form Yay"],
    ...["Otomotiv", "Savunma", "Tarım", "Mobilya", "Beyaz Eşya", "Medikal", "Havacılık", "Elektronik", "Makine / Endüstriyel üretim"].map(
      (i) => ["industry_served", i] as [string, string],
    ),
  ];
  await db.companyFact.createMany({
    data: facts.map(([key, value]) => ({ companyId, key, value, source: "SEED" as const, status: "VERIFIED" as const })),
  });

  // Demo kampanyası (spec §69) — yalnızca TASLAK hedef tanımı; sonuç/sayı içermez
  await db.campaign.create({
    data: {
      companyId,
      name: "Türkiye Otomotiv Yan Sanayi - Basma Yay",
      status: "DRAFT",
      targetDescription: "Otomotiv yan sanayi firmaları",
      filters: {
        country: "Türkiye",
        cities: ["İstanbul", "Bursa", "Kocaeli", "Konya", "Ankara", "İzmir"],
        industries: ["automotive.supplier"],
        minEmployees: 20,
        products: ["Basma Yay"],
      },
      createdById: userId,
    },
  });

  await db.auditLog.create({ data: { companyId, userId, actorType: "SYSTEM", action: "seed.demo_company_created" } });
  return company;
}

async function main() {
  console.log("Seed başlıyor…");
  await seedIndustries();
  console.log(`• ${INDUSTRIES.length} sektör`);

  await upsertUser(ADMIN_EMAIL, "Platform Yöneticisi", ADMIN_PASSWORD, true);
  const demo = await upsertUser(DEMO_EMAIL, "Aktif Yay Demo", DEMO_PASSWORD);
  await seedAktifYay(demo.id);

  console.log("\nHazır. Giriş bilgileri:");
  // Production'da parolalar loga YAZILMAZ (sunucu loglarına erişen herkes görebilir); ortam değişkeninde durur
  const pw = (p: string) => (process.env.NODE_ENV === "production" ? "(parola: SERVICE_PASSWORD_* / SEED_* ortam değişkeninde)" : p);
  console.log(`  Demo (Aktif Yay): ${DEMO_EMAIL} / ${pw(DEMO_PASSWORD)}`);
  console.log(`  Platform admin : ${ADMIN_EMAIL} / ${pw(ADMIN_PASSWORD)}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
