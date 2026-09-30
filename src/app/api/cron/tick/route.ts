import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runSchedulerTick } from "@/server/jobs/scheduler";

/** Uygulama içi zamanlayıcı (instrumentation.ts) veya dış cron (CRON_SECRET) çağırır. */
function authorized(req: Request): boolean {
  const given = req.headers.get("x-cron-token") ?? new URL(req.url).searchParams.get("token");
  const allowed = [process.env.CRON_SECRET, process.env.INTERNAL_CRON_TOKEN].filter((v): v is string => Boolean(v && v.length >= 16));
  if (!given) return false;
  return allowed.some((s) => {
    const a = Buffer.from(given);
    const b = Buffer.from(s);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const res = await runSchedulerTick();
  return NextResponse.json({ ok: true, ...res });
}

export const GET = POST;
