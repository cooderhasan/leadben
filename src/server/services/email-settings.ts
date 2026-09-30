import "server-only";
import type { Prisma } from "@prisma/client";
import type { z } from "zod";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { assertCan } from "@/server/tenancy/permissions";
import type { TenantContext } from "@/server/tenancy/types";
import { checkSenderDomain } from "@/server/providers/email";
import type { DomainAuthStatus } from "@/server/providers/email/types";
import { audit } from "@/server/audit/audit";
import { AppError } from "@/lib/errors";
import { senderSettingsSchema } from "@/lib/validation";
import { FREE_MAIL_DOMAINS } from "@/lib/compliance";

export type SenderSettings = z.infer<typeof senderSettingsSchema>;

/** Integration kaydında gönderici kimliği: type EMAIL_PROVIDER, provider "sender". */
const KEY = { type: "EMAIL_PROVIDER" as const, provider: "sender" };

export async function getSenderSettings(companyId: string): Promise<{ settings: SenderSettings | null; dns: DomainAuthStatus | null; checkedAt: Date | null }> {
  const rec = await tenantDb({ companyId }).integration.findFirst({ where: KEY });
  if (!rec?.config) return { settings: null, dns: null, checkedAt: null };
  const cfg = rec.config as { sender?: unknown; dns?: DomainAuthStatus };
  const parsed = senderSettingsSchema.safeParse(cfg.sender);
  return { settings: parsed.success ? parsed.data : null, dns: cfg.dns ?? null, checkedAt: rec.lastCheckedAt };
}

export async function saveSenderSettings(ctx: TenantContext, input: SenderSettings) {
  assertCan(ctx, "email.settings");
  const domain = input.fromEmail.split("@")[1] ?? "";
  if (FREE_MAIL_DOMAINS.has(domain)) {
    throw new AppError(
      "VALIDATION",
      "Toplu ticari ileti Gmail/Hotmail gibi ücretsiz adreslerden gönderilemez (teslim edilmez ve hesap kapanabilir). Firmanızın alan adındaki bir adresi kullanın.",
      { fromEmail: "Firma alan adı gerekli" },
    );
  }
  const db = tenantDb(ctx);
  const existing = await db.integration.findFirst({ where: KEY });
  const prevConfig = (existing?.config ?? {}) as Record<string, unknown>;
  const prevSender = prevConfig.sender as { fromEmail?: string } | undefined;
  const domainChanged = prevSender?.fromEmail?.split("@")[1] !== domain;
  const config = { sender: input, dns: domainChanged ? null : (prevConfig.dns ?? null) } as unknown as Prisma.InputJsonValue;

  if (existing) {
    await db.integration.update({ where: { id: existing.id }, data: { config, status: "ACTIVE", name: "Gönderici kimliği" } });
  } else {
    await db.integration.create({ data: { ...KEY, companyId: ctx.companyId, name: "Gönderici kimliği", config, status: "ACTIVE" } });
  }
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "email.sender_saved", metadata: { fromEmail: input.fromEmail } });
}

export async function runSenderDomainCheck(ctx: TenantContext) {
  assertCan(ctx, "email.settings");
  const { settings } = await getSenderSettings(ctx.companyId);
  if (!settings) throw new AppError("VALIDATION", "Önce gönderici bilgilerini kaydedin.");
  const domain = settings.fromEmail.split("@")[1]!;
  const dns = await checkSenderDomain(domain);
  const db = tenantDb(ctx);
  const rec = await db.integration.findFirst({ where: KEY });
  if (rec) {
    await db.integration.update({
      where: { id: rec.id },
      data: {
        config: { ...((rec.config ?? {}) as Record<string, unknown>), dns } as unknown as Prisma.InputJsonValue,
        lastCheckedAt: new Date(),
        lastError: dns.spf === "pass" && dns.dmarc === "pass" ? null : dns.notes.join(" ").slice(0, 500),
      },
    });
  }
  return dns;
}

/** Gönderim için hazır mı? Eksikleri Türkçe listeler (kampanya önizlemesinde gösterilir). */
export function senderReadiness(settings: SenderSettings | null, dns: DomainAuthStatus | null): string[] {
  const issues: string[] = [];
  if (!settings) issues.push("Gönderici kimliği (ad, e-posta, ticari unvan, adres) girilmedi.");
  if (settings && dns?.spf && dns.spf !== "pass") issues.push("Gönderici alan adında geçerli SPF kaydı yok.");
  if (settings && dns?.dmarc === "missing") issues.push("Gönderici alan adında DMARC kaydı yok.");
  return issues;
}
