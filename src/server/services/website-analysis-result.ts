import "server-only";
import type { FactSource, Prisma } from "@prisma/client";
import { tenantDb } from "@/server/tenancy/tenant-db";
import type { FactKey } from "@/lib/facts";
import type { WebsiteAnalysisOutput } from "@/server/ai/prompts/website-analysis";
import type { CrawlResult } from "@/server/web/fetch-site";
import { evidenceFound, valueFound } from "./evidence";

// ── Analiz çıktısını fact'lere dönüştürme ─────────────────────────────

export interface FactDraft {
  key: FactKey;
  value: string;
  sourceRef: string | null;
  confidence: number;
  source: FactSource;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * AI çıktısını CompanyFact taslaklarına çevirir ve her birini kaynak metinle karşılaştırır.
 * - Kanıtı sayfada bulunan öğe: confidence 0.9
 * - AI çıkarımı (inferred): confidence 0.5, source AI_INFERRED
 * - Kanıtı bulunamayan öğe: confidence 0.3
 * - Sertifika ve üretim kapasitesi: kanıt veya değer sayfada YOKSA tamamen atılır (uydurma riski).
 * Deterministik çıkarılan e-posta/telefon/SEO başlıkları confidence 1.0.
 */
export function buildFactDrafts(output: WebsiteAnalysisOutput, crawl: CrawlResult): FactDraft[] {
  const corpusByUrl = new Map(crawl.pages.map((p) => [p.url, `${p.title} ${p.metaDescription} ${p.headings.join(" ")} ${p.text}`]));
  const fullCorpus = [...corpusByUrl.values()].join(" ");
  const drafts: FactDraft[] = [];
  const seen = new Set<string>();

  const push = (d: FactDraft) => {
    const value = clean(d.value);
    if (!value) return;
    const sig = `${d.key}:${value.toLocaleLowerCase("tr-TR")}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    drafts.push({ ...d, value });
  };

  type Item = { value: string; sourceUrl?: string | null; evidence?: string | null; inferred?: boolean };
  const addItem = (key: FactKey, it: Item, strict = false) => {
    const corpus = (it.sourceUrl && corpusByUrl.get(it.sourceUrl)) || fullCorpus;
    const hasEvidence = evidenceFound(it.evidence, corpus) || evidenceFound(it.evidence, fullCorpus);
    const valueInText = valueFound(it.value, fullCorpus);
    if (strict && !hasEvidence && !valueInText) return;
    if (it.inferred) {
      push({ key, value: it.value, sourceRef: it.sourceUrl ?? null, confidence: 0.5, source: "AI_INFERRED" });
      return;
    }
    push({
      key,
      value: it.value,
      sourceRef: it.sourceUrl ?? null,
      confidence: hasEvidence || valueInText ? 0.9 : 0.3,
      source: "WEBSITE",
    });
  };

  if (output.companyDescription) addItem("description", { value: output.companyDescription, sourceUrl: crawl.homeUrl, evidence: null });
  if (output.sector) addItem("sector", { value: output.sector, sourceUrl: crawl.homeUrl, inferred: !valueFound(output.sector, fullCorpus) });
  if (output.subSector) addItem("sub_sector", { value: output.subSector, sourceUrl: crawl.homeUrl, inferred: !valueFound(output.subSector, fullCorpus) });
  if (output.businessModel !== "UNKNOWN") {
    push({ key: "business_model", value: output.businessModel, sourceRef: crawl.homeUrl, confidence: 0.6, source: "AI_INFERRED" });
  }
  for (const p of output.products) {
    addItem("product", {
      value: [p.name, p.description].filter(Boolean).join(" — "),
      sourceUrl: p.sourceUrl,
      evidence: p.evidence ?? p.name,
    });
  }
  for (const c of output.productCategories) addItem("product_category", { value: c, evidence: c });
  for (const s of output.services) addItem("service", s);
  for (const s of output.industriesServed) addItem("industry_served", s);
  for (const s of output.targetCustomers) addItem("target_customer", s);
  for (const s of output.technicalCapabilities) addItem("capability", s);
  for (const s of output.certifications) addItem("certification", { ...s, inferred: false }, true);
  if (output.productionCapacity) addItem("production_capacity", { ...output.productionCapacity, inferred: false }, true);
  for (const s of output.advantages) addItem("advantage", s);
  for (const s of output.locations) addItem("location", s);
  if (output.address) addItem("address", { value: output.address, evidence: output.address });
  for (const k of output.keyPhrases) addItem("key_phrase", { value: k, evidence: k });

  // Deterministik çıkarımlar (AI'dan bağımsız)
  const emails = new Set(crawl.pages.flatMap((p) => p.emails));
  const phones = new Set(crawl.pages.flatMap((p) => p.phones));
  for (const e of [...emails].slice(0, 8)) push({ key: "contact_email", value: e, sourceRef: crawl.homeUrl, confidence: 1, source: "WEBSITE" });
  for (const p of [...phones].slice(0, 8)) push({ key: "contact_phone", value: p, sourceRef: crawl.homeUrl, confidence: 1, source: "WEBSITE" });
  for (const page of crawl.pages.slice(0, 8)) {
    if (page.title) push({ key: "seo_title", value: page.title, sourceRef: page.url, confidence: 1, source: "WEBSITE" });
  }

  return drafts;
}

/**
 * Analiz sonucunu kaydeder: önceki analizden kalan ONAYLANMAMIŞ web fact'leri silinir,
 * zaten onaylı/reddedilmiş aynı değerler tekrar eklenmez.
 */
export async function persistAnalysis(
  companyId: string,
  analysisId: string,
  output: WebsiteAnalysisOutput,
  crawl: CrawlResult,
) {
  const db = tenantDb({ companyId });
  const drafts = buildFactDrafts(output, crawl);

  const reviewed = await db.companyFact.findMany({
    where: { status: { in: ["VERIFIED", "REJECTED"] } },
    select: { key: true, value: true },
  });
  const reviewedSigs = new Set(reviewed.map((f) => `${f.key}:${f.value.toLocaleLowerCase("tr-TR")}`));
  const fresh = drafts.filter((d) => !reviewedSigs.has(`${d.key}:${d.value.toLocaleLowerCase("tr-TR")}`));

  await db.companyFact.deleteMany({ where: { status: "PENDING", source: { in: ["WEBSITE", "AI_INFERRED"] } } });
  if (fresh.length > 0) {
    await db.companyFact.createMany({
      data: fresh.map((d) => ({
        companyId,
        key: d.key,
        value: d.value,
        source: d.source,
        sourceRef: d.sourceRef,
        confidence: d.confidence,
        status: "PENDING" as const,
        analysisId,
      })),
    });
  }

  await db.companyProfile.upsert({
    where: { companyId },
    create: { companyId, aiSummary: output.summary, aiSummaryStatus: "PENDING" },
    update: { aiSummary: output.summary, aiSummaryStatus: "PENDING" },
  });

  const pagesMeta = crawl.pages.map((p) => ({ url: p.url, title: p.title, chars: p.text.length }));
  await db.websiteAnalysis.update({
    where: { id: analysisId },
    data: {
      status: "COMPLETED",
      summary: output.summary,
      result: output as unknown as Prisma.InputJsonValue,
      pages: { fetched: pagesMeta, skipped: crawl.skipped } as unknown as Prisma.InputJsonValue,
      completedAt: new Date(),
      error: null,
    },
  });
  return { factCount: fresh.length };
}
