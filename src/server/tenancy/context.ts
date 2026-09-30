import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { rawDb } from "@/server/db";
import { getCurrentUser, setActiveCompany } from "@/server/auth/session";
import { AppError } from "@/lib/errors";
import type { TenantContext, UserContext } from "./types";

/** Sayfalar için: oturum yoksa /login'e yönlendirir. */
export async function requireUserPage(): Promise<UserContext> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * Aktif şirket bağlamını sunucuda çözer. İstemciden gelen companyId'ye asla güvenilmez:
 * şirket, oturumdaki activeCompanyId + CompanyMember kaydından doğrulanır.
 */
export const resolveTenant = cache(async (): Promise<TenantContext | null> => {
  const user = await getCurrentUser();
  if (!user) return null;

  const memberships = await rawDb.companyMember.findMany({
    where: { userId: user.userId },
    orderBy: { createdAt: "asc" },
    select: { companyId: true, role: true },
  });
  if (memberships.length === 0) return null;

  let membership = memberships.find((m) => m.companyId === user.activeCompanyId);
  if (!membership) {
    membership = memberships[0]!;
    await setActiveCompany(user.sessionId, membership.companyId);
  }

  return {
    userId: user.userId,
    companyId: membership.companyId,
    role: membership.role,
    isPlatformAdmin: user.isPlatformAdmin,
  };
});

/** Server action / route handler için: bağlam yoksa hata fırlatır. */
export async function requireTenant(): Promise<TenantContext> {
  const ctx = await resolveTenant();
  if (!ctx) throw new AppError("UNAUTHENTICATED", "Oturumunuz sona ermiş. Lütfen tekrar giriş yapın.");
  return ctx;
}

/**
 * Sayfalar için: bağlam yoksa yönlendirir.
 * Oturum açık ama hiçbir şirkete üye değilse /login'e GÖNDERİLMEZ — giriş sayfası oturumu görüp
 * /dashboard'a geri yolladığı için sonsuz döngü olur. Platform yöneticisi /admin'e, diğerleri
 * açıklama sayfasına gider.
 */
export async function requireTenantPage(): Promise<TenantContext> {
  const user = await requireUserPage();
  const ctx = await resolveTenant();
  if (!ctx) redirect(user.isPlatformAdmin ? "/admin" : "/no-company");
  return ctx;
}

export async function listUserCompanies(userId: string) {
  return rawDb.companyMember.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { role: true, company: { select: { id: true, name: true } } },
  });
}

export async function switchCompany(companyId: string): Promise<void> {
  const user = await getCurrentUser();
  if (!user) throw new AppError("UNAUTHENTICATED", "Oturum bulunamadı.");
  const member = await rawDb.companyMember.findUnique({
    where: { companyId_userId: { companyId, userId: user.userId } },
  });
  if (!member) throw new AppError("FORBIDDEN", "Bu şirkete erişiminiz yok.");
  await setActiveCompany(user.sessionId, companyId);
}
