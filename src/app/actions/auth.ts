"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { authenticate, registerUser } from "@/server/auth/service";
import { clientIp, createSession, destroySession } from "@/server/auth/session";
import { switchCompany } from "@/server/tenancy/context";
import { parseForm, safeAction } from "@/server/actions/safe-action";
import { loginSchema, registerSchema } from "@/lib/validation";
import type { ActionState } from "@/lib/action-state";
import { AppError } from "@/lib/errors";
import { env } from "@/server/env";

export async function registerAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const result = await safeAction(async () => {
    if (!env().ALLOW_SIGNUP) throw new AppError("FORBIDDEN", "Yeni kayıtlar şu an kapalı.");
    const input = parseForm(registerSchema, fd);
    const { userId, companyId } = await registerUser(input);
    await createSession(userId, companyId);
  });
  if (result.ok) redirect("/onboarding");
  return result;
}

export async function loginAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let target = "/dashboard";
  const result = await safeAction(async () => {
    const input = parseForm(loginSchema, fd);
    const ip = clientIp(await headers());
    const { userId, defaultCompanyId } = await authenticate(input.email, input.password, ip);
    await createSession(userId, defaultCompanyId);
    const next = fd.get("next");
    // Yalnızca site içi göreli yönlendirme (open redirect koruması)
    if (typeof next === "string" && next.startsWith("/") && !next.startsWith("//")) target = next;
  });
  if (result.ok) redirect(target);
  return result;
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}

export async function switchCompanyAction(fd: FormData) {
  const id = fd.get("companyId");
  if (typeof id === "string") await switchCompany(id);
  redirect("/dashboard");
}
