"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireTenant } from "@/server/tenancy/context";
import { parseForm, safeAction } from "@/server/actions/safe-action";
import { startOwnWebsiteAnalysis } from "@/server/services/website-analysis";
import {
  addCompetitor,
  completeCompetitorsStep,
  completeOnboarding,
  deleteCompetitor,
  saveCompanyInfo,
  saveExclusions,
  savePrimaryTargetMarket,
  saveProductionInfo,
  saveSalesInfo,
  skipWebsiteStep,
} from "@/server/services/company";
import {
  companyInfoSchema,
  competitorSchema,
  exclusionsSchema,
  productionInfoSchema,
  salesInfoSchema,
  targetMarketSchema,
  websiteSchema,
} from "@/lib/validation";
import type { ActionState } from "@/lib/action-state";

const go = (step: string) => redirect(`/onboarding?step=${step}`);

export async function analyzeWebsiteAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const { website } = parseForm(websiteSchema, fd);
    const { alreadyRunning } = await startOwnWebsiteAnalysis(ctx, website);
    revalidatePath("/onboarding");
    revalidatePath("/company");
    return { ok: true, message: alreadyRunning ? "Analiz zaten devam ediyor." : "Analiz başladı." };
  });
}

export async function skipWebsiteAction() {
  const ctx = await requireTenant();
  await skipWebsiteStep(ctx);
  go("company");
}

type Ctx = Awaited<ReturnType<typeof requireTenant>>;

/** Onboarding adım formu: kaydet → sonraki adıma geç. `returnTo` verilirse oraya döner (profil düzenleme). */
async function runStep(fd: FormData, next: string, save: (ctx: Ctx) => Promise<unknown>): Promise<ActionState> {
  const result = await safeAction(async () => {
    const ctx = await requireTenant();
    await save(ctx);
  });
  if (result.ok) {
    const returnTo = fd.get("returnTo");
    revalidatePath("/", "layout");
    if (typeof returnTo === "string" && returnTo.startsWith("/") && !returnTo.startsWith("//")) redirect(returnTo);
    go(next);
  }
  return result;
}

export async function saveCompanyInfoAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runStep(fd, "products", (ctx) => saveCompanyInfo(ctx, parseForm(companyInfoSchema, fd)));
}

export async function saveProductionAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runStep(fd, "target", (ctx) => saveProductionInfo(ctx, parseForm(productionInfoSchema, fd)));
}

export async function saveTargetAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runStep(fd, "sales", (ctx) => savePrimaryTargetMarket(ctx, parseForm(targetMarketSchema, fd)));
}

export async function saveSalesAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runStep(fd, "competitors", (ctx) => saveSalesInfo(ctx, parseForm(salesInfoSchema, fd)));
}

export async function saveExclusionsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return runStep(fd, "summary", (ctx) => saveExclusions(ctx, parseForm(exclusionsSchema, fd)));
}

export async function addCompetitorAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    await addCompetitor(ctx, parseForm(competitorSchema, fd));
    revalidatePath("/onboarding");
    revalidatePath("/competitors");
    return { ok: true, message: "Rakip eklendi." };
  });
}

export async function deleteCompetitorAction(fd: FormData) {
  const ctx = await requireTenant();
  const id = fd.get("id");
  if (typeof id === "string") await deleteCompetitor(ctx, id);
  revalidatePath("/onboarding");
  revalidatePath("/competitors");
}

export async function finishCompetitorsAction() {
  const ctx = await requireTenant();
  await completeCompetitorsStep(ctx);
  go("exclusions");
}

export async function completeOnboardingAction() {
  const ctx = await requireTenant();
  await completeOnboarding(ctx);
  revalidatePath("/", "layout");
  redirect("/dashboard?welcome=1");
}
