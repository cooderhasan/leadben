import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Message, Prisma } from "@prisma/client";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { assertCan } from "@/server/tenancy/permissions";
import type { TenantContext } from "@/server/tenancy/types";
import { findWhatsAppIntegration } from "@/server/tenancy/integration-lookup";
import { whatsappProvider, type WhatsAppCredentials, type WhatsAppTemplate } from "@/server/providers/whatsapp";
import { decryptSecret, encryptSecret, maskSecret } from "@/server/security/secrets";
import { isAIConfigured } from "@/server/ai";
import { enqueue } from "@/server/jobs/queue";
import { audit } from "@/server/audit/audit";
import { AppError } from "@/lib/errors";
import { normalizePhone } from "@/lib/lead-normalize";
import { normalizeCompanyName } from "@/lib/slug";
import { addSuppression, findSuppression } from "./compliance";
import { applyCategory, looksLikeUnsubscribe } from "./conversations";
import { cancelFollowUpsForLead } from "./followups";

const KEY = { type: "WHATSAPP_BUSINESS" as const, provider: "meta_cloud" };
/** Meta kuralı: müşteri son yazdıktan sonra 24 saat serbest metin; sonrasında yalnızca onaylı şablon */
export const SESSION_WINDOW_MS = 24 * 3600_000;
const STOP_WORDS = /^\s*(stop|dur|durdur|iptal|abonelik iptal|unsubscribe)\s*[.!]?\s*$/i;

interface WaConfig {
  phoneNumberId: string;
  wabaId: string;
  displayPhone?: string | null;
  verifiedName?: string | null;
  verifyToken: string;
}
interface WaSecrets {
  accessToken: string;
  appSecret: string;
}

// ── Ayarlar ────────────────────────────────────────────────────────────

export async function getWhatsAppSettings(ctx: TenantContext) {
  assertCan(ctx, "company.read");
  const rec = await tenantDb(ctx).integration.findFirst({ where: KEY });
  if (!rec?.config) return null;
  const cfg = rec.config as unknown as WaConfig;
  let tokenMask: string | null = null;
  try {
    tokenMask = rec.secretsEncrypted ? maskSecret((JSON.parse(decryptSecret(rec.secretsEncrypted)) as WaSecrets).accessToken) : null;
  } catch {
    tokenMask = null;
  }
  return { id: rec.id, status: rec.status, lastError: rec.lastError, lastCheckedAt: rec.lastCheckedAt, ...cfg, tokenMask };
}

/**
 * Meta'nın verdiği bilgilerle bağlanır. Erişim anahtarı ve uygulama gizli anahtarı şifreli saklanır;
 * kaydederken bağlantı test edilir.
 */
export async function saveWhatsAppSettings(ctx: TenantContext, input: { phoneNumberId: string; wabaId: string; accessToken?: string | null; appSecret?: string | null }) {
  assertCan(ctx, "whatsapp.settings");
  const db = tenantDb(ctx);
  const existing = await db.integration.findFirst({ where: KEY });
  const prevCfg = (existing?.config ?? null) as WaConfig | null;
  const prevSecrets = existing?.secretsEncrypted ? (JSON.parse(decryptSecret(existing.secretsEncrypted)) as WaSecrets) : null;
  const secrets: WaSecrets = {
    accessToken: input.accessToken?.trim() || prevSecrets?.accessToken || "",
    appSecret: input.appSecret?.trim() || prevSecrets?.appSecret || "",
  };
  if (!secrets.accessToken || !secrets.appSecret) {
    throw new AppError("VALIDATION", "Erişim anahtarı ve uygulama gizli anahtarı gerekli (Meta for Developers → uygulamanız).", {
      accessToken: secrets.accessToken ? "" : "Gerekli",
    });
  }
  const creds: WhatsAppCredentials = { phoneNumberId: input.phoneNumberId.trim(), wabaId: input.wabaId.trim(), accessToken: secrets.accessToken };

  let info: { displayPhone: string; verifiedName: string } | null = null;
  let lastError: string | null = null;
  try {
    info = await whatsappProvider(creds).getPhoneInfo();
  } catch (err) {
    lastError = (err as Error).message.slice(0, 500);
  }
  const config: WaConfig = {
    phoneNumberId: creds.phoneNumberId,
    wabaId: creds.wabaId,
    displayPhone: info?.displayPhone ?? prevCfg?.displayPhone ?? null,
    verifiedName: info?.verifiedName ?? prevCfg?.verifiedName ?? null,
    verifyToken: prevCfg?.verifyToken ?? randomBytes(18).toString("base64url"),
  };
  const data = {
    config: config as unknown as Prisma.InputJsonValue,
    secretsEncrypted: encryptSecret(JSON.stringify(secrets)),
    status: info ? ("ACTIVE" as const) : ("ERROR" as const),
    lastError,
    lastCheckedAt: new Date(),
    name: "WhatsApp Business",
  };
  const rec = existing
    ? await db.integration.update({ where: { id: existing.id }, data })
    : await db.integration.create({ data: { ...KEY, companyId: ctx.companyId, ...data } });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "whatsapp.settings_saved", entityType: "Integration", entityId: rec.id, metadata: { ok: Boolean(info) } });
  if (!info) throw new AppError("EXTERNAL_FETCH", `Kaydedildi ama bağlantı doğrulanamadı: ${lastError}`);
  return rec;
}

async function activeCreds(companyId: string): Promise<{ id: string; creds: WhatsAppCredentials }> {
  const rec = await tenantDb({ companyId }).integration.findFirst({ where: { ...KEY, status: "ACTIVE" } });
  if (!rec?.config || !rec.secretsEncrypted) throw new AppError("VALIDATION", "WhatsApp Business bağlı değil (Ayarlar → WhatsApp).");
  const cfg = rec.config as unknown as WaConfig;
  const s = JSON.parse(decryptSecret(rec.secretsEncrypted)) as WaSecrets;
  return { id: rec.id, creds: { phoneNumberId: cfg.phoneNumberId, wabaId: cfg.wabaId, accessToken: s.accessToken } };
}

export async function isWhatsAppActive(companyId: string) {
  return (await tenantDb({ companyId }).integration.count({ where: { ...KEY, status: "ACTIVE" } })) > 0;
}

export async function listWhatsAppTemplates(ctx: TenantContext): Promise<WhatsAppTemplate[]> {
  assertCan(ctx, "whatsapp.template");
  const { creds } = await activeCreds(ctx.companyId);
  return whatsappProvider(creds).listTemplates();
}

// ── Webhook ────────────────────────────────────────────────────────────

/** GET doğrulaması (Meta abonelik kurulumu). Doğruysa challenge döner. */
export async function verifyWebhookSubscription(integrationId: string, mode: string | null, token: string | null, challenge: string | null) {
  const rec = await findWhatsAppIntegration(integrationId);
  const cfg = rec?.config as WaConfig | undefined;
  if (!cfg || mode !== "subscribe" || !token || !challenge) return null;
  const a = Buffer.from(token);
  const b = Buffer.from(cfg.verifyToken);
  return a.length === b.length && timingSafeEqual(a, b) ? challenge : null;
}

/** POST imzası: X-Hub-Signature-256 = sha256=HMAC(appSecret, ham gövde) */
export async function verifyWebhookSignature(integrationId: string, rawBody: string, signature: string | null) {
  const rec = await findWhatsAppIntegration(integrationId);
  if (!rec?.secretsEncrypted || !signature?.startsWith("sha256=")) return null;
  const { appSecret } = JSON.parse(decryptSecret(rec.secretsEncrypted)) as WaSecrets;
  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? rec.companyId : null;
}

interface WaWebhookBody {
  entry?: Array<{
    changes?: Array<{
      value?: {
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
        messages?: Array<{ from?: string; id?: string; timestamp?: string; type?: string; text?: { body?: string }; button?: { text?: string } }>;
        statuses?: Array<{ id?: string; status?: string; errors?: Array<{ title?: string }> }>;
      };
    }>;
  }>;
}

/** Gelen mesajları ve teslim durumlarını işler. Bilinmeyen numaradan gelen mesaj yeni "gelen talep" lead'i açar. */
export async function processWhatsAppWebhook(companyId: string, body: WaWebhookBody) {
  const db = tenantDb({ companyId });
  let received = 0;
  for (const change of (body.entry ?? []).flatMap((e) => e.changes ?? [])) {
    const v = change.value ?? {};
    for (const st of v.statuses ?? []) {
      if (!st.id) continue;
      const status = st.status === "delivered" || st.status === "read" ? "DELIVERED" : st.status === "failed" ? "FAILED" : null;
      if (status) {
        await db.message.updateMany({
          where: { providerMessageId: st.id, channel: "WHATSAPP" },
          data: { status, ...(status === "DELIVERED" ? { deliveredAt: new Date() } : { error: st.errors?.[0]?.title?.slice(0, 300) ?? "Teslim edilemedi" }) },
        });
      }
    }
    for (const m of v.messages ?? []) {
      const phone = normalizePhone(m.from ? `+${m.from}` : null);
      if (!phone || !m.id) continue;
      if (await db.conversationMessage.findFirst({ where: { toAddress: `wa:${m.id}` }, select: { id: true } })) continue; // yinelenen teslim
      const text = m.text?.body ?? m.button?.text ?? `[${m.type ?? "mesaj"}]`;
      const profileName = v.contacts?.find((c) => c.wa_id === m.from)?.profile?.name ?? null;
      const receivedAt = m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date();
      await recordWhatsAppInbound(companyId, { phone, text, profileName, waMessageId: m.id, receivedAt });
      received++;
    }
  }
  return { received };
}

async function recordWhatsAppInbound(companyId: string, i: { phone: string; text: string; profileName: string | null; waMessageId: string; receivedAt: Date }) {
  const db = tenantDb({ companyId });
  const contact = await db.leadContact.findFirst({ where: { phone: i.phone }, select: { id: true, leadId: true } });
  let leadId = contact?.leadId ?? (await db.lead.findFirst({ where: { normalizedPhone: i.phone }, select: { id: true } }))?.id ?? null;
  let contactId = contact?.id ?? null;
  if (!leadId) {
    // Numara kayıtlı değil: müşteri kendisi yazdı → "gelen talep" lead'i
    const name = i.profileName?.trim() || `WhatsApp ${i.phone}`;
    const lead = await db.lead.create({
      data: { companyId, companyName: name.slice(0, 300), normalizedName: normalizeCompanyName(name), phone: i.phone, normalizedPhone: i.phone, status: "REPLIED" },
    });
    await db.leadSource.create({ data: { companyId, leadId: lead.id, type: "MANUAL", provider: "whatsapp_inbound" } });
    leadId = lead.id;
  }
  if (!contactId) {
    contactId = (
      await db.leadContact.create({
        data: { companyId, leadId, type: "PERSONAL", fullName: i.profileName?.slice(0, 200) ?? null, phone: i.phone, source: "MANUAL", communicationBasis: "INBOUND_REQUEST", sourceDate: i.receivedAt },
      })
    ).id;
  }

  const conv =
    (await db.conversation.findFirst({ where: { leadId, channel: "WHATSAPP" }, orderBy: { updatedAt: "desc" } })) ??
    (await db.conversation.create({ data: { companyId, leadId, contactId, channel: "WHATSAPP", subject: "WhatsApp" } }));
  const cm = await db.conversationMessage.create({
    data: { companyId, conversationId: conv.id, direction: "INBOUND", fromAddress: i.phone, toAddress: `wa:${i.waMessageId}`, body: i.text.slice(0, 20_000), receivedAt: i.receivedAt },
  });
  await db.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: i.receivedAt } });
  await cancelFollowUpsForLead(companyId, leadId, "WhatsApp'tan yanıt geldi.");
  await db.lead.updateMany({ where: { id: leadId, status: { in: ["NEW", "RESEARCHING", "QUALIFIED", "CONTACT_READY", "CONTACTED"] } }, data: { status: "REPLIED" } });

  if (STOP_WORDS.test(i.text) || looksLikeUnsubscribe(i.text)) {
    await addSuppression(companyId, { type: "PHONE", value: i.phone, source: "REPLY", reason: "WhatsApp'tan ret bildirdi.", leadId });
    await db.leadContact.updateMany({ where: { phone: i.phone }, data: { optOut: true, consentStatus: "WITHDRAWN" } });
    await applyCategory(companyId, cm.id, { category: "UNSUBSCRIBE", confidence: 1, summary: "Alıcı WhatsApp'tan ret bildirdi.", request: null, followUpInDays: null });
  } else if (isAIConfigured()) {
    await enqueue("conversation.classify", { conversationMessageId: cm.id }, { companyId });
  }
  await audit({ companyId, actorType: "SYSTEM", action: "whatsapp.received", entityType: "ConversationMessage", entityId: cm.id });
}

// ── Gönderim (insan onaylı) ────────────────────────────────────────────

async function assertPhoneReachable(companyId: string, leadId: string, phone: string) {
  const suppression = await findSuppression(companyId, { leadId });
  const phoneBlocked = await tenantDb({ companyId }).suppressionRecord.findFirst({ where: { type: "PHONE", value: phone }, select: { id: true } });
  const optOut = await tenantDb({ companyId }).leadContact.findFirst({ where: { phone, optOut: true }, select: { id: true } });
  if (suppression || phoneBlocked || optOut) throw new AppError("FORBIDDEN", "Bu numara iletişim istemediğini bildirdi veya engel listesinde.");
}

/** Müşterinin başlattığı konuşmaya 24 saat içinde serbest metin yanıt. */
export async function replyWhatsApp(ctx: TenantContext, conversationId: string, body: string) {
  assertCan(ctx, "whatsapp.send");
  const text = body.trim();
  if (text.length < 1 || text.length > 4000) throw new AppError("VALIDATION", "Mesaj 1–4000 karakter olmalı.", { body: "Geçersiz uzunluk" });
  const db = tenantDb(ctx);
  const conv = await db.conversation.findUnique({ where: { id: conversationId }, select: { id: true, leadId: true, contactId: true, channel: true } });
  if (!conv || conv.channel !== "WHATSAPP") throw new AppError("NOT_FOUND", "WhatsApp konuşması bulunamadı.");
  const lastIn = await db.conversationMessage.findFirst({ where: { conversationId, direction: "INBOUND" }, orderBy: { receivedAt: "desc" } });
  if (!lastIn?.fromAddress) throw new AppError("VALIDATION", "Müşteriden gelen mesaj yok.");
  if (Date.now() - lastIn.receivedAt.getTime() > SESSION_WINDOW_MS) {
    throw new AppError("VALIDATION", "24 saatlik yanıt penceresi kapandı. Meta kuralı gereği yalnızca onaylı şablon gönderilebilir.");
  }
  await assertPhoneReachable(ctx.companyId, conv.leadId, lastIn.fromAddress);
  const msg = await db.message.create({
    data: { companyId: ctx.companyId, leadId: conv.leadId, contactId: conv.contactId, conversationId, channel: "WHATSAPP", toAddress: lastIn.fromAddress, body: text, status: "APPROVED", approvedById: ctx.userId, approvedAt: new Date(), complianceStatus: "SENDABLE" },
  });
  const jobId = await enqueue("message.send", { messageId: msg.id }, { companyId: ctx.companyId, createdById: ctx.userId });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "whatsapp.reply_requested", entityType: "Message", entityId: msg.id });
  return { messageId: msg.id, jobId };
}

/**
 * İşletmenin başlattığı mesaj: yalnızca Meta onaylı şablon ve yalnızca izni / dayanağı olan kişiye.
 */
export async function sendWhatsAppTemplate(ctx: TenantContext, input: { contactId: string; templateName: string; language: string; params: string[] }) {
  assertCan(ctx, "whatsapp.template");
  const db = tenantDb(ctx);
  const contact = await db.leadContact.findUnique({ where: { id: input.contactId } });
  if (!contact?.phone) throw new AppError("NOT_FOUND", "Telefon numarası olan kişi bulunamadı.");
  const hasBasis =
    contact.consentStatus === "GRANTED" || ["EXPLICIT_CONSENT", "EXISTING_RELATIONSHIP", "INBOUND_REQUEST"].includes(contact.communicationBasis);
  if (!hasBasis || contact.optOut) {
    throw new AppError("FORBIDDEN", "WhatsApp şablonu yalnızca izin veren veya sizinle ilişkisi olan kişiye gönderilebilir (kişinin iletişim dayanağını güncelleyin).");
  }
  await assertPhoneReachable(ctx.companyId, contact.leadId, contact.phone);
  const templates = await listWhatsAppTemplates(ctx);
  const t = templates.find((x) => x.name === input.templateName && x.language === input.language);
  if (!t) throw new AppError("VALIDATION", "Şablon bulunamadı veya onaylı değil.");
  if (input.params.length !== t.bodyParams) throw new AppError("VALIDATION", `Bu şablon ${t.bodyParams} parametre bekliyor.`, { params: "Parametre sayısı" });

  const conv =
    (await db.conversation.findFirst({ where: { leadId: contact.leadId, channel: "WHATSAPP" }, orderBy: { updatedAt: "desc" } })) ??
    (await db.conversation.create({ data: { companyId: ctx.companyId, leadId: contact.leadId, contactId: contact.id, channel: "WHATSAPP", subject: "WhatsApp" } }));
  const preview = t.bodyText.replace(/\{\{(\d+)\}\}/g, (_, n: string) => input.params[Number(n) - 1] ?? "");
  const msg = await db.message.create({
    data: {
      companyId: ctx.companyId,
      leadId: contact.leadId,
      contactId: contact.id,
      conversationId: conv.id,
      channel: "WHATSAPP",
      toAddress: contact.phone,
      subject: `template:${t.name}:${t.language}`,
      body: preview,
      qualityNotes: { template: { name: t.name, language: t.language, params: input.params } } as unknown as Prisma.InputJsonValue,
      status: "APPROVED",
      approvedById: ctx.userId,
      approvedAt: new Date(),
      complianceStatus: "SENDABLE",
    },
  });
  const jobId = await enqueue("message.send", { messageId: msg.id }, { companyId: ctx.companyId, createdById: ctx.userId });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "whatsapp.template_requested", entityType: "Message", entityId: msg.id, metadata: { template: t.name } });
  return { messageId: msg.id, jobId };
}

/** message.send işinden çağrılır (WhatsApp kanalı). Gönderim anında engel listesi tekrar kontrol edilir. */
export async function deliverWhatsApp(companyId: string, msg: Message): Promise<"sent" | "cancelled" | "busy"> {
  const db = tenantDb({ companyId });
  if (!msg.toAddress) return "cancelled";
  try {
    await assertPhoneReachable(companyId, msg.leadId, msg.toAddress);
  } catch {
    await db.message.update({ where: { id: msg.id }, data: { status: "CANCELLED", error: "Numara engel listesinde." } });
    return "cancelled";
  }
  const claimed = await db.message.updateMany({ where: { id: msg.id, status: "APPROVED" }, data: { status: "SCHEDULED", scheduledAt: new Date() } });
  if (claimed.count === 0) return "busy";
  const { creds } = await activeCreds(companyId);
  const provider = whatsappProvider(creds);
  const tpl = (msg.qualityNotes as { template?: { name: string; language: string; params: string[] } } | null)?.template;
  try {
    const res = tpl ? await provider.sendTemplate(msg.toAddress, tpl.name, tpl.language, tpl.params) : await provider.sendText(msg.toAddress, msg.body);
    const now = new Date();
    await db.message.update({ where: { id: msg.id }, data: { status: "SENT", sentAt: now, provider: "whatsapp", providerMessageId: res.id || null, error: null } });
    if (msg.conversationId) await db.conversation.update({ where: { id: msg.conversationId }, data: { lastMessageAt: now } });
    return "sent";
  } catch (err) {
    const retryable = (err as { retryable?: boolean }).retryable === true;
    await db.message.update({ where: { id: msg.id }, data: { status: retryable ? "APPROVED" : "FAILED", error: (err as Error).message.slice(0, 500) } });
    if (retryable) throw err;
    return "cancelled";
  }
}
