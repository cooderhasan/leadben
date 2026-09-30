import "server-only";
import type { ActorType, Prisma } from "@prisma/client";
import { rawDb } from "@/server/db";

export interface AuditEntry {
  companyId?: string | null;
  userId?: string | null;
  actorType?: ActorType;
  /** Nokta ayrımlı eylem adı, ör. "company.analysis.started", "fact.verified" */
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Prisma.InputJsonValue;
  ip?: string | null;
}

/**
 * Kritik işlemleri kaydeder. Audit yazımı başarısız olursa ana işlem durmaz, hata loglanır.
 */
export async function audit(entry: AuditEntry, tx: Pick<typeof rawDb, "auditLog"> = rawDb): Promise<void> {
  try {
    await tx.auditLog.create({
      data: {
        companyId: entry.companyId ?? null,
        userId: entry.userId ?? null,
        actorType: entry.actorType ?? "USER",
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        metadata: entry.metadata,
        ip: entry.ip ?? null,
      },
    });
  } catch (err) {
    console.error("[audit] yazılamadı", entry.action, err);
  }
}
