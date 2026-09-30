import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/server/env";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { AppError } from "@/lib/errors";
import { addSuppression } from "./compliance";

function secret(): string {
  const s = env().UNSUBSCRIBE_SECRET;
  if (s && s.length >= 16) return s;
  if (env().NODE_ENV === "production") {
    throw new AppError("VALIDATION", "UNSUBSCRIBE_SECRET tanımlı değil (en az 16 karakter). Ret bağlantısı olmadan e-posta gönderilemez.");
  }
  return "dev-only-unsubscribe-secret-change-me";
}

const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url").slice(0, 32);

/** Her ileti için benzersiz ret anahtarı: şirket + mesaj kimliği imzalıdır, tahmin edilemez. */
export function unsubscribeToken(companyId: string, messageId: string): string {
  const payload = `${companyId}.${messageId}`;
  return `${payload}.${sign(payload)}`;
}

/** İleti metnindeki insan için bağlantı (onay sayfası). */
export function unsubscribeUrl(companyId: string, messageId: string): string {
  return `${env().APP_URL.replace(/\/$/, "")}/u/${unsubscribeToken(companyId, messageId)}`;
}

/** List-Unsubscribe başlığı için tek tıkla ret uç noktası (RFC 8058: POST). */
export function oneClickUnsubscribeUrl(companyId: string, messageId: string): string {
  return `${env().APP_URL.replace(/\/$/, "")}/api/unsubscribe/${unsubscribeToken(companyId, messageId)}`;
}

export function verifyUnsubscribeToken(token: string): { companyId: string; messageId: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [companyId, messageId, sig] = parts as [string, string, string];
  if (!/^[a-z0-9]{10,40}$/i.test(companyId) || !/^[a-z0-9]{10,40}$/i.test(messageId)) return null;
  let expected: string;
  try {
    expected = sign(`${companyId}.${messageId}`);
  } catch {
    return null;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { companyId, messageId };
}

/** Ret bağlantısının gösterdiği bilgi (onay sayfası için): hangi firma, hangi adres. */
export async function describeUnsubscribe(token: string) {
  const v = verifyUnsubscribeToken(token);
  if (!v) return null;
  const db = tenantDb({ companyId: v.companyId });
  const [message, company] = await Promise.all([
    db.message.findUnique({ where: { id: v.messageId }, select: { toAddress: true } }),
    db.company.findUnique({ where: { id: v.companyId }, select: { name: true } }),
  ]);
  if (!message?.toAddress || !company) return null;
  const already = await db.suppressionRecord.findFirst({ where: { type: "EMAIL", value: message.toAddress } });
  return { companyName: company.name, address: message.toAddress, alreadyUnsubscribed: Boolean(already) };
}

/**
 * Tek tıkla ret (RFC 8058). Oturum gerektirmez; imza doğrulanır.
 * Adres şirketin listesine eklenir ve o adrese bekleyen tüm iletiler iptal edilir.
 */
export async function processUnsubscribe(token: string): Promise<{ ok: boolean; address?: string; companyName?: string }> {
  const v = verifyUnsubscribeToken(token);
  if (!v) return { ok: false };
  const db = tenantDb({ companyId: v.companyId });
  const message = await db.message.findUnique({ where: { id: v.messageId }, select: { toAddress: true, leadId: true } });
  if (!message?.toAddress) return { ok: false };
  const company = await db.company.findUnique({ where: { id: v.companyId }, select: { name: true } });
  await addSuppression(v.companyId, {
    type: "EMAIL",
    value: message.toAddress,
    source: "UNSUBSCRIBE_LINK",
    reason: "Alıcı ret bağlantısını kullandı.",
    leadId: message.leadId,
  });
  return { ok: true, address: message.toAddress, companyName: company?.name };
}
