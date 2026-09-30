import "server-only";
import type { SuppressionType } from "@prisma/client";
import { rawDb } from "@/server/db";

/**
 * Platform geneli (companyId = null) merkezi engel listesi — yalnızca OKUMA.
 * tenantDb her sorguya companyId eklediği için bu kayıtlar tenant bağlamından görünmez;
 * bu tek fonksiyon izolasyon sınırında, salt okunur erişim sağlar.
 */
export async function findPlatformSuppressions(keys: Array<{ type: SuppressionType; value: string }>) {
  if (keys.length === 0) return [];
  return rawDb.suppressionRecord.findMany({
    where: { companyId: null, OR: keys.map((k) => ({ type: k.type, value: k.value })) },
    select: { type: true, value: true, reason: true },
  });
}
