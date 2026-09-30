import { NextResponse } from "next/server";
import { processUnsubscribe, verifyUnsubscribeToken } from "@/server/services/unsubscribe";

/**
 * RFC 8058 tek tıkla ret. E-posta istemcisi (Gmail vb.) bu adrese
 * "List-Unsubscribe=One-Click" gövdesiyle POST atar; oturum gerekmez.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const res = await processUnsubscribe(token);
  if (!res.ok) return NextResponse.json({ ok: false }, { status: 404 });
  return NextResponse.json({ ok: true });
}

/** Tarayıcıdan açılırsa onay sayfasına yönlendir (GET ile ret yapılmaz — bağlantı tarayıcıları yanlışlıkla tetiklemesin). */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!verifyUnsubscribeToken(token)) return NextResponse.json({ ok: false }, { status: 404 });
  return NextResponse.redirect(new URL(`/u/${token}`, req.url), 303);
}
