import "server-only";
import type { Prisma } from "@prisma/client";
import { rawDb } from "@/server/db";
import { getLeadSourceProvider } from "@/server/providers/lead-source";
import { ensureJobList, saveDiscoveredLeads } from "@/server/services/leads";
import { refundCredits, CREDIT_COSTS } from "@/server/usage/credits";
import { audit } from "@/server/audit/audit";
import { PermanentJobError, type JobHandler, type JobPayloads } from "../types";

const POLL_MS = () => (process.env.NODE_ENV === "test" ? 5 : 10_000);
/** Tek denemede en fazla bekleme (~10 dk). Aşılırsa iş tekrar denenir ve aynı runId'den devam eder. */
const MAX_POLLS = 60;

export const searchLeadsJob: JobHandler<"lead.search"> = async (payload, h) => {
  if (!h.companyId) throw new PermanentJobError("Şirket bağlamı yok.");
  const provider = getLeadSourceProvider(payload.source ?? "maps");

  // Tekrar denemede yeni (ücretli) çalıştırma başlatma — kayıtlı runId'den devam et
  let runId = payload.runId;
  if (!runId) {
    const run = await provider.startSearch(payload.query);
    runId = run.runId;
    await rawDb.job.update({
      where: { id: h.jobId },
      data: { payload: { ...payload, runId } as unknown as Prisma.InputJsonValue },
    });
  }
  await h.progress(10);

  for (let i = 0; i < MAX_POLLS; i++) {
    const res = await provider.fetchResults(runId);
    if (res.status === "FAILED") throw new PermanentJobError("Lead kaynağı aramayı tamamlayamadı. Kredi iade edildi.");
    if (res.status === "SUCCEEDED") {
      await h.progress(80);
      const leads = res.leads.slice(0, payload.reserved);
      // Her arama kendi listesini oluşturur: sonuçlar karışmasın, sonradan tek tıkla süzülsün
      const listId = await ensureJobList(h.companyId, {
        jobId: h.jobId,
        name: (payload.prompt || payload.interpretation || "Arama").slice(0, 80),
        kind: "SEARCH",
        createdById: h.createdById,
      });
      const saved = await saveDiscoveredLeads(h.companyId, leads, { provider: provider.name, runId, listId, ownerId: h.createdById });

      // Yalnızca yeni eklenen lead'ler ücretlendirilir; mevcut kayıtla birleşenler ücretsiz
      const unusedCredits = (payload.reserved - saved.created) * CREDIT_COSTS["lead.discovery"];
      if (payload.usageId && unusedCredits > 0) await refundCredits(payload.usageId, "lead.search.unused", unusedCredits);

      await audit({
        companyId: h.companyId,
        userId: h.createdById,
        actorType: "SYSTEM",
        action: "lead.search.completed",
        entityType: "Job",
        entityId: h.jobId,
        metadata: { found: res.leads.length, created: saved.created, merged: saved.merged, refunded: Math.max(0, unusedCredits) },
      });
      return { found: res.leads.length, created: saved.created, merged: saved.merged, skipped: saved.skipped };
    }
    await h.progress(10 + Math.min(65, (i + 1) * 2));
    await new Promise((r) => setTimeout(r, POLL_MS()));
  }
  throw new Error("Lead kaynağı henüz sonuç üretmedi; iş tekrar denenecek.");
};

export async function onLeadSearchFailure(payload: JobPayloads["lead.search"]) {
  if (payload.usageId) await refundCredits(payload.usageId, "lead.search.failed");
}
