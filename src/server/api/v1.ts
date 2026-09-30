import "server-only";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { authenticateApiKey, type ApiScope } from "@/server/services/integrations";
import { rateLimit } from "@/server/auth/rate-limit";
import type { TenantContext } from "@/server/tenancy/types";
import { isAppError } from "@/lib/errors";

const STATUS: Record<string, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 422,
  CONFLICT: 409,
  INSUFFICIENT_CREDITS: 402,
  RATE_LIMITED: 429,
  TENANT_VIOLATION: 403,
};

/** Anahtar başına dakikada en fazla istek */
const RATE_PER_MINUTE = 120;

/**
 * REST API v1 sarmalayıcısı: anahtar doğrulama + kapsam + hız sınırı + tutarlı hata biçimi.
 * Hata gövdesi: { "error": { "code": "...", "message": "..." } }
 */
export function apiRoute<P>(scope: ApiScope, fn: (ctx: TenantContext, req: Request, params: P) => Promise<unknown>) {
  return async (req: Request, context: { params: Promise<P> }) => {
    try {
      const ctx = await authenticateApiKey(req.headers.get("authorization"), scope);
      const rl = rateLimit(`api:${ctx.companyId}:${req.headers.get("authorization")?.slice(-12)}`, RATE_PER_MINUTE, 60_000);
      if (!rl.ok) {
        return NextResponse.json(
          { error: { code: "RATE_LIMITED", message: "Çok fazla istek. Biraz sonra tekrar deneyin." } },
          { status: 429, headers: { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) } },
        );
      }
      const data = await fn(ctx, req, await context.params);
      return NextResponse.json({ data }, { headers: { "cache-control": "no-store" } });
    } catch (err) {
      if (err instanceof ZodError) {
        return NextResponse.json(
          { error: { code: "VALIDATION", message: "Geçersiz istek.", fields: Object.fromEntries(err.issues.map((i) => [i.path.join("."), i.message])) } },
          { status: 422 },
        );
      }
      if (isAppError(err)) {
        return NextResponse.json({ error: { code: err.code, message: err.message, fields: err.fieldErrors } }, { status: STATUS[err.code] ?? 400 });
      }
      console.error("[api v1] beklenmeyen hata", err);
      return NextResponse.json({ error: { code: "INTERNAL", message: "Beklenmeyen bir hata oluştu." } }, { status: 500 });
    }
  };
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    const { AppError } = await import("@/lib/errors");
    throw new AppError("VALIDATION", "Gövde geçerli JSON olmalı.");
  }
}
