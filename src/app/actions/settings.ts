"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireTenant } from "@/server/tenancy/context";
import { parseForm, safeAction } from "@/server/actions/safe-action";
import { addMemory, setMemoryStatus } from "@/server/services/memory";
import { addMemberByEmail, removeMember } from "@/server/services/members";
import { memorySchema } from "@/lib/validation";
import type { ActionState } from "@/lib/action-state";

export async function addMemoryAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const { type, content } = parseForm(memorySchema, fd);
    await addMemory(ctx, type, content);
    revalidatePath("/settings/memory");
    return { ok: true, message: "Kaydedildi. AI bundan sonra bu kuralı dikkate alacak." };
  });
}

export async function setMemoryStatusAction(fd: FormData) {
  const ctx = await requireTenant();
  await setMemoryStatus(ctx, String(fd.get("id")), fd.get("status") === "ACTIVE" ? "ACTIVE" : "ARCHIVED");
  revalidatePath("/settings/memory");
}

const memberSchema = z.object({
  email: z.string().trim().email("Geçerli bir e-posta girin."),
  role: z.enum(["ADMIN", "MEMBER", "VIEWER"]),
});

export async function addMemberAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const { email, role } = parseForm(memberSchema, fd);
    await addMemberByEmail(ctx, email, role);
    revalidatePath("/settings/team");
    return { ok: true, message: "Kullanıcı ekibe eklendi." };
  });
}

export async function removeMemberAction(fd: FormData) {
  const ctx = await requireTenant();
  await removeMember(ctx, String(fd.get("id")));
  revalidatePath("/settings/team");
}
