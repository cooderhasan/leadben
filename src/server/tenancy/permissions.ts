import type { MemberRole } from "@prisma/client";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "./types";

const RANK: Record<MemberRole, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };

/**
 * Tek yetki tablosu. UI, server action'lar ve (Faz 2+) AI tool'ları aynı kontrolü kullanır.
 */
export const PERMISSIONS = {
  "company.read": "VIEWER",
  "company.update": "ADMIN",
  "company.analyze": "MEMBER",
  "facts.review": "MEMBER",
  "product.read": "VIEWER",
  "product.write": "MEMBER",
  "knowledge.read": "VIEWER",
  "knowledge.write": "MEMBER",
  "memory.read": "VIEWER",
  "memory.write": "MEMBER",
  "member.read": "VIEWER",
  "member.manage": "ADMIN",
  "usage.read": "ADMIN",
  "audit.read": "ADMIN",
  // Faz 2+
  "lead.read": "VIEWER",
  "lead.write": "MEMBER",
  "campaign.read": "VIEWER",
  "campaign.write": "MEMBER",
  "campaign.approve": "ADMIN",
  "message.approve": "MEMBER",
  "proposal.approve": "ADMIN",
  // Faz 3 — uyum ve gönderim
  "compliance.review": "ADMIN",
  "suppression.manage": "ADMIN",
  "email.settings": "ADMIN",
  "email.send": "ADMIN",
  // Faz 5 — WhatsApp ve entegrasyonlar
  "whatsapp.settings": "ADMIN",
  /** Müşterinin yazdığı konuşmaya 24 saat içinde yanıt */
  "whatsapp.send": "MEMBER",
  /** İşletmenin başlattığı şablon mesaj (izin gerekir) */
  "whatsapp.template": "ADMIN",
  "integrations.manage": "ADMIN",
} as const satisfies Record<string, MemberRole>;

export type Permission = keyof typeof PERMISSIONS;

export function can(ctx: Pick<TenantContext, "role" | "isPlatformAdmin">, permission: Permission): boolean {
  if (ctx.isPlatformAdmin) return true;
  return RANK[ctx.role] >= RANK[PERMISSIONS[permission]];
}

export function assertCan(ctx: Pick<TenantContext, "role" | "isPlatformAdmin">, permission: Permission): void {
  if (!can(ctx, permission)) {
    throw new AppError("FORBIDDEN", "Bu işlem için yetkiniz yok.");
  }
}

export function roleLabel(role: MemberRole): string {
  return { OWNER: "Sahip", ADMIN: "Yönetici", MEMBER: "Üye", VIEWER: "İzleyici" }[role];
}
