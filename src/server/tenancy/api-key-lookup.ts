import "server-only";
import { rawDb } from "@/server/db";

/**
 * API isteğindeki anahtarın özetinden şirketi bulur (çapraz-tenant tek, salt okunur sorgu).
 * Geri çekilmiş anahtar dönmez. Sonraki tüm işlemler tenantDb ile yapılır.
 */
export async function findActiveApiKey(keyHash: string) {
  return rawDb.apiKey.findFirst({
    where: { keyHash, revokedAt: null },
    select: { id: true, companyId: true, scopes: true, createdById: true, lastUsedAt: true },
  });
}

/** Son kullanım zamanı (dakikada en fazla bir kez yazılır). */
export async function touchApiKey(id: string) {
  await rawDb.apiKey.updateMany({
    where: { id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(Date.now() - 60_000) } }] },
    data: { lastUsedAt: new Date() },
  });
}
