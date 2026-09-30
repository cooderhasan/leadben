import "server-only";
import type { EcommerceStatus, Prisma } from "@prisma/client";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { assertCan } from "@/server/tenancy/permissions";
import type { TenantContext } from "@/server/tenancy/types";
import { env } from "@/server/env";
import { ai, isAIConfigured } from "@/server/ai";
import { untrusted } from "@/server/ai/guardrails";
import { LEAD_SEARCH_INSTRUCTIONS, LEAD_SEARCH_SHAPE, leadSearchSchema } from "@/server/ai/prompts/lead-search";
import {
  LEAD_RESEARCH_INSTRUCTIONS,
  LEAD_RESEARCH_SHAPE,
  leadResearchSchema,
  type LeadResearchOutput,
} from "@/server/ai/prompts/lead-research";
import { LEAD_SCORE_INSTRUCTIONS, LEAD_SCORE_SHAPE, leadScoreSchema } from "@/server/ai/prompts/lead-score";
import { getWebSearchProvider, isLeadSourceConfigured, isWebSearchConfigured } from "@/server/providers/lead-source";
import { isRenderConfigured } from "@/server/providers/render";
import { isNonCompanyHost } from "@/server/providers/lead-source/apify-web";
import { csvToRawLeads } from "@/server/providers/lead-source/csv";
import type { LeadSearchQuery, LeadSourceKind, RawLead } from "@/server/providers/lead-source/types";
import { CONTACT_PATH, crawlSite, FetchBlockedError, fetchListPage } from "@/server/web/fetch-site";
import { normalizeUrl } from "@/server/web/ssrf";
import { LIST_IMPORT_INSTRUCTIONS, LIST_IMPORT_SHAPE, listImportSchema, type ListImportOutput } from "@/server/ai/prompts/list-import";
import { crawlToPrompt, allowPrivateFetch } from "@/server/jobs/handlers/website-analyze";
import { enqueue } from "@/server/jobs/queue";
import { consumeCredits, CREDIT_COSTS, refundCredits } from "@/server/usage/credits";
import { audit } from "@/server/audit/audit";
import { buildVerifiedCompanyContext } from "./facts";
import { evidenceFound, normalizeForMatch, valueFound } from "./evidence";
import { createLeadList, ensureJobList, saveDiscoveredLeads } from "./leads";
import { getEcommerceProspecting, queueEcommerceCheckAfterImport } from "./ecommerce-check";
import { ECOMMERCE_STATUS_LABELS, SITE_ISSUE_LABELS, type SiteIssue } from "@/server/web/ecommerce";
import { AppError } from "@/lib/errors";
import { computeReachability, finalizeScore } from "@/lib/lead-scoring";
import { extractDomain, isCompanyEmail, isGenericEmail, nameSimilarity, normalizeEmail, normalizePhone, pickCompanyEmail } from "@/lib/lead-normalize";
import { checkEmailQuality } from "@/lib/email-quality";
import { checkMailDomain } from "@/server/providers/email/mx";

const REFRESH_DAYS = 90;

// ── Satıcı şirket bağlamı (yalnızca doğrulanmış bilgi) ─────────────────

async function sellerContext(companyId: string) {
  const [verified, markets, ecommerceProspecting] = await Promise.all([
    buildVerifiedCompanyContext({ companyId }),
    tenantDb({ companyId }).targetMarket.findMany({
      select: { name: true, isExcluded: true, industries: true, cities: true, countries: true, minEmployees: true, maxEmployees: true, notes: true },
      orderBy: { priority: "desc" },
    }),
    getEcommerceProspecting({ companyId }),
  ]);
  const productNames = verified.products.map((p) => p.name);
  const text = JSON.stringify(
    {
      company: verified.name,
      sector: verified.sector,
      summary: verified.summary,
      verifiedFacts: verified.facts.slice(0, 60),
      products: verified.products.slice(0, 40).map((p) => ({
        name: p.name,
        description: p.description?.slice(0, 300) ?? null,
        applications: p.applications,
        industries: p.industries,
      })),
      targetMarkets: markets.filter((m) => !m.isExcluded),
      excludedCustomers: markets.filter((m) => m.isExcluded),
      rules: verified.rules.slice(0, 30),
    },
    null,
    1,
  );
  return { text, productNames, hasProducts: productNames.length > 0, ecommerceProspecting };
}

// ── 1) Doğal dil arama ───────────────────────────────────────────────

export interface ParsedSearch {
  query: LeadSearchQuery;
  interpretation: string;
  source: LeadSourceKind;
}

/** AI kapalıyken arama ifadesi olduğu gibi kullanılır (zarif düşüş). */
export function fallbackSearch(prompt: string, limit: number): ParsedSearch {
  return {
    query: { keywords: [prompt.trim().slice(0, 80)], country: "Türkiye", cities: [], districts: [], industries: [], limit },
    interpretation: "AI kapalı olduğu için arama ifadesi olduğu gibi kullanıldı.",
    source: "maps",
  };
}

async function parseSearchPrompt(ctx: TenantContext, prompt: string, maxLimit: number): Promise<ParsedSearch> {
  if (!isAIConfigured()) return fallbackSearch(prompt, maxLimit);
  const seller = await sellerContext(ctx.companyId);
  const { data } = await ai({ companyId: ctx.companyId, operation: "lead.search.parse" }).extract({
    schema: leadSearchSchema,
    tier: "fast",
    instructions: LEAD_SEARCH_INSTRUCTIONS,
    shape: LEAD_SEARCH_SHAPE,
    input: `ŞİRKET BAĞLAMI:\n${seller.text}\n\nKULLANICI İSTEĞİ:\n${untrusted("user-search", prompt, 1000)}`,
    maxTokens: 800,
  });
  return {
    query: {
      keywords: data.keywords,
      industries: data.industries,
      country: data.country ?? "Türkiye",
      cities: data.cities,
      districts: data.districts,
      limit: Math.min(data.requestedLimit ?? maxLimit, maxLimit),
    },
    interpretation: data.interpretation,
    source: data.source,
  };
}

/**
 * Lead aramasını başlatır. Kredi, bulunabilecek en fazla lead sayısı kadar önden ayrılır;
 * iş bitince yalnızca YENİ eklenen lead'ler ücretlendirilir, kalan iade edilir.
 */
export async function startLeadSearch(ctx: TenantContext, prompt: string, requestedLimit?: number, sourcePref: LeadSourceKind | "auto" = "auto") {
  assertCan(ctx, "lead.write");
  const text = prompt.trim();
  if (text.length < 3) throw new AppError("VALIDATION", "Ne tür firmalar aradığınızı yazın.", { prompt: "En az 3 karakter" });
  if (!isLeadSourceConfigured()) {
    throw new AppError(
      "VALIDATION",
      "Otomatik lead arama kapalı (APIFY_TOKEN tanımlı değil). CSV ile içe aktarabilir veya elle ekleyebilirsiniz.",
    );
  }
  const db = tenantDb(ctx);
  const running = await db.job.findFirst({
    where: { type: "lead.search", status: { in: ["QUEUED", "RUNNING"] } },
    select: { id: true },
  });
  if (running) throw new AppError("CONFLICT", "Devam eden bir arama var. Bitince yeni arama başlatabilirsiniz.");

  const max = Math.min(requestedLimit ?? env().LEAD_SEARCH_MAX, env().LEAD_SEARCH_MAX);
  const parsed = await parseSearchPrompt(ctx, text, max);
  const reserved = parsed.query.limit;
  // Kullanıcı kaynak seçtiyse o; "Otomatik"te AI'ın seçimi
  const source: LeadSourceKind = sourcePref === "auto" ? parsed.source : sourcePref;

  const { usageId } = await consumeCredits({
    companyId: ctx.companyId,
    operation: "lead.discovery",
    quantity: reserved,
    userId: ctx.userId,
    refType: "lead.search",
  });

  let jobId: string;
  try {
    jobId = await enqueue(
      "lead.search",
      { prompt: text.slice(0, 1000), interpretation: parsed.interpretation, query: parsed.query, usageId, reserved, source },
      { companyId: ctx.companyId, createdById: ctx.userId, maxAttempts: 3 },
    );
  } catch (err) {
    await refundCredits(usageId, "lead.search.enqueue_failed");
    throw err;
  }

  await audit({
    companyId: ctx.companyId,
    userId: ctx.userId,
    action: "lead.search.started",
    entityType: "Job",
    entityId: jobId,
    metadata: { prompt: text.slice(0, 300), query: parsed.query as unknown as Prisma.InputJsonValue, reserved, source },
  });
  return { jobId, interpretation: parsed.interpretation, reserved, source };
}

export async function listRecentSearches(ctx: TenantContext, take = 8) {
  assertCan(ctx, "lead.read");
  const jobs = await tenantDb(ctx).job.findMany({
    where: { type: "lead.search" },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, status: true, progress: true, error: true, payload: true, result: true, createdAt: true, finishedAt: true },
  });
  return jobs.map((j) => {
    const p = j.payload as { prompt?: string; interpretation?: string; reserved?: number; source?: LeadSourceKind };
    const r = (j.result ?? {}) as { created?: number; merged?: number; found?: number };
    return {
      id: j.id,
      status: j.status,
      progress: j.progress,
      error: j.error,
      prompt: p.prompt ?? "",
      interpretation: p.interpretation ?? "",
      source: p.source ?? "maps",
      created: r.created ?? null,
      merged: r.merged ?? null,
      found: r.found ?? null,
      createdAt: j.createdAt,
    };
  });
}

// ── 2) CSV içe aktarma ────────────────────────────────────────────────

/** CSV içe aktarma kredi harcamaz (dış kaynak maliyeti yok). */
export async function importLeadsCsv(ctx: TenantContext, text: string) {
  assertCan(ctx, "lead.write");
  if (text.length > 5_000_000) throw new AppError("VALIDATION", "CSV dosyası en fazla 5 MB olabilir.");
  const parsed = csvToRawLeads(text);
  if (parsed.leads.length === 0) {
    throw new AppError(
      "VALIDATION",
      "CSV'de firma adı sütunu bulunamadı. İlk satırda 'Firma' (veya 'Firma Adı', 'Company') başlığı olmalı.",
    );
  }
  const list = await createLeadList(ctx, `CSV · ${new Date().toLocaleDateString("tr-TR", { day: "numeric", month: "short", timeZone: "Europe/Istanbul" })}`);
  const result = await saveDiscoveredLeads(ctx.companyId, parsed.leads, { provider: "csv", listId: list.id, ownerId: ctx.userId });
  await queueEcommerceCheckAfterImport(ctx.companyId, result.leadIds, ctx.userId);
  await audit({
    companyId: ctx.companyId,
    userId: ctx.userId,
    action: "lead.csv_imported",
    metadata: { created: result.created, merged: result.merged, skipped: result.skipped + parsed.skippedRows },
  });
  return { ...result, skipped: result.skipped + parsed.skippedRows, unknownHeaders: parsed.unknownHeaders };
}

// ── 3) Araştırma (zenginleştirme) ─────────────────────────────────────

export async function startLeadResearch(ctx: TenantContext, leadId: string) {
  assertCan(ctx, "lead.write");
  if (!isAIConfigured()) {
    throw new AppError("AI_UNAVAILABLE", "AI sağlayıcısı yapılandırılmamış (.env → ANTHROPIC_API_KEY).");
  }
  const db = tenantDb(ctx);
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { id: true, website: true } });
  if (!lead) throw new AppError("NOT_FOUND", "Lead bulunamadı.");
  if (!lead.website) {
    throw new AppError("VALIDATION", "Bu lead'in web sitesi yok. Araştırma için önce web sitesini ekleyin; puanlama yine yapılabilir.");
  }
  const running = await db.job.findFirst({
    where: { type: "lead.enrich", status: { in: ["QUEUED", "RUNNING"] }, payload: { path: ["leadId"], equals: leadId } },
    select: { id: true },
  });
  if (running) return { jobId: running.id, alreadyRunning: true };

  const { usageId } = await consumeCredits({
    companyId: ctx.companyId,
    operation: "lead.enrich",
    userId: ctx.userId,
    refType: "Lead",
    refId: leadId,
  });
  let jobId: string;
  try {
    jobId = await enqueue("lead.enrich", { leadId, usageId }, { companyId: ctx.companyId, createdById: ctx.userId });
  } catch (err) {
    await refundCredits(usageId, "lead.enrich.enqueue_failed");
    throw err;
  }
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "lead.research.started", entityType: "Lead", entityId: leadId });
  return { jobId, alreadyRunning: false };
}

/** Enrichment JSON yapısı (Lead.enrichment) */
export interface LeadEnrichment {
  researchedAt: string;
  sourceUrl: string;
  pages: string[];
  products: string[];
  verified: Array<{ statement: string; sourceUrl?: string | null; evidence?: string | null }>;
  assumptions: Array<{ statement: string; reason: string }>;
  /** Kanıtı sayfada bulunamadığı için doğrulanmıştan varsayıma taşınan öğe sayısı */
  downgraded: number;
}

/**
 * AI çıktısını kaynak metne karşı doğrular: kanıt alıntısı sayfada yoksa bilgi "doğrulanmış" sayılmaz.
 * Saf fonksiyon — testlerde doğrudan kullanılır.
 */
export function verifyResearch(data: LeadResearchOutput, corpus: string) {
  const verified: LeadEnrichment["verified"] = [];
  const assumptions: LeadEnrichment["assumptions"] = [...data.assumptions];
  let downgraded = 0;
  for (const c of data.verified) {
    if (evidenceFound(c.evidence, corpus)) verified.push(c);
    else {
      downgraded++;
      assumptions.push({ statement: c.statement, reason: "Kaynak sayfada kanıtı doğrulanamadı." });
    }
  }
  const signals = data.signals.filter((s) => evidenceFound(s.evidence, corpus));
  const email = normalizeEmail(data.genericEmail);
  const phone = data.phone && valueFound(data.phone, corpus) ? data.phone : null;
  const sizeProven =
    (data.employeeCountMin !== null && valueFound(String(data.employeeCountMin), corpus)) ||
    (data.employeeCountMax !== null && valueFound(String(data.employeeCountMax), corpus));
  return {
    verified,
    assumptions: assumptions.slice(0, 20),
    downgraded,
    signals,
    // Kişisel adres asla lead genel e-postasına yazılmaz
    genericEmail: email && isGenericEmail(email) && valueFound(email, corpus) ? email : null,
    phone,
    employeeCountMin: sizeProven ? data.employeeCountMin : null,
    employeeCountMax: sizeProven ? data.employeeCountMax : null,
  };
}

function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) || d.getTime() > Date.now() + 86_400_000 ? null : d;
}

/** İş (job) içinden çağrılır. Lead web sitesini tarar, AI ile özetler, kanıtları doğrular. */
export async function researchLead(companyId: string, leadId: string, progress?: (pct: number) => Promise<void>) {
  const db = tenantDb({ companyId });
  const lead = await db.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw new AppError("NOT_FOUND", "Lead bulunamadı.");
  if (!lead.website) throw new AppError("VALIDATION", "Lead'in web sitesi yok.");

  let crawl;
  try {
    crawl = await crawlSite(lead.website, { maxPages: 7, ensureContactPage: true, allowPrivateHosts: allowPrivateFetch() });
  } catch (err) {
    if (err instanceof FetchBlockedError) throw new AppError("EXTERNAL_FETCH", err.message);
    throw new AppError("EXTERNAL_FETCH", `Lead sitesine ulaşılamadı: ${(err as Error).message}`);
  }
  const corpus = crawl.pages.map((p) => [p.title, p.metaDescription, p.headings.join(" "), p.text].join(" ")).join("\n");
  if (corpus.replace(/\s+/g, "").length < 150) {
    throw new AppError("EXTERNAL_FETCH", "Lead sitesinde okunabilir metin bulunamadı (içerik JavaScript ile yükleniyor olabilir).");
  }
  await progress?.(35);

  const { data } = await ai({ companyId, operation: "lead.research" }).extract({
    schema: leadResearchSchema,
    instructions: LEAD_RESEARCH_INSTRUCTIONS,
    shape: LEAD_RESEARCH_SHAPE,
    input: `Firma: ${lead.companyName}\n\n${untrusted("lead-website", crawlToPrompt(crawl, 40_000))}`,
    maxTokens: 4000,
  });
  await progress?.(65);

  const v = verifyResearch(data, corpus);
  const enrichment: LeadEnrichment = {
    researchedAt: new Date().toISOString(),
    sourceUrl: lead.website,
    pages: crawl.pages.map((p) => p.url),
    products: data.products,
    verified: v.verified,
    assumptions: v.assumptions,
    downgraded: v.downgraded,
  };

  const social = data.socialProfiles ?? {};
  await db.lead.update({
    where: { id: leadId },
    data: {
      aiSummary: data.summary,
      enrichment: enrichment as unknown as Prisma.InputJsonValue,
      industry: lead.industry ?? data.industry,
      subIndustry: lead.subIndustry ?? data.subIndustry,
      employeeCountMin: lead.employeeCountMin ?? v.employeeCountMin,
      employeeCountMax: lead.employeeCountMax ?? v.employeeCountMax,
      // Önce sayfalarda gerçekten bulunan adres (mailto / metin / Cloudflare), sonra AI'ın bulup metinde doğrulananı
      genericEmail: lead.genericEmail ?? pickCompanyEmail(crawl.pages.flatMap((p) => p.emails), lead.website) ?? v.genericEmail,
      phone: lead.phone ?? v.phone,
      normalizedPhone: lead.normalizedPhone ?? normalizePhone(v.phone),
      linkedin: lead.linkedin ?? (social.linkedin && valueFound(social.linkedin, corpus) ? social.linkedin : null),
      instagram: lead.instagram ?? (social.instagram && valueFound(social.instagram, corpus) ? social.instagram : null),
      lastVerifiedAt: new Date(),
      nextRefreshAt: new Date(Date.now() + REFRESH_DAYS * 86_400_000),
    },
  });

  // Sinyaller: yalnızca kanıtı sayfada bulunanlar, aynı başlık tekrar eklenmez
  for (const s of v.signals) {
    const exists = await db.leadSignal.findFirst({ where: { leadId, title: s.title } });
    if (exists) continue;
    await db.leadSignal.create({
      data: {
        companyId,
        leadId,
        type: s.type,
        title: s.title,
        description: s.description ?? null,
        sourceUrl: s.sourceUrl ?? lead.website,
        publishedAt: parseDate(s.publishedAt),
        confidence: s.confidence,
        aiInterpretation: s.evidence ? `Kaynak: "${s.evidence.slice(0, 300)}"` : null,
        verified: true,
      },
    });
  }

  await db.websiteAnalysis.create({
    data: {
      companyId,
      target: "LEAD",
      targetId: leadId,
      url: lead.website,
      status: "COMPLETED",
      pages: crawl.pages.map((p) => ({ url: p.url, title: p.title })) as unknown as Prisma.InputJsonValue,
      summary: data.summary,
      completedAt: new Date(),
    },
  });

  return { pages: crawl.pages.length, verified: v.verified.length, assumptions: v.assumptions.length, signals: v.signals.length };
}

// ── 4) Puanlama ───────────────────────────────────────────────────────

export async function startLeadScoring(ctx: TenantContext, leadIds: string[]) {
  assertCan(ctx, "lead.write");
  if (!isAIConfigured()) throw new AppError("AI_UNAVAILABLE", "AI sağlayıcısı yapılandırılmamış (.env → ANTHROPIC_API_KEY).");
  const ids = [...new Set(leadIds)].slice(0, 100);
  if (ids.length === 0) throw new AppError("VALIDATION", "Puanlanacak lead seçin.");
  const owned = await tenantDb(ctx).lead.findMany({ where: { id: { in: ids } }, select: { id: true } });
  if (owned.length === 0) throw new AppError("NOT_FOUND", "Lead bulunamadı.");

  const { usageId } = await consumeCredits({
    companyId: ctx.companyId,
    operation: "lead.score",
    quantity: owned.length,
    userId: ctx.userId,
    refType: "lead.score",
  });
  let jobId: string;
  try {
    jobId = await enqueue(
      "lead.score",
      { leadIds: owned.map((l) => l.id), usageId },
      { companyId: ctx.companyId, createdById: ctx.userId },
    );
  } catch (err) {
    await refundCredits(usageId, "lead.score.enqueue_failed");
    throw err;
  }
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "lead.scoring.started", metadata: { count: owned.length } });
  return { jobId, count: owned.length, cost: owned.length * CREDIT_COSTS["lead.score"] };
}

function leadToPrompt(lead: {
  companyName: string;
  website: string | null;
  industry: string | null;
  subIndustry: string | null;
  city: string | null;
  district: string | null;
  country: string | null;
  employeeCountMin: number | null;
  employeeCountMax: number | null;
  aiSummary: string | null;
  enrichment: Prisma.JsonValue;
  ecommerceStatus: EcommerceStatus | null;
  ecommercePlatform: string | null;
  marketplaces: string[];
  siteIssues: string[];
  signals: Array<{ type: string; title: string; description: string | null; publishedAt: Date | null }>;
}) {
  const e = (lead.enrichment ?? null) as LeadEnrichment | null;
  return JSON.stringify(
    {
      companyName: lead.companyName,
      website: lead.website,
      directoryCategory: lead.industry,
      subIndustry: lead.subIndustry,
      location: [lead.district, lead.city, lead.country].filter(Boolean).join(", "),
      employees: lead.employeeCountMin || lead.employeeCountMax ? { min: lead.employeeCountMin, max: lead.employeeCountMax } : null,
      researchSummary: lead.aiSummary,
      products: e?.products ?? [],
      verifiedFacts: e?.verified.map((v) => v.statement) ?? [],
      assumptions: e?.assumptions.map((a) => a.statement) ?? [],
      // Sitede AI'sız ölçülen çevrim içi satış durumu (doğrulanmış)
      onlineSales: lead.ecommerceStatus
        ? {
            status: ECOMMERCE_STATUS_LABELS[lead.ecommerceStatus],
            platform: lead.ecommercePlatform,
            marketplaces: lead.marketplaces,
            siteIssues: lead.siteIssues.map((i) => SITE_ISSUE_LABELS[i as SiteIssue] ?? i),
          }
        : null,
      verifiedSignals: lead.signals.map((s) => ({
        type: s.type,
        title: s.title,
        description: s.description,
        date: s.publishedAt?.toISOString().slice(0, 10) ?? null,
      })),
    },
    null,
    1,
  );
}

/** Tek lead'i puanlar. İş (job) içinden çağrılır; satıcı bağlamı yalnızca doğrulanmış bilgidir. */
export async function scoreLead(companyId: string, leadId: string, seller?: Awaited<ReturnType<typeof sellerContext>>) {
  const db = tenantDb({ companyId });
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    include: {
      signals: { where: { verified: true }, orderBy: { detectedAt: "desc" }, take: 10 },
      _count: { select: { contacts: true } },
    },
  });
  if (!lead) throw new AppError("NOT_FOUND", "Lead bulunamadı.");
  const ctxSeller = seller ?? (await sellerContext(companyId));

  const { data, raw } = await ai({ companyId, operation: "lead.score" }).extract({
    schema: leadScoreSchema,
    tier: "fast",
    instructions: LEAD_SCORE_INSTRUCTIONS,
    shape: LEAD_SCORE_SHAPE,
    input: `ŞİRKET BAĞLAMI (satıcı, doğrulanmış):\n${ctxSeller.text}\n\nLEAD VERİSİ:\n${untrusted("lead-data", leadToPrompt(lead), 20_000)}`,
    maxTokens: 1500,
  });

  const final = finalizeScore(data, {
    verifiedSignalCount: lead.signals.length,
    hasSizeData: Boolean(lead.employeeCountMin || lead.employeeCountMax),
    researched: Boolean(lead.enrichment),
    reachability: computeReachability(
      {
        website: lead.website,
        phone: lead.phone,
        genericEmail: lead.genericEmail,
        contactCount: lead._count.contacts,
        linkedin: lead.linkedin,
        instagram: lead.instagram ?? lead.facebook,
      },
      ctxSeller.ecommerceProspecting ? "phone_first" : "default",
    ),
    ecommerceStatus: ctxSeller.ecommerceProspecting ? lead.ecommerceStatus : null,
  });

  // Ürün uydurma koruması: yalnızca şirketin onaylı ürün adları
  const allowed = new Map(ctxSeller.productNames.map((n) => [n.toLocaleLowerCase("tr"), n]));
  const matchedProducts = data.matchedProducts
    .map((p) => allowed.get(p.trim().toLocaleLowerCase("tr")))
    .filter((p): p is string => Boolean(p));

  const assumptions = [...data.assumptions];
  if (!ctxSeller.hasProducts) assumptions.unshift("Şirketin onaylı ürün listesi boş; ürün uyumu genel bilgiye göre tahmin edildi.");
  if (final.capped.length > 0) assumptions.push(`Kanıt eksikliği nedeniyle sınırlandı: ${final.capped.join(", ")}.`);
  if (data.excludedReason) assumptions.unshift(`İstenmeyen müşteri kuralı: ${data.excludedReason}`);

  const score = await db.leadScore.create({
    data: {
      companyId,
      leadId,
      total: final.total,
      productFit: final.productFit,
      industryFit: final.industryFit,
      sizeFit: final.sizeFit,
      buyingSignal: final.buyingSignal,
      reachability: final.reachability,
      explanation: data.explanation,
      verifiedFacts: { facts: data.verifiedFacts, matchedProducts } as unknown as Prisma.InputJsonValue,
      assumptions: assumptions as unknown as Prisma.InputJsonValue,
      model: raw.model,
    },
  });
  await db.lead.update({
    where: { id: leadId },
    data: {
      fitScore: final.total,
      ...(lead.status === "NEW" && final.total >= 70 && !data.excludedReason ? { status: "QUALIFIED" as const } : {}),
    },
  });
  return { scoreId: score.id, total: final.total, excluded: Boolean(data.excludedReason) };
}

/** Toplu puanlama işi: seller bağlamı bir kez hazırlanır; başarısız lead'lerin kredisi iade edilir. */
export async function scoreLeads(companyId: string, leadIds: string[], progress?: (pct: number) => Promise<void>) {
  const seller = await sellerContext(companyId);
  let ok = 0;
  const failed: string[] = [];
  for (let i = 0; i < leadIds.length; i++) {
    try {
      await scoreLead(companyId, leadIds[i]!, seller);
      ok++;
    } catch (err) {
      // AI tamamen erişilemezse iş yeniden denensin
      if (err instanceof AppError && err.code === "AI_UNAVAILABLE" && ok === 0) throw err;
      failed.push(leadIds[i]!);
    }
    await progress?.(((i + 1) / leadIds.length) * 95);
  }
  return { scored: ok, failed: failed.length };
}

/** Lead detay sayfası için: bu lead üzerinde çalışan araştırma/puanlama işi. */
export async function getActiveLeadJob(ctx: TenantContext, leadId: string) {
  assertCan(ctx, "lead.read");
  const db = tenantDb(ctx);
  const active = { in: ["QUEUED" as const, "RUNNING" as const] };
  const enrich = await db.job.findFirst({
    where: { type: "lead.enrich", status: active, payload: { path: ["leadId"], equals: leadId } },
    select: { id: true, type: true },
  });
  if (enrich) return enrich;
  return db.job.findFirst({
    where: { type: "lead.score", status: active, payload: { path: ["leadIds"], array_contains: [leadId] } },
    select: { id: true, type: true },
  });
}

/** Son başarısız araştırma hatası (kullanıcıya nedenini göstermek için). */
export async function getLastLeadJobError(ctx: TenantContext, leadId: string) {
  const job = await tenantDb(ctx).job.findFirst({
    where: { type: "lead.enrich", payload: { path: ["leadId"], equals: leadId } },
    orderBy: { createdAt: "desc" },
    select: { status: true, error: true, finishedAt: true },
  });
  return job?.status === "FAILED" ? job : null;
}

// ── 5) Web sitesinden kurumsal e-posta bulma (AI'sız, ücretsiz) ────────

const EMAIL_DISCOVERY_MAX = 50;

/**
 * Web sitesi olan ama e-postası olmayan lead'lerin sitesini (ana sayfa + iletişim) tarar ve
 * sayfada yazan kurumsal adresi (info@, satinalma@…) kaydeder. AI veya ücretli API kullanmaz → kredi düşmez.
 */
export async function startEmailDiscovery(ctx: TenantContext, leadIds: string[]) {
  assertCan(ctx, "lead.write");
  const db = tenantDb(ctx);
  const ids = [...new Set(leadIds)].slice(0, 200);
  const targets = await db.lead.findMany({
    where: { id: { in: ids }, website: { not: null }, genericEmail: null },
    select: { id: true },
    take: EMAIL_DISCOVERY_MAX,
  });
  if (targets.length === 0) throw new AppError("VALIDATION", "Web sitesi olup e-postası eksik lead yok.");
  const running = await db.job.findFirst({ where: { type: "lead.find_email", status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true } });
  if (running) throw new AppError("CONFLICT", "E-posta araması zaten sürüyor. Birkaç dakika sonra sayfayı yenileyin.");

  const jobId = await enqueue("lead.find_email", { leadIds: targets.map((t) => t.id) }, { companyId: ctx.companyId, createdById: ctx.userId, maxAttempts: 1 });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "lead.email_discovery.started", metadata: { count: targets.length } });
  return { jobId, count: targets.length };
}

/** İş içinden çağrılır. Bir sitenin hatası diğerlerini durdurmaz. */
export type EmailDiscoveryOutcome = "found" | "notFound" | "blocked" | "failed";
export interface EmailDiscoveryItem {
  leadId: string;
  name: string;
  outcome: EmailDiscoveryOutcome;
  /** Bulunan kurumsal adres (yalnızca "found") */
  email?: string;
  /** Kullanıcıya gösterilen neden (kişisel adresler yazılmaz — yalnızca türü söylenir) */
  reason?: string;
  /** E-posta yoksa bulunan iletişim formu sayfası — mesajı kullanıcı elle gönderir */
  contactFormUrl?: string;
}

export async function findLeadEmails(companyId: string, leadIds: string[], progress?: (pct: number) => Promise<void>) {
  const db = tenantDb({ companyId });
  const items: EmailDiscoveryItem[] = [];
  for (const [i, leadId] of leadIds.entries()) {
    const lead = await db.lead.findUnique({ where: { id: leadId }, select: { id: true, companyName: true, website: true, genericEmail: true } });
    if (!lead?.website || lead.genericEmail) continue;
    const base = { leadId, name: lead.companyName };
    if (SOCIAL_HOST.test(hostOf(lead.website))) {
      items.push({ ...base, outcome: "notFound", reason: "Web sitesi yerine sosyal medya sayfası kayıtlı; sosyal medya taranmaz." });
      await progress?.(Math.round(((i + 1) / leadIds.length) * 100));
      continue;
    }
    try {
      const crawl = await crawlSite(lead.website, { maxPages: 3, ensureContactPage: true, allowPrivateHosts: allowPrivateFetch() });
      const seen = [...new Set(crawl.pages.flatMap((p) => p.emails))];
      let email = pickCompanyEmail(seen, lead.website);
      // Sitede yazan adres geri dönecekse (alan adı posta almıyor) kaydedilmez
      if (email && (checkEmailQuality(email).blocking || (await checkMailDomain(email.split("@")[1] ?? "")) === "no_mx")) {
        items.push({ ...base, outcome: "notFound", reason: "Sitedeki e-posta adresinin alan adı posta alamıyor (ileti geri döner)." });
        email = null;
        await progress?.(Math.round(((i + 1) / leadIds.length) * 100));
        continue;
      }
      if (email) {
        // Bu arada elle girilmiş adres varsa üzerine yazılmaz
        const res = await db.lead.updateMany({ where: { id: leadId, genericEmail: null }, data: { genericEmail: email } });
        if (res.count) items.push({ ...base, outcome: "found", email });
      } else {
        // E-posta yoksa iletişim formu tek kanal olabilir: adresi kaydedilir, form DOLDURULMAZ
        const formUrl = pickContactFormUrl(crawl.pages);
        if (formUrl) await db.lead.updateMany({ where: { id: leadId }, data: { contactFormUrl: formUrl } });
        items.push({ ...base, outcome: "notFound", reason: whyNoEmail(seen, lead.website, crawl.pages.length), contactFormUrl: formUrl ?? undefined });
      }
    } catch (err) {
      // robots.txt yasağı ayrı sayılır: site açık ama taranmamızı istemiyor (buna uyulur)
      if (err instanceof FetchBlockedError) items.push({ ...base, outcome: "blocked", reason: "Site robots.txt ile otomatik taramayı yasaklıyor." });
      else items.push({ ...base, outcome: "failed", reason: (err as Error).message.slice(0, 200) });
    }
    await progress?.(Math.round(((i + 1) / leadIds.length) * 100));
  }
  const count = (o: EmailDiscoveryOutcome) => items.filter((x) => x.outcome === o).length;
  return { found: count("found"), notFound: count("notFound"), blocked: count("blocked"), failed: count("failed"), items };
}

/** Dizinlerde web sitesi yerine girilen sosyal medya / pazaryeri adresleri (taranmaz; kendi robots kuralları da yasaklar) */
const SOCIAL_HOST = /(^|\.)(instagram\.com|facebook\.com|fb\.com|linkedin\.com|twitter\.com|x\.com|youtube\.com|tiktok\.com|wa\.me|whatsapp\.com|sahibinden\.com|trendyol\.com|hepsiburada\.com|n11\.com|google\.com|business\.site|linktr\.ee)$/i;

/** extractDomain sosyal medyada bilerek null döner; burada ham host gerekir */
function hostOf(website: string): string {
  try {
    return new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Taranan sayfalar arasından iletişim formu sayfasını seçer: adresinde "iletisim/contact"
 * geçen sayfa öncelikli, yoksa formu olan ilk sayfa. Saf fonksiyon — testlerde doğrudan kullanılır.
 */
export function pickContactFormUrl(pages: Array<{ url: string; hasContactForm: boolean }>): string | null {
  const withForm = pages.filter((p) => p.hasContactForm);
  if (withForm.length === 0) return null;
  const preferred = withForm.find((p) => {
    try {
      return CONTACT_PATH.test(decodeURIComponent(new URL(p.url).pathname));
    } catch {
      return false;
    }
  });
  return (preferred ?? withForm[0]!).url;
}

/** Sitede adres varsa neden seçilmediğini adresi yazmadan açıklar */
function whyNoEmail(seen: string[], website: string, pages: number): string {
  if (seen.length === 0) return `Taranan ${pages} sayfada e-posta adresi yok (iletişim formu kullanıyor olabilir).`;
  const site = extractDomain(website);
  const sameDomain = seen.filter((e) => site && (e.endsWith(`@${site}`) || e.endsWith(`.${site}`)));
  if (sameDomain.length) return "Sitede yalnızca kişiye ait adres var; kişisel adresler otomatik alınmaz.";
  const domains = [...new Set(seen.map((e) => e.split("@")[1]).filter(Boolean))].slice(0, 2).join(", ");
  return `Sitedeki adres başka bir alan adına ait (${domains}) — grup şirketi veya ajans olabilir.`;
}

/** Son 24 saatteki e-posta araması (liste üstünde özet / ilerleme için) */
export async function getLastEmailDiscovery(ctx: TenantContext) {
  const job = await tenantDb(ctx).job.findFirst({
    where: { type: "lead.find_email", createdAt: { gte: new Date(Date.now() - 86_400_000) } },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, payload: true, result: true, error: true, finishedAt: true },
  });
  if (!job) return null;
  const total = ((job.payload as { leadIds?: string[] } | null)?.leadIds ?? []).length;
  const r = (job.result ?? {}) as { found?: number; notFound?: number; blocked?: number; failed?: number; items?: EmailDiscoveryItem[] };
  // Sonuç listesi güncel kalsın: silinen lead'ler çıkar, sonradan elle eklenen adres gösterilir
  const raw = r.items ?? [];
  const current = raw.length
    ? await tenantDb(ctx).lead.findMany({ where: { id: { in: raw.map((x) => x.leadId) } }, select: { id: true, genericEmail: true } })
    : [];
  const emailById = new Map(current.map((l) => [l.id, l.genericEmail]));
  const items = raw.filter((x) => emailById.has(x.leadId)).map((x) => ({ ...x, currentEmail: emailById.get(x.leadId) ?? null }));
  return {
    id: job.id,
    status: job.status,
    finishedAt: job.finishedAt,
    error: job.error,
    total,
    found: r.found ?? 0,
    notFound: r.notFound ?? 0,
    blocked: r.blocked ?? 0,
    failed: r.failed ?? 0,
    items,
  };
}

// ── 6) Liste sayfasından içe aktarma (OSB / fuar / dernek listeleri) ────

const LIST_CHUNK_CHARS = 25_000;
const LIST_MAX_CHUNKS = 2;

/**
 * Liste sayfası adresi VEYA yapıştırılmış metinden firma içe aktarmayı başlatır.
 * AI yalnızca metni yapılandırır; her firma ve her bilgi kaynak metinde doğrulanır (uydurma kaydedilmez).
 */
export async function startListImport(ctx: TenantContext, input: { url?: string | null; text?: string | null; filter?: string | null; render?: boolean }) {
  assertCan(ctx, "lead.write");
  if (!isAIConfigured()) throw new AppError("AI_UNAVAILABLE", "Listeden içe aktarma için AI gerekli (sunucuda AI yapılandırılmamış).");
  const url = input.url?.trim() || null;
  const text = input.text?.trim() || null;
  // Tarayıcıyla açma yalnızca adresle anlamlı ve ek maliyetli (Apify çalıştırması) → kredi iki katı
  const render = Boolean(input.render) && Boolean(url);
  if (render && !isRenderConfigured()) throw new AppError("VALIDATION", "Tarayıcıyla açma kapalı (APIFY_TOKEN tanımlı değil).");
  if (!url && !text) throw new AppError("VALIDATION", "Liste sayfasının adresini girin veya listeyi metin olarak yapıştırın.", { url: "Adres veya metin gerekli" });
  if (url && text) throw new AppError("VALIDATION", "Adres veya metinden yalnızca birini kullanın.");
  if (text && text.length < 40) throw new AppError("VALIDATION", "Yapıştırılan metin çok kısa.", { text: "En az birkaç firma satırı" });
  if (url) {
    try {
      normalizeUrl(url);
    } catch (err) {
      throw new AppError("VALIDATION", (err as Error).message, { url: "Geçersiz adres" });
    }
  }
  const db = tenantDb(ctx);
  const running = await db.job.findFirst({ where: { type: "lead.list_import", status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true } });
  if (running) throw new AppError("CONFLICT", "Bir liste zaten işleniyor. Bitince yenisini başlatabilirsiniz.");

  const { usageId } = await consumeCredits({
    companyId: ctx.companyId,
    operation: "lead.list_import",
    quantity: render ? 2 : 1,
    userId: ctx.userId,
    refType: "lead.list_import",
  });
  let jobId: string;
  try {
    jobId = await enqueue(
      "lead.list_import",
      { url, text: text?.slice(0, LIST_CHUNK_CHARS * LIST_MAX_CHUNKS) ?? null, usageId, filter: parseListFilter(input.filter), render },
      { companyId: ctx.companyId, createdById: ctx.userId, maxAttempts: 2 },
    );
  } catch (err) {
    await refundCredits(usageId, "lead.list_import.enqueue_failed");
    throw err;
  }
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "lead.list_import.started", metadata: { url, pasted: Boolean(text) } });
  return { jobId };
}

/** Liste adı: "dosb.com.tr · kimya · 25 Eyl" gibi okunur bir ad */
function listName(url: string | null | undefined, filter: string[]): string {
  let base = "Yapıştırılan liste";
  if (url) {
    try {
      base = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "");
    } catch {
      /* geçersiz adres → varsayılan ad */
    }
  }
  const date = new Date().toLocaleDateString("tr-TR", { day: "numeric", month: "short", timeZone: "Europe/Istanbul" });
  return [base, filter.slice(0, 2).join(", "), date].filter(Boolean).join(" · ");
}

/** Metni satır sınırlarından parçalara böler (AI çıktı sınırı için) */
function chunkLines(text: string, size: number, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur.length + line.length + 1 > size && cur) {
      out.push(cur);
      if (out.length === max) return out;
      cur = "";
    }
    cur += `${line}\n`;
  }
  if (cur.trim() && out.length < max) out.push(cur);
  return out;
}

/** Telefonun son 10 hanesi metinde (ayraçlarla da olsa) geçiyor mu */
function phoneFound(phone: string, text: string): boolean {
  const d = phone.replace(/\D/g, "").slice(-10);
  if (d.length < 10) return false;
  return new RegExp(d.split("").join("[\\s().\\-/]*")).test(text);
}

/**
 * AI çıktısını kaynak metne karşı doğrular. Saf fonksiyon — testlerde doğrudan kullanılır.
 * Metinde geçmeyen firma atılır; metinde geçmeyen alanlar boşaltılır; kişisel e-posta alınmaz.
 */
export function verifyListCompanies(items: ListImportOutput["companies"], text: string, sourceUrl: string | null) {
  const normText = normalizeForMatch(text);
  const lowerText = text.toLowerCase();
  const seen = new Set<string>();
  const leads: RawLead[] = [];
  let dropped = 0;
  for (const c of items) {
    const key = normalizeForMatch(c.name);
    if (!valueFound(c.name, text) || key.length < 2 || seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    const domain = c.website ? extractDomain(c.website) : null;
    const website = domain && normText.includes(normalizeForMatch(domain)) ? domain : null;
    const email = c.email ? normalizeEmail(c.email) : null;
    const genericEmail = email && lowerText.includes(email) && isCompanyEmail(email, website) ? email : null;
    const keep = (v: string | null) => (v && valueFound(v, text) ? v : null);
    leads.push({
      companyName: c.name.trim(),
      website: website ?? undefined,
      phone: c.phone && phoneFound(c.phone, text) ? c.phone : undefined,
      genericEmail: genericEmail ?? undefined,
      city: keep(c.city) ?? undefined,
      district: keep(c.district) ?? undefined,
      category: keep(c.sector) ?? undefined,
      sourceType: "DIRECTORY",
      sourceUrl: sourceUrl ?? undefined,
    });
  }
  return { leads, dropped };
}

/** İş içinden çağrılır */
export async function importFromList(
  companyId: string,
  payload: { url?: string | null; text?: string | null; filter?: string[]; render?: boolean },
  progress?: (pct: number) => Promise<void>,
  list?: { jobId: string; createdById?: string | null },
) {
  const filter = payload.filter ?? [];
  let text = payload.text ?? "";
  let sourceUrl: string | null = null;
  if (payload.url) {
    const page = await fetchListPage(payload.url, { allowPrivateHosts: allowPrivateFetch(), render: payload.render });
    text = page.text;
    sourceUrl = page.finalUrl;
    // Yapılandırılmış veri (DataTables) varsa AI'sız, birebir eşleştirme — hızlı, ücretsiz, uydurma riski yok
    const mapped = page.records ? mapStructuredRecords(page.records, sourceUrl) : null;
    if (mapped && mapped.leads.length > 0) {
      await progress?.(50);
      const matching = applyListFilter(mapped.leads, filter);
      const leads = matching.slice(0, STRUCTURED_MAX);
      const listId = list ? await ensureJobList(companyId, { jobId: list.jobId, name: listName(payload.url, filter), kind: "IMPORT", createdById: list.createdById }) : undefined;
      const saved = await saveDiscoveredLeads(companyId, leads, { provider: "directory", listId, ownerId: list?.createdById ?? null });
      await queueEcommerceCheckAfterImport(companyId, saved.leadIds, list?.createdById ?? null);
      return {
        sourceUrl,
        structured: true,
        truncated: matching.length > STRUCTURED_MAX,
        extracted: page.records!.length,
        dropped: mapped.dropped,
        filteredOut: mapped.leads.length - matching.length,
        created: saved.created,
        merged: saved.merged,
      };
    }
  }
  if (text.replace(/\s+/g, "").length < 40) {
    throw new AppError(
      "VALIDATION",
      payload.render
        ? "Sayfa tarayıcıyla açıldı ama liste bulunamadı. Listeyi kopyalayıp metin olarak yapıştırın."
        : "Sayfada okunabilir liste bulunamadı (içerik JavaScript ile yükleniyor olabilir). \"Tarayıcıyla aç\" seçeneğini işaretleyip tekrar deneyin veya listeyi kopyalayıp metin olarak yapıştırın.",
    );
  }
  await progress?.(20);

  const chunks = chunkLines(text, LIST_CHUNK_CHARS, LIST_MAX_CHUNKS);
  const extracted: ListImportOutput["companies"] = [];
  for (const [i, chunk] of chunks.entries()) {
    const { data } = await ai({ companyId, operation: "lead.list_import" }).extract({
      schema: listImportSchema,
      instructions: LIST_IMPORT_INSTRUCTIONS,
      shape: LIST_IMPORT_SHAPE,
      input: untrusted("company-list", chunk, LIST_CHUNK_CHARS + 1000),
      maxTokens: 12_000,
    });
    extracted.push(...data.companies);
    await progress?.(20 + Math.round(((i + 1) / chunks.length) * 60));
  }

  const verified = verifyListCompanies(extracted, text, sourceUrl);
  const { dropped } = verified;
  const leads = applyListFilter(verified.leads, filter);
  const listId2 = list && leads.length ? await ensureJobList(companyId, { jobId: list.jobId, name: listName(payload.url, filter), kind: "IMPORT", createdById: list.createdById }) : undefined;
  const saved = leads.length ? await saveDiscoveredLeads(companyId, leads, { provider: "directory", listId: listId2, ownerId: list?.createdById ?? null }) : { created: 0, merged: 0, leadIds: [] };
  await queueEcommerceCheckAfterImport(companyId, saved.leadIds, list?.createdById ?? null);
  return {
    sourceUrl,
    structured: false,
    filteredOut: verified.leads.length - leads.length,
    truncated: text.length > LIST_CHUNK_CHARS * LIST_MAX_CHUNKS,
    extracted: extracted.length,
    dropped,
    created: saved.created,
    merged: saved.merged,
  };
}

/** Son 24 saatteki listeden içe aktarma (ilerleme / özet için) */
export async function getLastListImport(ctx: TenantContext) {
  const job = await tenantDb(ctx).job.findFirst({
    where: { type: "lead.list_import", createdAt: { gte: new Date(Date.now() - 86_400_000) } },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, payload: true, result: true, error: true, finishedAt: true },
  });
  if (!job) return null;
  const p = job.payload as { url?: string | null };
  const r = (job.result ?? {}) as { extracted?: number; dropped?: number; created?: number; merged?: number; truncated?: boolean; structured?: boolean; filteredOut?: number };
  return { id: job.id, status: job.status, error: job.error, finishedAt: job.finishedAt, url: p.url ?? null, ...r };
}

/** "otomotiv, makina; pres" → ["otomotiv","makina","pres"] (en fazla 10) */
export function parseListFilter(input: string | null | undefined): string[] {
  return (input ?? "")
    .split(/[,;\n]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2)
    .slice(0, 10);
}

/** Filtre verildiyse yalnızca sektöründe veya adında kelimelerden biri geçen firmalar (Türkçe harf farkı gözetilmez) */
export function applyListFilter(leads: RawLead[], filter: string[]): RawLead[] {
  if (!filter.length) return leads;
  const words = filter.map(normalizeForMatch).filter(Boolean);
  return leads.filter((l) => {
    const hay = normalizeForMatch(`${l.category ?? ""} ${l.companyName}`);
    return words.some((w) => hay.includes(w));
  });
}

/** Yapılandırılmış listede tek seferde en fazla içe aktarılan firma */
const STRUCTURED_MAX = 1000;

const FIELD_KEYS: Record<"name" | "phone" | "email" | "website" | "sector" | "address" | "city" | "district", RegExp> = {
  name: /^(company_?name|single_?company_?name|firma_?(adi|unvani?|ismi)?|unvan|ticari_?unvan|company|name|title|firma)$/i,
  phone: /^(phone(_?no|_?number)?|tel(efon)?(_?no)?|gsm)$/i,
  email: /^(e?_?mail|e_?posta|eposta)$/i,
  website: /^(web_?site|website|web|url|site|internet_?adresi)$/i,
  sector: /^(sector(_?name)?|sektor(_?adi)?|faaliyet(_?alani)?|category|kategori)$/i,
  address: /^(address|adres|parcel_?address|acik_?adres)$/i,
  city: /^(city|il|sehir)$/i,
  district: /^(district|ilce|region|bolge)$/i,
};

const stripTags = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  return s && s !== "-" && s.toLowerCase() !== "null" ? s : null;
};

/**
 * Yapılandırılmış liste satırlarını (DataTables JSON) AI olmadan lead'e çevirir. Saf fonksiyon.
 * Alan adları tanınmazsa null döner (AI ile metinden çıkarmaya düşülür). Değerler kaynaktan birebir alınır.
 */
export function mapStructuredRecords(records: Array<Record<string, unknown>>, sourceUrl: string | null) {
  const keys = Object.keys(records[0] ?? {});
  const pick = (field: keyof typeof FIELD_KEYS) => keys.find((k) => FIELD_KEYS[field].test(k.replace(/[\s-]/g, "_")));
  const k = { name: pick("name"), phone: pick("phone"), email: pick("email"), website: pick("website"), sector: pick("sector"), address: pick("address"), city: pick("city"), district: pick("district") };
  if (!k.name) return null;

  const seen = new Set<string>();
  const leads: RawLead[] = [];
  let dropped = 0;
  for (const r of records) {
    const name = stripTags(r[k.name]);
    const key = name ? normalizeForMatch(name) : "";
    if (!name || key.length < 2 || seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    const website = k.website ? extractDomain(stripTags(r[k.website]) ?? "") : null;
    const email = k.email ? normalizeEmail(stripTags(r[k.email])) : null;
    const phone = k.phone ? stripTags(r[k.phone]) : null;
    leads.push({
      companyName: name.slice(0, 300),
      website: website ?? undefined,
      phone: phone && normalizePhone(phone) ? phone : undefined,
      // Kişisel adres (ahmet@…) firma genel e-postası olarak alınmaz
      genericEmail: email && isCompanyEmail(email, website) ? email : undefined,
      address: (k.address && stripTags(r[k.address])?.slice(0, 500)) || undefined,
      city: (k.city && stripTags(r[k.city])?.slice(0, 80)) || undefined,
      district: (k.district && stripTags(r[k.district])?.slice(0, 120)) || undefined,
      category: (k.sector && stripTags(r[k.sector])?.slice(0, 200)) || undefined,
      sourceType: "DIRECTORY",
      sourceUrl: sourceUrl ?? undefined,
    });
  }
  return { leads, dropped };
}

// ── 7) "Hazırla": e-posta bul → araştır → puanla (tek zincir) ──────────

/** Bir "Hazırla" çalıştırmasında en fazla lead (AI maliyeti ve süre) */
export const PREPARE_MAX = 50;

export interface PrepareSteps {
  email: boolean;
  research: boolean;
  score: boolean;
}

export interface PreparePlanItem {
  leadId: string;
  /** Web sitesinden kurumsal e-posta (AI'sız, ücretsiz) — araştırılacak lead'de araştırma zaten bulur */
  email: boolean;
  /** AI araştırma + puanlama (lead.enrich, 2 kredi) */
  research: boolean;
  /** Yalnızca puanlama (lead.score, 1 kredi) */
  score: boolean;
}

/** Seçilen lead'ler için adım planı ve kredi tahmini (kredi düşmez) */
export async function planPreparation(ctx: TenantContext, leadIds: string[], steps: PrepareSteps) {
  assertCan(ctx, "lead.read");
  const leads = await tenantDb(ctx).lead.findMany({
    where: { id: { in: [...new Set(leadIds)] } },
    select: { id: true, website: true, genericEmail: true, lastVerifiedAt: true },
    take: PREPARE_MAX,
  });
  const plan: PreparePlanItem[] = leads.map((l) => {
    const hasSite = Boolean(l.website);
    const research = steps.research && hasSite;
    return {
      leadId: l.id,
      research,
      email: steps.email && hasSite && !l.genericEmail && !research,
      score: !research && steps.score,
    };
  });
  const research = plan.filter((p) => p.research).length;
  const scoreOnly = plan.filter((p) => p.score).length;
  const emailOnly = plan.filter((p) => p.email).length;
  const credits = research * CREDIT_COSTS["lead.enrich"] + scoreOnly * CREDIT_COSTS["lead.score"];
  return { plan: plan.filter((p) => p.research || p.score || p.email), research, scoreOnly, emailOnly, credits, capped: leadIds.length > PREPARE_MAX };
}

/** "Hazırla"yı başlatır: kredi önden ayrılır, iş sırayla yürür, yapılamayan adımın kredisi iade edilir */
export async function startPreparation(ctx: TenantContext, leadIds: string[], steps: PrepareSteps) {
  assertCan(ctx, "lead.write");
  if (!steps.email && !steps.research && !steps.score) throw new AppError("VALIDATION", "En az bir adım seçin.");
  if ((steps.research || steps.score) && !isAIConfigured()) throw new AppError("AI_UNAVAILABLE", "Araştırma ve puanlama için AI gerekli (sunucuda AI yapılandırılmamış).");
  const db = tenantDb(ctx);
  const running = await db.job.findFirst({ where: { type: "lead.prepare", status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true } });
  if (running) throw new AppError("CONFLICT", "Bir hazırlık zaten sürüyor. Bitince yenisini başlatabilirsiniz.");

  const p = await planPreparation(ctx, leadIds, steps);
  if (p.plan.length === 0) throw new AppError("VALIDATION", "Seçilen firmalarda yapılacak adım yok (web sitesi yok veya e-postası zaten var).");

  let enrichUsageId: string | undefined;
  let scoreUsageId: string | undefined;
  try {
    if (p.research) enrichUsageId = (await consumeCredits({ companyId: ctx.companyId, operation: "lead.enrich", quantity: p.research, userId: ctx.userId, refType: "lead.prepare" })).usageId;
    if (p.scoreOnly) scoreUsageId = (await consumeCredits({ companyId: ctx.companyId, operation: "lead.score", quantity: p.scoreOnly, userId: ctx.userId, refType: "lead.prepare" })).usageId;
  } catch (err) {
    // İkinci düşüm başarısızsa (yetersiz kredi) ilki geri verilir
    if (enrichUsageId) await refundCredits(enrichUsageId, "lead.prepare.insufficient");
    throw err;
  }
  let jobId: string;
  try {
    jobId = await enqueue("lead.prepare", { plan: p.plan, enrichUsageId, scoreUsageId }, { companyId: ctx.companyId, createdById: ctx.userId, maxAttempts: 1 });
  } catch (err) {
    if (enrichUsageId) await refundCredits(enrichUsageId, "lead.prepare.enqueue_failed");
    if (scoreUsageId) await refundCredits(scoreUsageId, "lead.prepare.enqueue_failed");
    throw err;
  }
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "lead.prepare.started", metadata: { count: p.plan.length, credits: p.credits } });
  return { jobId, ...p };
}

/**
 * İş içinden çağrılır. Her lead için sırayla: araştır+puanla (site açılmazsa yalnızca puanla) / yalnızca puanla / e-posta bul.
 * Kullanılmayan kredi iade edilir. Bir lead'in hatası diğerlerini durdurmaz.
 */
export async function runPreparation(
  companyId: string,
  payload: { plan: PreparePlanItem[]; enrichUsageId?: string; scoreUsageId?: string },
  progress?: (pct: number) => Promise<void>,
) {
  const db = tenantDb({ companyId });
  const seller = await sellerContext(companyId);
  let researched = 0;
  let scored = 0;
  let emailsFound = 0;
  let failed = 0;
  let enrichRefund = 0;
  let scoreRefund = 0;
  for (const [i, item] of payload.plan.entries()) {
    const exists = await db.lead.findUnique({ where: { id: item.leadId }, select: { id: true, website: true, genericEmail: true } });
    if (!exists) {
      // Bu arada silinmiş
      if (item.research) enrichRefund += CREDIT_COSTS["lead.enrich"];
      if (item.score) scoreRefund += CREDIT_COSTS["lead.score"];
      continue;
    }
    if (item.research) {
      let researchOk = false;
      try {
        await researchLead(companyId, item.leadId);
        researchOk = true;
        researched++;
      } catch {
        /* site açılmadı / okunamadı → mevcut veriyle puanlanır */
      }
      try {
        await scoreLead(companyId, item.leadId, seller);
        scored++;
        // Araştırma yapılamadıysa yalnızca puanlama ücreti kalır
        if (!researchOk) enrichRefund += CREDIT_COSTS["lead.enrich"] - CREDIT_COSTS["lead.score"];
      } catch {
        failed++;
        enrichRefund += researchOk ? CREDIT_COSTS["lead.score"] : CREDIT_COSTS["lead.enrich"];
      }
    } else if (item.score) {
      try {
        await scoreLead(companyId, item.leadId, seller);
        scored++;
      } catch {
        failed++;
        scoreRefund += CREDIT_COSTS["lead.score"];
      }
    }
    if (item.email && exists.website && !exists.genericEmail) {
      const res = await findLeadEmails(companyId, [item.leadId]).catch(() => null);
      if (res?.found) emailsFound++;
    }
    await progress?.(Math.round(((i + 1) / payload.plan.length) * 95));
  }
  if (payload.enrichUsageId && enrichRefund > 0) await refundCredits(payload.enrichUsageId, "lead.prepare.partial", enrichRefund);
  if (payload.scoreUsageId && scoreRefund > 0) await refundCredits(payload.scoreUsageId, "lead.prepare.partial", scoreRefund);

  // Araştırma sırasında bulunan e-postalar da sayılır
  const withEmail = await db.lead.count({ where: { id: { in: payload.plan.map((p) => p.leadId) }, genericEmail: { not: null } } });
  const top = await db.lead.findMany({
    where: { id: { in: payload.plan.map((p) => p.leadId) }, fitScore: { not: null } },
    orderBy: { fitScore: "desc" },
    take: 5,
    select: { id: true, companyName: true, fitScore: true },
  });
  const high = await db.lead.count({ where: { id: { in: payload.plan.map((p) => p.leadId) }, fitScore: { gte: 70 } } });
  return { total: payload.plan.length, researched, scored, emailsFound, withEmail, high, failed, refunded: enrichRefund + scoreRefund, top };
}

/** Son 24 saatteki hazırlık (ilerleme / özet) */
export async function getLastPreparation(ctx: TenantContext) {
  const job = await tenantDb(ctx).job.findFirst({
    where: { type: "lead.prepare", createdAt: { gte: new Date(Date.now() - 86_400_000) } },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, result: true, error: true, finishedAt: true, payload: true },
  });
  if (!job) return null;
  const r = (job.result ?? {}) as Partial<Awaited<ReturnType<typeof runPreparation>>>;
  const plan = ((job.payload as { plan?: PreparePlanItem[] } | null)?.plan ?? []) as PreparePlanItem[];
  // Hangi adımların gerçekten planlandığı (özet "ne yapıldı" diyebilsin)
  const steps = {
    email: plan.some((p) => p.email),
    research: plan.some((p) => p.research),
    score: plan.some((p) => p.score),
  };
  return { id: job.id, status: job.status, error: job.error, finishedAt: job.finishedAt, total: plan.length, steps, ...r };
}

// ── 8) Firma adından web sitesi bulma ─────────────────────────────────

/** Tek çalıştırmada en fazla firma (her firma bir Google araması) */
export const WEBSITE_DISCOVERY_MAX = 50;
/** Ad benzerliği bu eşiğin altındaysa site kabul edilmez (yanlış firma bağlanmasın) */
const NAME_MATCH_MIN = 0.34;

export interface WebsiteMatch {
  leadId: string;
  name: string;
  website: string | null;
  reason?: string;
}

/**
 * Ünvan ekleri: arama sonucunu bozar, sorgudan atılır ("A.S." noktasızken "a" ve "s" olarak gelir).
 * Türkçe ve yurt dışı ekleri birlikte tutulur — bir firma adı yalnızca bu eklerden oluşmaz,
 * dolayısıyla hepsini birden elemek güvenli.
 */
const COMPANY_SUFFIXES = new Set([
  // Türkçe
  "san", "sanayi", "tic", "ticaret", "ltd", "limited", "sti", "a", "as", "s", "anonim", "sirketi",
  "kollektif", "koll", "ve", "ith", "ithalat", "ihr", "ihracat", "paz", "pazarlama", "muh",
  "muhendislik", "ins", "insaat", "taah", "taahhut", "tur", "turizm",
  // Yurt dışı
  "inc", "llc", "lp", "llp", "corp", "corporation", "co", "company", "plc", "gmbh", "mbh", "ag", "kg",
  "bv", "nv", "sa", "sas", "sarl", "srl", "spa", "sl", "oy", "ab", "aps", "kft", "doo", "zoo",
  "pte", "pty", "sdn", "bhd", "the", "and",
]);

/** Sorgu dili: firma yurt dışındaysa İngilizce arama daha isabetli sonuç verir. */
export type SearchLang = "tr" | "en";

/** Ülke koduna göre sorgu dili. Ülke yoksa Türkiye varsayılır (ana pazar). */
export function searchLangForCountry(country?: string | null): SearchLang {
  const c = (country ?? "").trim().toLowerCase();
  if (!c) return "tr";
  return c === "tr" || c === "turkey" || c === "türkiye" || c === "turkiye" ? "tr" : "en";
}

/** Firma adını arama sorgusuna çevirir: ünvan ekleri ("San. Tic. Ltd. Şti.", "Inc.", "GmbH") aramayı bozar, atılır */
export function websiteQuery(companyName: string, city?: string | null, lang: SearchLang = "tr"): string {
  const cleaned = companyName
    .replace(/\(.*?\)/g, " ")
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    // normalizeForMatch: Türkçe harfleri sadeleştirir (TİC → tic, ŞTİ → sti)
    .filter((w) => w && !COMPANY_SUFFIXES.has(normalizeForMatch(w)))
    .join(" ")
    .trim();
  const base = (cleaned.length >= 4 ? cleaned : companyName).slice(0, 80);
  return [base, city, lang === "en" ? "official website" : "resmi web sitesi"].filter(Boolean).join(" ");
}

/**
 * Arama sonuçlarından firmanın sitesini seçer. Saf fonksiyon — testlerde doğrudan kullanılır.
 * Kural: alan adı ya da sayfa başlığı firma adıyla örtüşmeli; dizin / pazaryeri / sosyal medya elenir.
 */
export function pickWebsite(companyName: string, results: Array<{ title: string; url: string }>): { website: string | null; reason?: string } {
  let best: { website: string; score: number } | null = null;
  for (const r of results.slice(0, 10)) {
    let url: URL;
    try {
      url = new URL(r.url);
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (isNonCompanyHost(host)) continue;
    const domain = extractDomain(host);
    if (!domain) continue;

    const token = domain.split(".")[0]!.replace(/-/g, "");
    const nameNorm = normalizeForMatch(companyName).replace(/\s+/g, "");
    // Alan adı firma adının içinde geçiyorsa (ör. "assanaluminyum" ↔ assanaluminyum.com.tr) en güçlü kanıt
    const domainMatch = token.length >= 5 && (nameNorm.includes(token) || token.includes(nameNorm.slice(0, Math.min(12, nameNorm.length))));
    const titleScore = nameSimilarity(companyName, r.title);
    const score = domainMatch ? 1 : titleScore;
    if (score >= NAME_MATCH_MIN && (!best || score > best.score)) best = { website: `${url.protocol}//${url.hostname}/`, score };
  }
  if (!best) return { website: null, reason: results.length ? "Arama sonuçlarında firma adıyla eşleşen site bulunamadı." : "Arama sonucu dönmedi." };
  return { website: best.website };
}

/** Firma adından site bulmayı başlatır (her firma 1 kredi; bulunamayanların kredisi iade edilir) */
export async function startWebsiteDiscovery(ctx: TenantContext, leadIds: string[]) {
  assertCan(ctx, "lead.write");
  if (!isWebSearchConfigured()) throw new AppError("VALIDATION", "Web araması kapalı (APIFY_TOKEN tanımlı değil).");
  const db = tenantDb(ctx);
  const targets = await db.lead.findMany({
    where: { id: { in: [...new Set(leadIds)] }, website: null },
    select: { id: true },
    take: WEBSITE_DISCOVERY_MAX,
  });
  if (targets.length === 0) throw new AppError("VALIDATION", "Seçilenlerin hepsinde web sitesi zaten var.");
  const running = await db.job.findFirst({ where: { type: "lead.find_website", status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true } });
  if (running) throw new AppError("CONFLICT", "Bir site araması zaten sürüyor. Bitince yenisini başlatabilirsiniz.");

  const { usageId } = await consumeCredits({
    companyId: ctx.companyId,
    operation: "lead.discovery",
    quantity: targets.length,
    userId: ctx.userId,
    refType: "lead.find_website",
  });
  let jobId: string;
  try {
    jobId = await enqueue("lead.find_website", { leadIds: targets.map((t) => t.id), usageId }, { companyId: ctx.companyId, createdById: ctx.userId, maxAttempts: 2 });
  } catch (err) {
    await refundCredits(usageId, "lead.find_website.enqueue_failed");
    throw err;
  }
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "lead.website_discovery.started", metadata: { count: targets.length } });
  return { jobId, count: targets.length, cost: targets.length * CREDIT_COSTS["lead.discovery"] };
}

/** İş içinden çağrılır: tek Apify araması ile tüm firmalar sorgulanır, sonuçlar ada göre eşlenir. */
export async function runWebsiteDiscovery(
  companyId: string,
  payload: { leadIds: string[]; usageId?: string; runId?: string },
  helpers?: { progress?: (pct: number) => Promise<void>; saveRunId?: (runId: string) => Promise<void> },
) {
  const db = tenantDb({ companyId });
  const leads = await db.lead.findMany({ where: { id: { in: payload.leadIds }, website: null }, select: { id: true, companyName: true, city: true, country: true } });
  if (leads.length === 0) return { total: 0, found: 0, notFound: 0, items: [] as WebsiteMatch[] };

  const provider = getWebSearchProvider();
  // Sorgu dili firma bazında; arama motorunun ülke/dil ayarı tek olduğu için çoğunluğa göre belirlenir
  const langs = leads.map((l) => searchLangForCountry(l.country));
  const queries = leads.map((l, i) => websiteQuery(l.companyName, l.city, langs[i]!));
  const dominant: SearchLang = langs.filter((x) => x === "en").length > langs.length / 2 ? "en" : "tr";
  let runId = payload.runId;
  if (!runId) {
    runId = await provider.startRawSearch(queries, { lang: dominant });
    await helpers?.saveRunId?.(runId);
  }
  await helpers?.progress?.(15);

  let results: Map<string, Array<{ title: string; url: string }>> | null = null;
  for (let i = 0; i < 60 && !results; i++) {
    results = await provider.fetchRawResults(runId);
    if (!results) {
      await helpers?.progress?.(15 + Math.min(60, i * 2));
      await new Promise((r) => setTimeout(r, process.env.NODE_ENV === "test" ? 5 : 10_000));
    }
  }
  if (!results) throw new AppError("EXTERNAL_FETCH", "Web araması henüz sonuç üretmedi; iş tekrar denenecek.");

  const items: WebsiteMatch[] = [];
  for (const [i, lead] of leads.entries()) {
    const found = pickWebsite(lead.companyName, results.get(queries[i]!) ?? []);
    if (found.website) {
      const domain = extractDomain(found.website);
      // Aynı alan adı başka firmaya kayıtlıysa bağlama (yanlış eşleşme / tekrar kaydı önler)
      const taken = domain ? await db.lead.findFirst({ where: { domain, id: { not: lead.id } }, select: { id: true } }) : null;
      if (taken) items.push({ leadId: lead.id, name: lead.companyName, website: null, reason: "Bulunan site başka bir firmaya kayıtlı." });
      else {
        await db.lead.update({ where: { id: lead.id }, data: { website: found.website, domain } });
        items.push({ leadId: lead.id, name: lead.companyName, website: found.website });
      }
    } else {
      items.push({ leadId: lead.id, name: lead.companyName, website: null, reason: found.reason });
    }
    await helpers?.progress?.(75 + Math.round(((i + 1) / leads.length) * 20));
  }

  const found = items.filter((x) => x.website).length;
  // Bulunamayanların kredisi iade edilir
  const refund = (payload.leadIds.length - found) * CREDIT_COSTS["lead.discovery"];
  if (payload.usageId && refund > 0) await refundCredits(payload.usageId, "lead.find_website.unused", refund);
  return { total: leads.length, found, notFound: leads.length - found, items };
}

/** Son 24 saatteki site araması (özet / ilerleme) */
export async function getLastWebsiteDiscovery(ctx: TenantContext) {
  const job = await tenantDb(ctx).job.findFirst({
    where: { type: "lead.find_website", createdAt: { gte: new Date(Date.now() - 86_400_000) } },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, result: true, error: true, finishedAt: true },
  });
  if (!job) return null;
  const r = (job.result ?? {}) as { total?: number; found?: number; notFound?: number; items?: WebsiteMatch[] };
  return { id: job.id, status: job.status, error: job.error, finishedAt: job.finishedAt, total: r.total ?? 0, found: r.found ?? 0, notFound: r.notFound ?? 0, items: r.items ?? [] };
}
