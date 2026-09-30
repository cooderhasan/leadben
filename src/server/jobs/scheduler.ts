import "server-only";
import { rawDb } from "@/server/db";
import { enqueue } from "./queue";
import { pollMailbox } from "./imap-poll";

/** Aynı şirket için hatırlatma işi en fazla bu sıklıkta kuyruğa girer (kredi / AI yoksa boşa dönmesin). */
const MIN_INTERVAL_MS = 30 * 60_000;

/**
 * Zamanlayıcı turu: vakti gelmiş hatırlatması olan şirketler için "followup.run" işi kuyruğa alınır.
 * Şirketler arası tek sorgu (yalnızca companyId okunur); işlemin kendisi tenantDb ile şirket içinde yapılır.
 */
export async function runSchedulerTick(now = new Date()) {
  const due = await rawDb.followUp.findMany({
    where: { status: "SCHEDULED", scheduledAt: { lte: now }, campaign: { status: { notIn: ["PAUSED", "ARCHIVED"] } } },
    distinct: ["companyId"],
    select: { companyId: true },
  });
  let enqueued = 0;
  for (const { companyId } of due) {
    const recent = await rawDb.job.findFirst({
      where: {
        companyId,
        type: "followup.run",
        // Sıklık sınırı gerçek saate göre (now yalnızca "vakti geldi mi" karşılaştırması içindir)
        OR: [{ status: { in: ["QUEUED", "RUNNING"] } }, { createdAt: { gte: new Date(Date.now() - MIN_INTERVAL_MS) } }],
      },
      select: { id: true },
    });
    if (recent) continue;
    await enqueue("followup.run", {}, { companyId, maxAttempts: 2 });
    enqueued++;
  }
  const competitorScans = await scheduleCompetitorScans();
  const mailbox = await pollMailbox().catch((err: Error) => ({ skipped: true as const, reason: err.message.slice(0, 200) }));
  return { companies: due.length, enqueued, competitorScans, mailbox };
}

const WEEK_MS = 7 * 86_400_000;
const MAX_COMPETITOR_SCANS_PER_TICK = 20;

/**
 * İzlemesi açık rakipler haftada bir taranır. Son 7 günde bu rakip için iş açıldıysa
 * (başarılı, başarısız veya kredi yetersizliğinden atlanmış) tekrar kuyruğa alınmaz.
 */
async function scheduleCompetitorScans() {
  const since = new Date(Date.now() - WEEK_MS);
  const candidates = await rawDb.competitor.findMany({
    where: { monitoring: true, website: { not: null } },
    select: { id: true, companyId: true },
    take: 500,
  });
  let enqueued = 0;
  for (const c of candidates) {
    if (enqueued >= MAX_COMPETITOR_SCANS_PER_TICK) break;
    const recent = await rawDb.job.findFirst({
      where: { companyId: c.companyId, type: "competitor.scan", createdAt: { gte: since }, payload: { path: ["competitorId"], equals: c.id } },
      select: { id: true },
    });
    if (recent) continue;
    await enqueue("competitor.scan", { competitorId: c.id }, { companyId: c.companyId, maxAttempts: 2 });
    enqueued++;
  }
  return enqueued;
}
