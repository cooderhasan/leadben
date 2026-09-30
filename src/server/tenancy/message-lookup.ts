import "server-only";
import { rawDb } from "@/server/db";

/**
 * Sağlayıcı webhook'u yalnızca sağlayıcının mesaj kimliğini bilir; hangi şirkete ait olduğunu
 * bulmak için tek, salt okunur çapraz-tenant sorgu. Sonraki tüm işlemler tenantDb ile yapılır.
 */
export async function findMessageOwner(providerMessageId: string) {
  if (!providerMessageId) return null;
  return rawDb.message.findFirst({
    where: { providerMessageId },
    select: { id: true, companyId: true },
  });
}

/**
 * Geri dönen (bounce) e-postadaki kimliklerle giden iletiyi bulur: bizim ileti kimliğimiz
 * (X-AISalesOS-Message-Id veya Message-ID'nin "@" öncesi) ya da sağlayıcı kimliği.
 */
export async function findOutboundByIds(ids: string[]) {
  const clean = [...new Set(ids.map((r) => r.replace(/[<>]/g, "").trim()).filter(Boolean))];
  if (!clean.length) return null;
  return rawDb.message.findFirst({
    where: {
      direction: "OUTBOUND",
      OR: [{ id: { in: clean.flatMap((r) => [r, r.split("@")[0]!]) } }, { providerMessageId: { in: [...clean, ...clean.map((r) => `<${r}>`)] } }],
    },
    select: { id: true, companyId: true, providerMessageId: true },
  });
}

/**
 * Gelen yanıtın hangi şirkete ait olduğu: önce referanslardaki bizim / sağlayıcının mesaj kimliği,
 * olmazsa alıcı adresinin bir şirketin gönderici veya yanıt adresi olması. Yalnızca companyId döner.
 */
export async function findCompanyForInbound(input: { references: string[]; to: string[] }): Promise<string | null> {
  const refs = input.references.map((r) => r.replace(/[<>]/g, "").trim()).filter(Boolean);
  if (refs.length) {
    const ids = refs.flatMap((r) => [r, r.split("@")[0]!]);
    const byRef = await rawDb.message.findFirst({
      where: { direction: "OUTBOUND", OR: [{ id: { in: ids } }, { providerMessageId: { in: [...refs, ...refs.map((r) => `<${r}>`)] } }] },
      select: { companyId: true },
    });
    if (byRef) return byRef.companyId;
  }
  for (const to of input.to.map((t) => t.trim().toLowerCase()).filter(Boolean)) {
    const rows = await rawDb.integration.findMany({
      where: {
        type: "EMAIL_PROVIDER",
        provider: "sender",
        OR: [
          { config: { path: ["sender", "fromEmail"], equals: to } },
          { config: { path: ["sender", "replyTo"], equals: to } },
        ],
      },
      select: { companyId: true },
      take: 2,
    });
    // Aynı adresi iki şirket kullanıyorsa belirsizdir; yanlış şirkete yazmamak için eşleştirme yapılmaz
    if (rows.length === 1) return rows[0]!.companyId;
  }
  return null;
}
