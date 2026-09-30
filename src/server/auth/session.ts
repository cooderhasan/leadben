import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { cache } from "react";
import { rawDb } from "@/server/db";
import type { UserContext } from "@/server/tenancy/types";

export const SESSION_COOKIE = "sos_session";
const SESSION_DAYS = 30;
const RENEW_WHEN_DAYS_LEFT = 15;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(userId: string, activeCompanyId: string | null) {
  const token = randomBytes(32).toString("base64url");
  const h = await headers();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await rawDb.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      activeCompanyId,
      expiresAt,
      userAgent: h.get("user-agent")?.slice(0, 300) ?? null,
      ip: clientIp(h),
    },
  });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export function clientIp(h: Headers): string | null {
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
}

/**
 * Oturumdaki kullanıcıyı döndürür (istek başına bir kez DB'ye gider).
 * Süresi dolmuş oturumu siler; süresi yaklaşan oturumu uzatır.
 */
export const getCurrentUser = cache(async (): Promise<UserContext | null> => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await rawDb.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { select: { id: true, email: true, name: true, isPlatformAdmin: true } } },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await rawDb.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  if (session.expiresAt.getTime() - Date.now() < RENEW_WHEN_DAYS_LEFT * 86_400_000) {
    await rawDb.session
      .update({ where: { id: session.id }, data: { expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000) } })
      .catch(() => undefined);
  }

  return {
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
    isPlatformAdmin: session.user.isPlatformAdmin,
    sessionId: session.id,
    activeCompanyId: session.activeCompanyId,
  };
});

export async function setActiveCompany(sessionId: string, companyId: string) {
  await rawDb.session.update({ where: { id: sessionId }, data: { activeCompanyId: companyId } });
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await rawDb.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  jar.delete(SESSION_COOKIE);
}
