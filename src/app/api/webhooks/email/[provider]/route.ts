import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { env } from "@/server/env";
import { applyEmailEvent, parseBrevoEvents, parseResendEvents, type EmailEvent } from "@/server/services/email-events";

function tokenOk(given: string | null): boolean {
  const secret = env().EMAIL_WEBHOOK_SECRET;
  if (!secret || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * E-posta sağlayıcı olayları: teslim, geri dönme, şikâyet, ret.
 * Adres: /api/webhooks/email/<resend|brevo>?token=<EMAIL_WEBHOOK_SECRET>
 */
export async function POST(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!env().EMAIL_WEBHOOK_SECRET) return NextResponse.json({ error: "webhook_disabled" }, { status: 503 });
  if (!tokenOk(new URL(req.url).searchParams.get("token"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  let events: EmailEvent[];
  if (provider === "resend") events = parseResendEvents(body);
  else if (provider === "brevo") events = parseBrevoEvents(body);
  else return NextResponse.json({ error: "unknown_provider" }, { status: 404 });

  let applied = 0;
  for (const e of events.slice(0, 100)) {
    try {
      if (await applyEmailEvent(e)) applied++;
    } catch (err) {
      console.error("[webhook] olay uygulanamadı", provider, e.type, (err as Error).message);
    }
  }
  return NextResponse.json({ ok: true, applied });
}
