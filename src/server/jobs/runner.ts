import "server-only";
import type { Prisma } from "@prisma/client";
import { rawDb } from "@/server/db";
import { isAppError } from "@/lib/errors";
import { handlers } from "./handlers";
import { PermanentJobError, type JobType } from "./types";

/**
 * Tek bir işi çalıştırır. Hem inline sürücü hem BullMQ worker bunu çağırır.
 * Başarısız olursa hatayı fırlatır (sürücü retry yapar); kalıcı hatalarda veya son denemede
 * Job FAILED olarak işaretlenir ve handler'ın onFailure'ı çağrılır.
 */
export async function runJob(jobId: string, opts: { isFinalAttempt: boolean }): Promise<void> {
  const job = await rawDb.job.findUnique({ where: { id: jobId } });
  if (!job) throw new PermanentJobError(`Job bulunamadı: ${jobId}`);
  if (job.status === "SUCCEEDED" || job.status === "CANCELLED") return;

  const def = handlers[job.type as JobType];
  if (!def) {
    await rawDb.job.update({ where: { id: jobId }, data: { status: "FAILED", error: `Bilinmeyen iş tipi: ${job.type}`, finishedAt: new Date() } });
    return;
  }

  await rawDb.job.update({
    where: { id: jobId },
    data: { status: "RUNNING", attempts: { increment: 1 }, startedAt: job.startedAt ?? new Date(), error: null },
  });

  try {
    const result = await (def.run as (p: unknown, h: unknown) => Promise<unknown>)(job.payload, {
      jobId,
      companyId: job.companyId,
      createdById: job.createdById,
      isFinalAttempt: opts.isFinalAttempt,
      progress: async (pct: number) => {
        await rawDb.job.update({ where: { id: jobId }, data: { progress: Math.max(0, Math.min(100, Math.round(pct))) } });
      },
    });
    await rawDb.job.update({
      where: { id: jobId },
      data: {
        status: "SUCCEEDED",
        progress: 100,
        finishedAt: new Date(),
        result: (result ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (err) {
    const permanent = err instanceof PermanentJobError || (isAppError(err) && err.code !== "AI_UNAVAILABLE");
    const final = permanent || opts.isFinalAttempt;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[job] ${job.type} ${jobId} hata (final=${final}):`, message);

    await rawDb.job.update({
      where: { id: jobId },
      data: { status: final ? "FAILED" : "QUEUED", error: message.slice(0, 2000), finishedAt: final ? new Date() : null },
    });
    if (final) {
      await def.onFailure?.(job.payload as never, message).catch((e: unknown) => console.error("[job] onFailure hatası", e));
      return;
    }
    throw err;
  }
}
