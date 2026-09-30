import "server-only";
import { rawDb } from "@/server/db";

/**
 * Webhook adresindeki entegrasyon kimliğinden şirketi bulur (her şirketin kendi adresi vardır:
 * /api/webhooks/whatsapp/<integrationId>). Salt okunur; sonraki işlemler tenantDb ile yapılır.
 */
export async function findWhatsAppIntegration(integrationId: string) {
  if (!/^[a-z0-9]{10,40}$/i.test(integrationId)) return null;
  return rawDb.integration.findFirst({
    where: { id: integrationId, type: "WHATSAPP_BUSINESS" },
    select: { id: true, companyId: true, config: true, secretsEncrypted: true, status: true },
  });
}
