import "server-only";
import type { Prisma } from "@prisma/client";
import { rawDb } from "@/server/db";
import { env } from "@/server/env";
import type { JobType, JobPayloads } from "./types";

export const QUEUE_NAME = "ai-sales-os";

export interface EnqueueOptions {
  companyId: string | null;
  createdById?: string | null;
  maxAttempts?: number;
}

// ── inline sürücü: işleri web sürecinde, yanıttan sonra çalıştırır ────────
const pending = new Set<Promise<unknown>>();

/** Testlerde bekleyen inline işlerin bitmesini bekler. */
export async function drainInlineJobs(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

let bullQueue: import("bullmq").Queue | undefined;
async function getBullQueue() {
  if (!bullQueue) {
    const { Queue } = await import("bullmq");
    const { default: IORedis } = await import("ioredis");
    const connection = new IORedis(env().REDIS_URL, { maxRetriesPerRequest: null });
    bullQueue = new Queue(QUEUE_NAME, { connection });
  }
  return bullQueue;
}

/**
 * İşi kuyruğa ekler. Her iş DB'de Job kaydı olarak izlenir; UI ilerlemeyi buradan okur.
 * Uzun işlemler asla HTTP isteği içinde beklenmez (spec §97).
 */
export async function enqueue<T extends JobType>(
  type: T,
  payload: JobPayloads[T],
  opts: EnqueueOptions,
): Promise<string> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const job = await rawDb.job.create({
    data: {
      type,
      payload: payload as unknown as Prisma.InputJsonValue,
      companyId: opts.companyId,
      createdById: opts.createdById ?? null,
      maxAttempts,
    },
  });

  if (env().QUEUE_DRIVER === "bullmq") {
    const q = await getBullQueue();
    await q.add(
      type,
      { jobId: job.id },
      {
        jobId: job.id,
        attempts: maxAttempts,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
  } else {
    const p = runInlineWithRetry(job.id, maxAttempts).finally(() => pending.delete(p));
    pending.add(p);
  }
  return job.id;
}

async function runInlineWithRetry(jobId: string, maxAttempts: number) {
  // Yanıtın önce dönmesi için bir tur bekle
  await new Promise((r) => setTimeout(r, 0));
  // Dinamik import: handler'lar servisleri, servisler enqueue()'yu import eder. Statik import
  // döngü oluşturur ve production bundle'da "Cannot access before initialization" hatası verir.
  const { runJob } = await import("./runner");
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await runJob(jobId, { isFinalAttempt: attempt === maxAttempts });
      return;
    } catch {
      if (attempt < maxAttempts) {
        const delay = process.env.NODE_ENV === "test" ? 10 : 2_000 * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
}
