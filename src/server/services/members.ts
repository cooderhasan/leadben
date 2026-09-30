import "server-only";
import type { MemberRole } from "@prisma/client";
import { findUserIdByEmail } from "@/server/auth/service";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { assertCan } from "@/server/tenancy/permissions";
import type { TenantContext } from "@/server/tenancy/types";
import { audit } from "@/server/audit/audit";
import { AppError } from "@/lib/errors";

export async function listMembers(ctx: TenantContext) {
  assertCan(ctx, "member.read");
  return tenantDb(ctx).companyMember.findMany({
    orderBy: { createdAt: "asc" },
    include: { user: { select: { id: true, name: true, email: true, lastLoginAt: true } } },
  });
}

/**
 * Kayıtlı bir kullanıcıyı şirkete ekler. (E-posta daveti Faz 2'de — e-posta sağlayıcı gerektirir.)
 * Kullanıcı araması e-posta eşleşmesiyle sınırlıdır; diğer kullanıcılar listelenmez.
 */
export async function addMemberByEmail(ctx: TenantContext, email: string, role: MemberRole) {
  assertCan(ctx, "member.manage");
  if (role === "OWNER" && ctx.role !== "OWNER" && !ctx.isPlatformAdmin) {
    throw new AppError("FORBIDDEN", "Yalnızca şirket sahibi başka bir sahip ekleyebilir.");
  }
  const user = await findUserIdByEmail(email);
  if (!user) throw new AppError("NOT_FOUND", "Bu e-posta ile kayıtlı kullanıcı yok. Önce kayıt olmasını isteyin.");
  const db = tenantDb(ctx);
  const exists = await db.companyMember.findFirst({ where: { userId: user.id } });
  if (exists) throw new AppError("CONFLICT", "Bu kullanıcı zaten ekipte.");
  await db.companyMember.create({ data: { companyId: ctx.companyId, userId: user.id, role } });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "member.added", entityType: "User", entityId: user.id, metadata: { role } });
}

export async function removeMember(ctx: TenantContext, memberId: string) {
  assertCan(ctx, "member.manage");
  const db = tenantDb(ctx);
  const m = await db.companyMember.findUnique({ where: { id: memberId } });
  if (!m) throw new AppError("NOT_FOUND", "Üye bulunamadı.");
  if (m.role === "OWNER") {
    const owners = await db.companyMember.count({ where: { role: "OWNER" } });
    if (owners <= 1) throw new AppError("VALIDATION", "Şirketin son sahibi çıkarılamaz.");
  }
  await db.companyMember.delete({ where: { id: memberId } });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "member.removed", entityType: "User", entityId: m.userId });
}
