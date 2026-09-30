import "server-only";
import type { MemoryType } from "@prisma/client";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { assertCan } from "@/server/tenancy/permissions";
import type { TenantContext } from "@/server/tenancy/types";
import { audit } from "@/server/audit/audit";

export const MEMORY_TYPE_LABELS: Record<MemoryType, string> = {
  RULE: "Satış kuralı",
  PREFERENCE: "Tercih",
  FACT: "Bilgi",
};

export async function listMemories(ctx: TenantContext) {
  assertCan(ctx, "memory.read");
  return tenantDb(ctx).companyMemory.findMany({ orderBy: [{ status: "asc" }, { createdAt: "desc" }] });
}

/**
 * Şirket hafızasına kural/tercih ekler. Ör. "Almanya'da 5.000 adetten düşük siparişlerle ilgilenmiyoruz."
 * Yapılandırılmış (makine tarafından uygulanabilir) biçim Faz 3 Sales Rule Engine ile eklenecek;
 * o zamana kadar kurallar AI prompt'larına metin olarak girer.
 */
export async function addMemory(ctx: TenantContext, type: MemoryType, content: string) {
  assertCan(ctx, "memory.write");
  const m = await tenantDb(ctx).companyMemory.create({
    data: { companyId: ctx.companyId, type, content, source: "USER", status: "ACTIVE", createdById: ctx.userId },
  });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "memory.created", entityType: "CompanyMemory", entityId: m.id });
  return m;
}

export async function setMemoryStatus(ctx: TenantContext, id: string, status: "ACTIVE" | "ARCHIVED") {
  assertCan(ctx, "memory.write");
  await tenantDb(ctx).companyMemory.updateMany({ where: { id }, data: { status } });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: `memory.${status === "ACTIVE" ? "activated" : "archived"}`, entityType: "CompanyMemory", entityId: id });
}
