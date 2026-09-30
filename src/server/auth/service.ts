import "server-only";
import { rawDb } from "@/server/db";
import { AppError } from "@/lib/errors";
import { slugify } from "@/lib/slug";
import { env } from "@/server/env";
import { audit } from "@/server/audit/audit";
import { hashPassword, validatePasswordStrength, verifyPassword } from "./password";
import { rateLimit } from "./rate-limit";

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
  companyName: string;
}

const normalizeEmail = (e: string) => e.trim().toLowerCase();

async function uniqueSlug(base: string): Promise<string> {
  const root = slugify(base);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const exists = await rawDb.company.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!exists) return candidate;
  }
  return `${root}-${Date.now().toString(36)}`;
}

/**
 * Yeni kullanıcı + şirket oluşturur. Kullanıcı şirketin OWNER'ı olur.
 * Deneme kredisi ve STARTER abonelik kaydı açılır.
 */
export async function registerUser(input: RegisterInput): Promise<{ userId: string; companyId: string }> {
  const email = normalizeEmail(input.email);
  const pwError = validatePasswordStrength(input.password);
  if (pwError) throw new AppError("VALIDATION", pwError, { password: pwError });

  const existing = await rawDb.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    throw new AppError("CONFLICT", "Bu e-posta ile kayıtlı bir hesap var.", { email: "Bu e-posta zaten kayıtlı." });
  }

  const passwordHash = await hashPassword(input.password);
  const slug = await uniqueSlug(input.companyName);
  const credits = env().SIGNUP_CREDITS;

  const result = await rawDb.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { email, name: input.name.trim(), passwordHash } });
    const company = await tx.company.create({
      data: {
        name: input.companyName.trim(),
        slug,
        creditBalance: credits,
        members: { create: { userId: user.id, role: "OWNER" } },
        profile: { create: {} },
        subscription: { create: { plan: "STARTER", status: "TRIALING", monthlyCredits: credits } },
      },
    });
    if (credits > 0) {
      await tx.usageRecord.create({
        data: { companyId: company.id, operation: "credit.grant", credits, userId: user.id, refType: "signup" },
      });
    }
    return { userId: user.id, companyId: company.id };
  });

  await audit({ companyId: result.companyId, userId: result.userId, action: "user.registered", entityType: "User", entityId: result.userId });
  return result;
}

export async function authenticate(
  emailRaw: string,
  password: string,
  ip: string | null,
): Promise<{ userId: string; defaultCompanyId: string | null }> {
  const email = normalizeEmail(emailRaw);
  const limit = rateLimit(`login:${ip ?? "?"}:${email}`, 5, 60_000);
  if (!limit.ok) {
    throw new AppError("RATE_LIMITED", `Çok fazla deneme. ${Math.ceil(limit.retryAfterMs / 1000)} saniye sonra tekrar deneyin.`);
  }

  const user = await rawDb.user.findUnique({
    where: { email },
    include: { memberships: { orderBy: { createdAt: "asc" }, take: 1 } },
  });
  // Kullanıcı yoksa da hash doğrulaması yapılır (zamanlama farkıyla e-posta tespiti önlenir)
  const ok = await verifyPassword(password, user?.passwordHash ?? "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA");
  if (!user || !user.passwordHash || !ok) {
    await audit({ userId: user?.id, action: "auth.login_failed", metadata: { email }, ip });
    throw new AppError("UNAUTHENTICATED", "E-posta veya parola hatalı.");
  }

  await rawDb.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit({ userId: user.id, companyId: user.memberships[0]?.companyId, action: "auth.login", ip });
  return { userId: user.id, defaultCompanyId: user.memberships[0]?.companyId ?? null };
}

/** Kullanıcı tablosu tenant dışıdır: yalnızca tam e-posta eşleşmesiyle ID döner, listeleme yapılmaz. */
export async function findUserIdByEmail(email: string): Promise<{ id: string } | null> {
  return rawDb.user.findUnique({ where: { email: normalizeEmail(email) }, select: { id: true } });
}
