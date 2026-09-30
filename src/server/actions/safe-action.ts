import "server-only";
import { ZodError, type z } from "zod";
import { unstable_rethrow } from "next/navigation";
import { isAppError } from "@/lib/errors";
import type { ActionState } from "@/lib/action-state";

export function formToObject(fd: FormData): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [k, v] of fd.entries()) {
    if (k.startsWith("$ACTION")) continue;
    if (typeof v !== "string") continue;
    if (k in obj) {
      const prev = obj[k];
      obj[k] = Array.isArray(prev) ? [...prev, v] : [prev, v];
    } else obj[k] = v;
  }
  return obj;
}

export function parseForm<T extends z.ZodTypeAny>(schema: T, fd: FormData): z.infer<T> {
  return schema.parse(formToObject(fd));
}

/**
 * Server action gövdesini sarar: AppError ve ZodError'ı kullanıcıya gösterilebilir ActionState'e çevirir,
 * beklenmeyen hataları loglar ve genel mesaj döner. redirect() hatalarını olduğu gibi fırlatır.
 */
export async function safeAction(fn: () => Promise<ActionState | void>): Promise<ActionState> {
  try {
    return (await fn()) ?? { ok: true };
  } catch (err) {
    unstable_rethrow(err); // redirect()/notFound() hatalarını Next.js'e bırak
    if (err instanceof ZodError) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of err.issues) {
        const key = issue.path.join(".");
        if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return { ok: false, error: "Lütfen işaretli alanları kontrol edin.", fieldErrors };
    }
    if (isAppError(err)) return { ok: false, error: err.message, fieldErrors: err.fieldErrors };
    console.error("[action] beklenmeyen hata", err);
    return { ok: false, error: "Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin." };
  }
}
