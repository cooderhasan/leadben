import "server-only";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { findMessageOwner, findOutboundByIds } from "@/server/tenancy/message-lookup";
import { audit } from "@/server/audit/audit";
import { addSuppression } from "./compliance";

export type EmailEventType = "delivered" | "bounced" | "complaint" | "unsubscribed" | "ignored";

export interface EmailEvent {
  type: EmailEventType;
  providerMessageId: string;
  /** Yalnızca soft bounce gibi geçici durumlarda false */
  permanent?: boolean;
}

/** Resend webhook gövdesi → olay listesi */
export function parseResendEvents(body: unknown): EmailEvent[] {
  const b = body as { type?: string; data?: { email_id?: string; bounce?: { type?: string } } };
  const id = b?.data?.email_id;
  if (!id || typeof b.type !== "string") return [];
  switch (b.type) {
    case "email.delivered":
      return [{ type: "delivered", providerMessageId: id }];
    case "email.bounced":
      return [{ type: "bounced", providerMessageId: id, permanent: b.data?.bounce?.type !== "Transient" }];
    case "email.complained":
      return [{ type: "complaint", providerMessageId: id }];
    default:
      return [{ type: "ignored", providerMessageId: id }];
  }
}

/** Brevo (transactional) webhook gövdesi → olay listesi. Tek olay veya dizi gelebilir. */
export function parseBrevoEvents(body: unknown): EmailEvent[] {
  const items = Array.isArray(body) ? body : [body];
  const out: EmailEvent[] = [];
  for (const raw of items) {
    const e = raw as { event?: string; "message-id"?: string };
    const id = e?.["message-id"];
    if (!id || typeof e.event !== "string") continue;
    const map: Record<string, EmailEvent> = {
      delivered: { type: "delivered", providerMessageId: id },
      hard_bounce: { type: "bounced", providerMessageId: id, permanent: true },
      invalid_email: { type: "bounced", providerMessageId: id, permanent: true },
      blocked: { type: "bounced", providerMessageId: id, permanent: true },
      soft_bounce: { type: "bounced", providerMessageId: id, permanent: false },
      spam: { type: "complaint", providerMessageId: id },
      complaint: { type: "complaint", providerMessageId: id },
      unsubscribed: { type: "unsubscribed", providerMessageId: id },
    };
    out.push(map[e.event] ?? { type: "ignored", providerMessageId: id });
  }
  return out;
}

/**
 * Olayı uygular. Kalıcı geri dönme ve şikâyet adresi engel listesine ekler
 * (alan adı itibarını korumak için bu adrese bir daha gönderilmez).
 */
export async function applyEmailEvent(event: EmailEvent): Promise<boolean> {
  if (event.type === "ignored") return false;
  const owner = await findMessageOwner(event.providerMessageId);
  if (!owner) return false;
  return applyEventToMessage(owner, event);
}

/** Geri dönen e-postadaki kimliklerden giden iletiyi bulup geri dönmeyi işler (IMAP). */
export async function applyBounceByIds(ids: string[], permanent: boolean): Promise<boolean> {
  const owner = await findOutboundByIds(ids);
  if (!owner) return false;
  return applyEventToMessage(owner, { type: "bounced", providerMessageId: owner.providerMessageId ?? "", permanent });
}

async function applyEventToMessage(owner: { id: string; companyId: string }, event: EmailEvent): Promise<boolean> {
  const db = tenantDb({ companyId: owner.companyId });
  const msg = await db.message.findUnique({ where: { id: owner.id }, select: { id: true, toAddress: true, leadId: true, status: true } });
  if (!msg) return false;

  if (event.type === "delivered") {
    if (msg.status === "SENT") await db.message.update({ where: { id: msg.id }, data: { status: "DELIVERED", deliveredAt: new Date() } });
    return true;
  }
  if (event.type === "bounced") {
    await db.message.update({ where: { id: msg.id }, data: { status: "BOUNCED", bouncedAt: new Date(), error: event.permanent ? "Kalıcı geri dönme" : "Geçici geri dönme" } });
    if (event.permanent && msg.toAddress) {
      await addSuppression(owner.companyId, { type: "EMAIL", value: msg.toAddress, source: "BOUNCE", reason: "Adres geçersiz / kalıcı geri döndü.", leadId: msg.leadId });
    }
  } else if (msg.toAddress) {
    await addSuppression(owner.companyId, {
      type: "EMAIL",
      value: msg.toAddress,
      source: event.type === "complaint" ? "COMPLAINT" : "UNSUBSCRIBE_LINK",
      reason: event.type === "complaint" ? "Alıcı iletiyi spam olarak işaretledi." : "Alıcı sağlayıcı üzerinden ret etti.",
      leadId: msg.leadId,
    });
  }
  await audit({
    companyId: owner.companyId,
    actorType: "SYSTEM",
    action: `email.${event.type}`,
    entityType: "Message",
    entityId: msg.id,
    metadata: { permanent: event.permanent ?? null },
  });
  return true;
}
