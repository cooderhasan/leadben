"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireTenant } from "@/server/tenancy/context";
import { parseForm, safeAction } from "@/server/actions/safe-action";
import {
  addLeadsToList,
  bulkAssignOwner,
  bulkDeleteLeads,
  bulkUpdateLeadStatus,
  createLeadList,
  removeLeadsFromList,
  createManualLead,
  deleteLead,
  resolveLeadSelection,
  updateLeadContactInfo,
  updateLeadStatus,
} from "@/server/services/leads";
import { addLeadsToCampaign } from "@/server/services/campaigns";
import { parseLeadFilter } from "@/lib/lead-filter";
import { LEAD_STATUSES } from "@/lib/validation";
import type { LeadStatus } from "@prisma/client";
import {
  importLeadsCsv,
  startEmailDiscovery,
  startListImport,
  startWebsiteDiscovery,
  planPreparation,
  startPreparation,
  startLeadResearch,
  startLeadScoring,
  startLeadSearch,
} from "@/server/services/lead-intelligence";
import { leadContactSchema, leadSearchFormSchema, leadStatusSchema, manualLeadSchema } from "@/lib/validation";
import { AppError } from "@/lib/errors";
import { LEAD_SOURCE_LABELS } from "@/server/providers/lead-source";
import type { ActionState } from "@/lib/action-state";

export async function searchLeadsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const input = parseForm(leadSearchFormSchema, fd);
    const res = await startLeadSearch(ctx, input.prompt, input.limit, input.source);
    revalidatePath("/leads");
    return { ok: true, message: `Arama başladı (${LEAD_SOURCE_LABELS[res.source]}): ${res.interpretation} (en fazla ${res.reserved} lead)` };
  });
}

export async function importLeadsCsvAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new AppError("VALIDATION", "Bir CSV dosyası seçin.", { file: "Dosya seçin" });
    const res = await importLeadsCsv(ctx, await file.text());
    revalidatePath("/leads");
    const parts = [`${res.created} yeni lead eklendi`, `${res.merged} mevcut kayıtla birleştirildi`];
    if (res.skipped > 0) parts.push(`${res.skipped} satır atlandı`);
    if (res.unknownHeaders.length > 0) parts.push(`tanınmayan sütunlar: ${res.unknownHeaders.slice(0, 5).join(", ")}`);
    return { ok: true, message: `${parts.join(" · ")}.` };
  });
}

export async function importListAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const url = String(fd.get("url") ?? "").trim();
    const text = String(fd.get("text") ?? "").trim();
    const filter = String(fd.get("filter") ?? "").trim();
    const render = fd.get("render") === "on";
    await startListImport(ctx, { url: url || null, text: text || null, filter: filter || null, render });
    revalidatePath("/leads");
    return { ok: true, message: "Liste işleniyor; ilerleme bu kartta görünecek." };
  });
}

export async function createLeadAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let leadId = "";
  const result = await safeAction(async () => {
    const ctx = await requireTenant();
    const input = parseForm(manualLeadSchema, fd);
    const res = await createManualLead(ctx, {
      companyName: input.companyName,
      website: input.website ?? undefined,
      phone: input.phone ?? undefined,
      genericEmail: input.genericEmail ?? undefined,
      city: input.city ?? undefined,
      district: input.district ?? undefined,
      address: input.address ?? undefined,
      category: input.category ?? undefined,
      sourceType: "MANUAL",
    });
    leadId = res.leadId;
    revalidatePath("/leads");
  });
  if (result.ok && leadId) redirect(`/leads/${leadId}`);
  return result;
}

export async function researchLeadAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const id = String(fd.get("id") ?? "");
    const res = await startLeadResearch(ctx, id);
    revalidatePath(`/leads/${id}`);
    return { ok: true, message: res.alreadyRunning ? "Analiz zaten sürüyor." : "Analiz başladı." };
  });
}

export async function scoreLeadsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const ids = fd.getAll("leadId").filter((v): v is string => typeof v === "string" && v.length > 0);
    const res = await startLeadScoring(ctx, ids);
    revalidatePath("/leads");
    for (const id of ids.slice(0, 1)) revalidatePath(`/leads/${id}`);
    return { ok: true, message: `${res.count} lead puanlanıyor (${res.cost} kredi).` };
  });
}

export async function findEmailsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const ids = fd.getAll("leadId").filter((v): v is string => typeof v === "string" && v.length > 0);
    const res = await startEmailDiscovery(ctx, ids);
    revalidatePath("/leads");
    return { ok: true, message: `${res.count} firmanın sitesinde e-posta aranıyor; ilerleme ve sonuç listenin üstünde görünecek.` };
  });
}

export async function updateLeadContactAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const input = parseForm(leadContactSchema, fd);
    await updateLeadContactInfo(ctx, input);
    revalidatePath(`/leads/${input.id}`);
    revalidatePath("/leads");
    return { ok: true, message: "İletişim bilgileri kaydedildi." };
  });
}

/** Listeden hızlı e-posta ekleme (lead sayfasına girmeden) */
export async function quickSetEmailAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const id = String(fd.get("id") ?? "");
    const genericEmail = String(fd.get("genericEmail") ?? "").trim();
    if (!genericEmail) throw new AppError("VALIDATION", "E-posta adresini yazın.", { genericEmail: "Gerekli" });
    await updateLeadContactInfo(ctx, { id, genericEmail });
    revalidatePath("/leads");
    revalidatePath(`/leads/${id}`);
    return { ok: true, message: "E-posta eklendi." };
  });
}

/** Listeden hızlı silme (sayfa değişmez) */
export async function quickDeleteLeadAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    await deleteLead(ctx, String(fd.get("id") ?? ""));
    revalidatePath("/leads");
    return { ok: true, message: "Lead silindi." };
  });
}

export async function updateLeadStatusAction(fd: FormData) {
  const ctx = await requireTenant();
  const input = parseForm(leadStatusSchema, fd);
  await updateLeadStatus(ctx, input.id, input.status);
  revalidatePath(`/leads/${input.id}`);
  revalidatePath("/leads");
}

export async function deleteLeadAction(fd: FormData) {
  const ctx = await requireTenant();
  await deleteLead(ctx, String(fd.get("id")));
  revalidatePath("/leads");
  redirect("/leads");
}

// ── Toplu işlemler ─────────────────────────────────────────────────────

/** Seçim: işaretlenen satırlar ya da "filtreye uyan tümü" (filtre sunucuda yeniden uygulanır) */
async function selectedIds(fd: FormData) {
  const ctx = await requireTenant();
  const all = fd.get("mode") === "all";
  const ids = all
    ? await resolveLeadSelection(ctx, { filter: parseLeadFilter((k) => fd.get(`f_${k}`)?.toString()) })
    : await resolveLeadSelection(ctx, { ids: fd.getAll("leadId").filter((v): v is string => typeof v === "string" && v.length > 0) });
  if (ids.length === 0) throw new AppError("VALIDATION", "Önce firma seçin.");
  return { ctx, ids };
}

const prepareSteps = (fd: FormData) => ({ email: fd.get("p_email") === "on", research: fd.get("p_research") === "on", score: fd.get("p_score") === "on" });

/** "Hazırla" için kredi tahmini (kredi düşmez) — onay penceresinde gösterilir */
export async function estimatePrepareAction(fd: FormData): Promise<{ ok: boolean; error?: string; count?: number; credits?: number; research?: number; scoreOnly?: number; emailOnly?: number; capped?: boolean }> {
  try {
    const { ctx, ids } = await selectedIds(fd);
    const p = await planPreparation(ctx, ids, prepareSteps(fd));
    return { ok: true, count: p.plan.length, credits: p.credits, research: p.research, scoreOnly: p.scoreOnly, emailOnly: p.emailOnly, capped: p.capped };
  } catch (err) {
    return { ok: false, error: err instanceof AppError ? err.message : "Tahmin hesaplanamadı." };
  }
}

export async function bulkLeadsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const { ctx, ids } = await selectedIds(fd);
    const op = String(fd.get("op") ?? "");
    let message: string;
    switch (op) {
      case "prepare": {
        const r = await startPreparation(ctx, ids, prepareSteps(fd));
        message = `${r.plan.length} firma hazırlanıyor (${r.credits} kredi ayrıldı; yapılamayan adımın kredisi iade edilir). İlerleme listenin üstünde.`;
        break;
      }
      case "find_website": {
        const r = await startWebsiteDiscovery(ctx, ids);
        message = `${r.count} firmanın web sitesi aranıyor (${r.cost} kredi; bulunamayanlar iade edilir).`;
        break;
      }
      case "find_email": {
        const r = await startEmailDiscovery(ctx, ids);
        message = `${r.count} firmanın sitesinde e-posta aranıyor.`;
        break;
      }
      case "score": {
        const r = await startLeadScoring(ctx, ids);
        message = `${r.count} firma puanlanıyor (${r.cost} kredi).`;
        break;
      }
      case "campaign": {
        const campaignId = String(fd.get("campaignId") ?? "");
        if (!campaignId) throw new AppError("VALIDATION", "Kampanya seçin.");
        const r = await addLeadsToCampaign(ctx, campaignId, ids);
        message = `"${r.campaignName}" kampanyasına ${r.added} firma eklendi${r.skipped ? `, ${r.skipped} atlandı (zaten ekli / engelli / kapanmış)` : ""}${r.noEmail ? ` · ${r.noEmail} firmanın e-postası yok, gönderilemez` : ""}${r.alsoInOther ? ` · DİKKAT: ${r.alsoInOther} firma başka bir açık kampanyada da var` : ""}. Kampanya sayfasında "Mesajları üret" ile devam edin.`;
        revalidatePath(`/campaigns/${campaignId}`);
        break;
      }
      case "assign": {
        const raw = String(fd.get("ownerId") ?? "");
        if (!raw) throw new AppError("VALIDATION", "Sorumlu seçin.");
        const n = await bulkAssignOwner(ctx, ids, raw === "none" ? null : raw);
        message = raw === "none" ? `${n} firmanın sorumlusu kaldırıldı.` : `${n} firma seçilen kişiye atandı.`;
        break;
      }
      case "list_add": {
        const listId = String(fd.get("listId") ?? "");
        const newName = String(fd.get("listName") ?? "").trim();
        const target = listId === "__new" ? (await createLeadList(ctx, newName)).id : listId;
        if (!target) throw new AppError("VALIDATION", "Liste seçin veya yeni liste adı girin.");
        const r = await addLeadsToList(ctx, target, ids);
        message = `"${r.name}" listesine ${r.added} firma eklendi.`;
        break;
      }
      case "list_remove": {
        const listId = String(fd.get("listId") ?? "");
        if (!listId || listId === "__new") throw new AppError("VALIDATION", "Liste seçin.");
        const n = await removeLeadsFromList(ctx, listId, ids);
        message = `${n} firma listeden çıkarıldı.`;
        break;
      }
      case "status": {
        const status = String(fd.get("status") ?? "");
        if (!(LEAD_STATUSES as readonly string[]).includes(status)) throw new AppError("VALIDATION", "Durum seçin.");
        const n = await bulkUpdateLeadStatus(ctx, ids, status as LeadStatus);
        message = `${n} firmanın durumu güncellendi.`;
        break;
      }
      case "delete": {
        const n = await bulkDeleteLeads(ctx, ids);
        message = `${n} firma silindi.`;
        break;
      }
      default:
        throw new AppError("VALIDATION", "İşlem seçin.");
    }
    revalidatePath("/leads");
    return { ok: true, message };
  });
}
