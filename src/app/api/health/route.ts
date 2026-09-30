import { NextResponse } from "next/server";
import { rawDb } from "@/server/db";

export const dynamic = "force-dynamic";

/** Canlılık kontrolü (load balancer / docker healthcheck). */
export async function GET() {
  try {
    await rawDb.$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
