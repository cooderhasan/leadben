"use server";

import { revalidatePath } from "next/cache";
import { requireTenant } from "@/server/tenancy/context";
import { safeAction } from "@/server/actions/safe-action";
import { setCompetitorMonitoring, startCompetitorScan } from "@/server/services/competitors";
import type { ActionState } from "@/lib/action-state";

export async function scanCompetitorAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    await startCompetitorScan(ctx, String(fd.get("id")));
    revalidatePath("/competitors");
    return { ok: true, message: "Tarama başladı. Değişiklik yoksa kredi iade edilir." };
  });
}

export async function toggleMonitoringAction(fd: FormData) {
  const ctx = await requireTenant();
  await setCompetitorMonitoring(ctx, String(fd.get("id")), fd.get("monitoring") === "true");
  revalidatePath("/competitors");
}
