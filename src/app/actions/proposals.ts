"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireTenant } from "@/server/tenancy/context";
import { parseForm, safeAction } from "@/server/actions/safe-action";
import {
  approveProposal,
  createProposalEmail,
  setProposalOutcome,
  startProposal,
  submitProposal,
  updateProposal,
} from "@/server/services/proposals";
import { proposalFormSchema } from "@/lib/validation";
import type { ActionState } from "@/lib/action-state";

export async function startProposalAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let id = "";
  const res = await safeAction(async () => {
    const ctx = await requireTenant();
    const opportunityId = String(fd.get("opportunityId") ?? "") || null;
    const leadId = String(fd.get("leadId") ?? "") || null;
    const { proposal } = await startProposal(ctx, { opportunityId, leadId });
    id = proposal.id;
  });
  if (res.ok && id) redirect(`/proposals/${id}`);
  return res;
}

export async function saveProposalAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const input = parseForm(proposalFormSchema, fd);
    const res = await updateProposal(ctx, input);
    revalidatePath(`/proposals/${input.id}`);
    return res.blockers.length
      ? { ok: true, message: `Kaydedildi. Onaya göndermeden önce: ${res.blockers.slice(0, 3).join(" ")}` }
      : { ok: true, message: "Kaydedildi. Onaya gönderebilirsiniz." };
  });
}

export async function submitProposalAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const id = String(fd.get("id"));
    await submitProposal(ctx, id);
    revalidatePath(`/proposals/${id}`);
    return { ok: true, message: "Onaya gönderildi." };
  });
}

export async function approveProposalAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const id = String(fd.get("id"));
    await approveProposal(ctx, id);
    revalidatePath(`/proposals/${id}`);
    return { ok: true, message: "Teklif onaylandı." };
  });
}

export async function proposalOutcomeAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const id = String(fd.get("id"));
    const status = String(fd.get("status"));
    if (status !== "SENT" && status !== "ACCEPTED" && status !== "REJECTED") return { ok: false, error: "Geçersiz durum." };
    await setProposalOutcome(ctx, id, status);
    revalidatePath(`/proposals/${id}`);
    revalidatePath("/pipeline");
    return { ok: true, message: "Güncellendi." };
  });
}

export async function emailProposalAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let target = "";
  const res = await safeAction(async () => {
    const ctx = await requireTenant();
    const msg = await createProposalEmail(ctx, String(fd.get("id")));
    target = msg.conversationId ? `/messages/c/${msg.conversationId}` : "/messages?f=pending";
  });
  if (res.ok && target) redirect(target);
  return res;
}
