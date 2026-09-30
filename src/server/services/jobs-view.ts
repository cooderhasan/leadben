import "server-only";
import { tenantDb } from "@/server/tenancy/tenant-db";
import type { TenantContext } from "@/server/tenancy/types";

/** Bir kayda bağlı, hâlâ çalışan arka plan işi (sayfada ilerleme göstermek için). */
export async function getActiveJob(ctx: TenantContext, type: string, payloadKey: string, value: string) {
  return tenantDb(ctx).job.findFirst({
    where: { type, status: { in: ["QUEUED", "RUNNING"] }, payload: { path: [payloadKey], equals: value } },
    select: { id: true, type: true },
  });
}
