import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "@/server/env";
import { ingestInbound, parseInboundPayload } from "@/server/services/inbound-email";

/**
 * Gelen yanıtlar: /api/webhooks/email/inbound?token=<EMAIL_WEBHOOK_SECRET>
 * Brevo Inbound Parsing veya genel JSON ({from,to,subject,text,inReplyTo,references}).
 */
export async function POST(req: Request) {
  const secret = env().EMAIL_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "webhook_disabled" }, { status: 503 });
  const given = new URL(req.url).searchParams.get("token") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  try {
    const res = await ingestInbound(parseInboundPayload(body));
    return NextResponse.json({ ok: true, ...res });
  } catch (err) {
    console.error("[webhook] gelen yanıt işlenemedi", (err as Error).message);
    return NextResponse.json({ error: "processing_failed" }, { status: 500 });
  }
}
