import { NextResponse } from "next/server";
import { processWhatsAppWebhook, verifyWebhookSignature, verifyWebhookSubscription } from "@/server/services/whatsapp";

/**
 * WhatsApp Cloud API webhook'u. Her şirketin kendi adresi vardır:
 *   /api/webhooks/whatsapp/<integrationId>
 * GET: Meta abonelik doğrulaması (hub.verify_token). POST: imzalı olaylar (X-Hub-Signature-256).
 */
export async function GET(req: Request, { params }: { params: Promise<{ integrationId: string }> }) {
  const { integrationId } = await params;
  const q = new URL(req.url).searchParams;
  const challenge = await verifyWebhookSubscription(integrationId, q.get("hub.mode"), q.get("hub.verify_token"), q.get("hub.challenge"));
  if (!challenge) return new NextResponse("forbidden", { status: 403 });
  return new NextResponse(challenge, { status: 200, headers: { "content-type": "text/plain" } });
}

export async function POST(req: Request, { params }: { params: Promise<{ integrationId: string }> }) {
  const { integrationId } = await params;
  const raw = await req.text();
  const companyId = await verifyWebhookSignature(integrationId, raw, req.headers.get("x-hub-signature-256"));
  if (!companyId) return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  try {
    const res = await processWhatsAppWebhook(companyId, body as Parameters<typeof processWhatsAppWebhook>[1]);
    return NextResponse.json({ ok: true, ...res });
  } catch (err) {
    console.error("[whatsapp] webhook işlenemedi", (err as Error).message);
    // Meta 200 almazsa tekrar dener; kalıcı hatada yine de 500 dönüp logda görünmesini sağlıyoruz
    return NextResponse.json({ error: "processing_failed" }, { status: 500 });
  }
}
