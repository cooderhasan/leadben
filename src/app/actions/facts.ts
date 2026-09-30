"use server";

import { revalidatePath } from "next/cache";
import { requireTenant } from "@/server/tenancy/context";
import { parseForm, safeAction } from "@/server/actions/safe-action";
import { addUserFact, correctFact, promoteFactToProduct, rejectFacts, reviewSummary, verifyFacts } from "@/server/services/facts";
import { factAddSchema, factEditSchema } from "@/lib/validation";
import type { ActionState } from "@/lib/action-state";

const refresh = () => {
  revalidatePath("/company");
  revalidatePath("/onboarding");
  revalidatePath("/dashboard");
};

const ids = (fd: FormData) => fd.getAll("factId").filter((v): v is string => typeof v === "string" && v.length > 0);

export async function verifyFactsAction(fd: FormData) {
  const ctx = await requireTenant();
  await verifyFacts(ctx, ids(fd));
  refresh();
}

export async function rejectFactsAction(fd: FormData) {
  const ctx = await requireTenant();
  await rejectFacts(ctx, ids(fd));
  refresh();
}

export async function correctFactAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const { factId, value } = parseForm(factEditSchema, fd);
    await correctFact(ctx, factId, value);
    refresh();
    return { ok: true };
  });
}

/** Kullanıcının elle eklediği bilgi doğrudan onaylıdır (satış içeriğinde kullanılabilir) */
export async function addFactAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const { key, value } = parseForm(factAddSchema, fd);
    await addUserFact(ctx, key, value);
    refresh();
    return { ok: true, message: "Eklendi." };
  });
}

/** Onaylı bilgiyi kaldırır (reddedildi olarak işaretlenir; satış içeriğinde artık kullanılmaz) */
export async function removeFactAction(fd: FormData) {
  const ctx = await requireTenant();
  const id = fd.get("factId");
  if (typeof id === "string" && id) await rejectFacts(ctx, [id]);
  refresh();
}

export async function verifySummaryAction() {
  const ctx = await requireTenant();
  await reviewSummary(ctx, "verify");
  refresh();
}

export async function correctSummaryAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const text = String(fd.get("summary") ?? "").trim();
    if (text.length < 20) return { ok: false, error: "Özet en az bir iki cümle olmalı.", fieldErrors: { summary: "Çok kısa" } };
    await reviewSummary(ctx, "correct", text.slice(0, 1500));
    refresh();
    return { ok: true };
  });
}

export async function promoteFactAction(fd: FormData) {
  const ctx = await requireTenant();
  const id = fd.get("factId");
  if (typeof id === "string") await promoteFactToProduct(ctx, id);
  refresh();
  revalidatePath("/products");
}
