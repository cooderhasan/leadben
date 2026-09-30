import "server-only";
import { rawDb } from "@/server/db";
import { ai } from "@/server/ai";
import { untrusted } from "@/server/ai/guardrails";
import {
  WEBSITE_ANALYSIS_INSTRUCTIONS,
  WEBSITE_ANALYSIS_SHAPE,
  websiteAnalysisSchema,
} from "@/server/ai/prompts/website-analysis";
import { crawlSite, FetchBlockedError, type CrawlResult } from "@/server/web/fetch-site";
import { persistAnalysis } from "@/server/services/website-analysis-result";
import { refundCredits } from "@/server/usage/credits";
import { audit } from "@/server/audit/audit";
import { PermanentJobError, type JobHandler, type JobPayloads } from "../types";

/** Yalnızca test/geliştirmede yerel test sunucusuna izin verir. */
export const allowPrivateFetch = () =>
  process.env.NODE_ENV !== "production" && process.env.WEB_FETCH_ALLOW_PRIVATE === "1";

export function crawlToPrompt(crawl: CrawlResult, maxChars = 60_000): string {
  const parts: string[] = [];
  let used = 0;
  for (const p of crawl.pages) {
    const block = [
      `### SAYFA: ${p.url}`,
      p.title && `Başlık: ${p.title}`,
      p.metaDescription && `Açıklama: ${p.metaDescription}`,
      p.headings.length ? `Başlıklar: ${p.headings.join(" | ")}` : "",
      `İçerik: ${p.text}`,
    ]
      .filter(Boolean)
      .join("\n");
    const remaining = maxChars - used;
    if (remaining <= 500) break;
    parts.push(block.slice(0, remaining));
    used += Math.min(block.length, remaining);
  }
  return parts.join("\n\n");
}

export const analyzeWebsiteJob: JobHandler<"website.analyze"> = async ({ analysisId }, h) => {
  const analysis = await rawDb.websiteAnalysis.findUnique({ where: { id: analysisId } });
  if (!analysis) throw new PermanentJobError("Analiz kaydı bulunamadı.");
  if (analysis.status === "COMPLETED") return { skipped: true };

  await rawDb.websiteAnalysis.update({ where: { id: analysisId }, data: { status: "RUNNING" } });
  await h.progress(5);

  let crawl: CrawlResult;
  try {
    crawl = await crawlSite(analysis.url, { maxPages: 6, allowPrivateHosts: allowPrivateFetch() });
  } catch (err) {
    if (err instanceof FetchBlockedError) throw new PermanentJobError(err.message);
    throw new PermanentJobError(`Siteye ulaşılamadı: ${(err as Error).message}`);
  }
  const totalChars = crawl.pages.reduce((s, p) => s + p.text.length, 0);
  if (totalChars < 200) {
    throw new PermanentJobError(
      "Sitede okunabilir metin bulunamadı (içerik JavaScript ile yükleniyor olabilir). Bilgileri elle girebilirsiniz.",
    );
  }
  await h.progress(40);

  const { data } = await ai({ companyId: analysis.companyId, operation: "website.analyze" }).extract({
    schema: websiteAnalysisSchema,
    instructions: WEBSITE_ANALYSIS_INSTRUCTIONS,
    shape: WEBSITE_ANALYSIS_SHAPE,
    input: untrusted("company-website", crawlToPrompt(crawl)),
    maxTokens: 6000,
  });
  await h.progress(80);

  const { factCount } = await persistAnalysis(analysis.companyId, analysisId, data, crawl);

  await audit({
    companyId: analysis.companyId,
    userId: h.createdById,
    actorType: "AI",
    action: "company.website_analysis.completed",
    entityType: "WebsiteAnalysis",
    entityId: analysisId,
    metadata: { pages: crawl.pages.length, facts: factCount },
  });
  return { pages: crawl.pages.length, facts: factCount };
};

export async function onWebsiteAnalyzeFailure(payload: JobPayloads["website.analyze"], error: string) {
  await rawDb.websiteAnalysis.update({
    where: { id: payload.analysisId },
    data: { status: "FAILED", error: error.slice(0, 500), completedAt: new Date() },
  });
  if (payload.usageId) await refundCredits(payload.usageId, "website.analyze.failed");
}
