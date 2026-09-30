import { z } from "zod";
import { apiRoute, readJson } from "@/server/api/v1";
import { createManualLead, getLead, listLeads } from "@/server/services/leads";
import { publicLead } from "@/server/services/integrations";
import { LEAD_STATUSES } from "@/lib/validation";

/** GET /api/v1/leads?q=&status=&minScore=&limit=50&offset=0 */
export const GET = apiRoute("read", async (ctx, req) => {
  const q = new URL(req.url).searchParams;
  const status = q.get("status");
  const limit = Math.min(Math.max(Number(q.get("limit")) || 50, 1), 200);
  const offset = Math.max(Number(q.get("offset")) || 0, 0);
  const { rows, total } = await listLeads(ctx, {
    q: q.get("q") ?? undefined,
    status: status && (LEAD_STATUSES as readonly string[]).includes(status) ? (status as (typeof LEAD_STATUSES)[number]) : undefined,
    minScore: q.get("minScore") ? Number(q.get("minScore")) : undefined,
    take: limit,
    skip: offset,
  });
  return { items: rows.map(publicLead), total, limit, offset };
});

const createSchema = z.object({
  companyName: z.string().trim().min(2).max(300),
  website: z.string().trim().max(500).optional(),
  phone: z.string().trim().max(50).optional(),
  email: z.string().trim().email().max(200).optional(),
  city: z.string().trim().max(120).optional(),
  district: z.string().trim().max(120).optional(),
  address: z.string().trim().max(500).optional(),
  industry: z.string().trim().max(200).optional(),
});

/** POST /api/v1/leads — aynı alan adı / telefon / ad+şehir varsa yeni kayıt açılmaz (dedupe) */
export const POST = apiRoute("write", async (ctx, req) => {
  const b = createSchema.parse(await readJson(req));
  const res = await createManualLead(ctx, {
    companyName: b.companyName,
    website: b.website,
    phone: b.phone,
    genericEmail: b.email,
    city: b.city,
    district: b.district,
    address: b.address,
    category: b.industry,
    sourceType: "MANUAL",
  });
  return { lead: publicLead(await getLead(ctx, res.leadId)), merged: res.merged };
});
