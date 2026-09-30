import { apiRoute } from "@/server/api/v1";
import { getLead } from "@/server/services/leads";
import { publicLead } from "@/server/services/integrations";

/** GET /api/v1/leads/:id — puan, doğrulanmış sinyaller ve kaynaklarla */
export const GET = apiRoute<{ id: string }>("read", async (ctx, _req, { id }) => {
  const lead = await getLead(ctx, id);
  const score = lead.scores[0];
  return {
    ...publicLead(lead),
    score: score
      ? {
          total: score.total,
          productFit: score.productFit,
          industryFit: score.industryFit,
          sizeFit: score.sizeFit,
          buyingSignal: score.buyingSignal,
          reachability: score.reachability,
          explanation: score.explanation,
          createdAt: score.createdAt.toISOString(),
        }
      : null,
    signals: lead.signals.filter((s) => s.verified).map((s) => ({ type: s.type, title: s.title, sourceUrl: s.sourceUrl, detectedAt: s.detectedAt.toISOString() })),
    sources: lead.sources.map((s) => ({ type: s.type, provider: s.provider, fetchedAt: s.fetchedAt.toISOString() })),
  };
});
