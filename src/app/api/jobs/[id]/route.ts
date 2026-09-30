import { NextResponse } from "next/server";
import { resolveTenant } from "@/server/tenancy/context";
import { getJobStatus } from "@/server/services/dashboard";

/** Arka plan işinin durumu (UI polling). Yalnızca aktif şirketin işleri görünür. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await resolveTenant();
  if (!ctx) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await params;
  const job = await getJobStatus(ctx, id);
  if (!job) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(job, { headers: { "cache-control": "no-store" } });
}
