/**
 * BullMQ worker süreci. Production'da web sürecinden ayrı çalışır:
 *   QUEUE_DRIVER=bullmq npm run worker
 */
import "dotenv/config";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import { runJob } from "@/server/jobs/runner";
import { QUEUE_NAME } from "@/server/jobs/queue";
import { rawDb } from "@/server/db";

const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 4);
const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });

const worker = new Worker<{ jobId: string }>(
  QUEUE_NAME,
  async (job) => {
    const maxAttempts = job.opts.attempts ?? 1;
    await runJob(job.data.jobId, { isFinalAttempt: job.attemptsMade + 1 >= maxAttempts });
  },
  { connection, concurrency },
);

worker.on("ready", () => console.log(`[worker] hazır — kuyruk: ${QUEUE_NAME}, eşzamanlılık: ${concurrency}`));
worker.on("failed", (job, err) => console.error(`[worker] ${job?.name} ${job?.id} başarısız:`, err.message));

async function shutdown(signal: string) {
  console.log(`[worker] ${signal} alındı, kapanıyor…`);
  await worker.close();
  await connection.quit();
  await rawDb.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
