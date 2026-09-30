import { z } from "zod";
import { apiRoute, readJson } from "@/server/api/v1";
import { createTaskByUser, listTasks } from "@/server/services/crm";

const toTask = (t: { id: string; title: string; description: string | null; status: string; priority: string; dueAt: Date | null; leadId: string | null; createdByAI: boolean; createdAt: Date }) => ({
  id: t.id,
  title: t.title,
  description: t.description,
  status: t.status,
  priority: t.priority,
  dueAt: t.dueAt?.toISOString() ?? null,
  leadId: t.leadId,
  createdByAI: t.createdByAI,
  createdAt: t.createdAt.toISOString(),
});

/** GET /api/v1/tasks?status=OPEN|DONE */
export const GET = apiRoute("read", async (ctx, req) => {
  const status = new URL(req.url).searchParams.get("status") === "DONE" ? "DONE" : "OPEN";
  return { items: (await listTasks(ctx, { status })).map(toTask) };
});

const createSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(2000).optional(),
  leadId: z.string().min(1).optional(),
  dueAt: z.string().datetime({ offset: true }).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"),
});

/** POST /api/v1/tasks */
export const POST = apiRoute("write", async (ctx, req) => {
  const b = createSchema.parse(await readJson(req));
  const t = await createTaskByUser(ctx, { title: b.title, description: b.description ?? null, leadId: b.leadId ?? null, dueAt: b.dueAt ? new Date(b.dueAt) : null, priority: b.priority });
  return toTask(t);
});
