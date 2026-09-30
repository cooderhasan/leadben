import { apiRoute } from "@/server/api/v1";
import { listOpportunities } from "@/server/services/crm";

/** GET /api/v1/opportunities — açık fırsatlar + son 90 günde güncellenenler */
export const GET = apiRoute("read", async (ctx) => {
  const rows = await listOpportunities(ctx);
  return {
    items: rows.map((o) => ({
      id: o.id,
      leadId: o.lead.id,
      companyName: o.lead.companyName,
      title: o.title,
      stage: o.stage,
      value: o.value != null ? Number(o.value) : null,
      currency: o.currency,
      probability: o.probability,
      expectedCloseAt: o.expectedCloseAt?.toISOString() ?? null,
      lostReason: o.lostReason,
      updatedAt: o.updatedAt.toISOString(),
    })),
  };
});
