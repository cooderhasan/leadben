import "server-only";
import { randomUUID } from "node:crypto";
import type { Message } from "@prisma/client";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { assertCan } from "@/server/tenancy/permissions";
import type { TenantContext } from "@/server/tenancy/types";
import { env } from "@/server/env";
import { getEmailProvider } from "@/server/providers/email";
import type { OutgoingEmail } from "@/server/providers/email/types";
import { audit } from "@/server/audit/audit";
import { AppError } from "@/lib/errors";
import { normalizeEmail } from "@/lib/lead-normalize";
import { findSuppression, refreshLeadCompliance } from "./compliance";
import { getSenderSettings, type SenderSettings } from "./email-settings";
import { oneClickUnsubscribeUrl, unsubscribeUrl } from "./unsubscribe";
import { scheduleFollowUpsAfterSend } from "./followups";
import { deliverWhatsApp } from "./whatsapp";

const CONTACTED_FROM = ["NEW", "RESEARCHING", "QUALIFIED", "CONTACT_READY"] as const;
const THROTTLE_MS = () => (process.env.NODE_ENV === "test" ? 0 : 1500);

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Gönderici kimliği + ret bağlantısı içeren alt bilgi (6563 s.K.: gönderici kimliği ve ret hakkı).
 * Mesaj gövdesine her gönderimde sistem ekler; kullanıcı/AI bunu kaldıramaz.
 */
export function buildEmailContent(body: string, sender: SenderSettings, unsubscribe: string) {
  const footerLines = [
    sender.signature?.trim() || sender.fromName,
    sender.legalName,
    sender.postalAddress,
    sender.phone ?? null,
  ].filter(Boolean) as string[];
  const legal = `Bu ileti ${sender.legalName} tarafından ticari amaçla gönderilmiştir. Almak istemiyorsanız: ${unsubscribe}`;
  const text = `${body.trim()}\n\n--\n${footerLines.join("\n")}\n\n${legal}`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.55;color:#222">${escapeHtml(body.trim())
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px">${p.replace(/\n/g, "<br>")}</p>`)
    .join("")}<p style="margin:20px 0 0;color:#555">--<br>${footerLines.map(escapeHtml).join("<br>")}</p><p style="margin:16px 0 0;font-size:12px;color:#888">Bu ileti ${escapeHtml(sender.legalName)} tarafından ticari amaçla gönderilmiştir. <a href="${escapeHtml(unsubscribe)}" style="color:#888">E-posta almayı durdur</a></p></div>`;
  return { text, html };
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export interface SendRunResult {
  sent: number;
  failed: number;
  skipped: number;
  remainingApproved: number;
  quotaReached: boolean;
  paused: boolean;
}

export type DeliveryOutcome = "sent" | "skipped" | "cancelled" | "failed" | "busy";

interface DeliveryContext {
  settings: SenderSettings;
  provider: NonNullable<ReturnType<typeof getEmailProvider>>;
}

/**
 * Tek bir onaylı iletiyi gönderir. Kampanya iletisi de, yanıt taslağı da bu yoldan geçer:
 *   engel listesi → uyum → kilit (APPROVED→SCHEDULED) → sağlayıcı → durum güncelleme.
 * Alıcının kendi yazdığı bir konuşmaya yanıt ise (inbound varsa) iletişim dayanağı "gelen talep"tir;
 * frekans sınırı uygulanmaz ama ret / engel yine kesin olarak engeller.
 * Geçici sağlayıcı hatasında ileti APPROVED'a döner ve hata `retryable=true` ile fırlatılır.
 */
export async function deliverMessage(
  companyId: string,
  msg: Message,
  { settings, provider }: DeliveryContext,
): Promise<DeliveryOutcome> {
  const db = tenantDb({ companyId });
  if (!msg.toAddress) {
    await db.message.update({ where: { id: msg.id }, data: { status: "FAILED", error: "Alıcı adresi yok." } });
    return "failed";
  }

  // 1) Engel listesi (ret talebi onaydan sonra gelmiş olabilir)
  const suppression = await findSuppression(companyId, { email: msg.toAddress, leadId: msg.leadId });
  if (suppression) {
    await db.message.update({ where: { id: msg.id }, data: { status: "CANCELLED", error: "Alıcı ret/engel listesinde." } });
    return "cancelled";
  }

  // 2) Uyum
  const { records } = await refreshLeadCompliance(companyId, msg.leadId);
  const rec = records.find((r) => r.address === msg.toAddress) ?? null;
  const isReply = msg.conversationId
    ? (await db.conversationMessage.count({ where: { conversationId: msg.conversationId, direction: "INBOUND" } })) > 0
    : false;
  if (isReply) {
    if (rec?.optOut || rec?.suppressed) {
      await db.message.update({ where: { id: msg.id }, data: { status: "CANCELLED", error: "Alıcı iletişim istemiyor." } });
      return "cancelled";
    }
  } else {
    if (!rec || rec.status === "DO_NOT_SEND") {
      await db.message.update({
        where: { id: msg.id },
        data: { status: "CANCELLED", complianceStatus: "DO_NOT_SEND", error: rec?.reasons[0] ?? "Adres artık gönderilemez." },
      });
      return "cancelled";
    }
    if (rec.status !== "SENDABLE") {
      await db.message.update({ where: { id: msg.id }, data: { complianceStatus: rec.status, error: rec.reasons[0] ?? "İnceleme gerekli." } });
      return "skipped";
    }
  }

  // 3) Kilit: yalnızca hâlâ APPROVED ise gönder (eşzamanlı iki iş aynı mesajı gönderemez)
  const claimed = await db.message.updateMany({ where: { id: msg.id, status: "APPROVED" }, data: { status: "SCHEDULED", scheduledAt: new Date() } });
  if (claimed.count === 0) return "busy";

  const email: OutgoingEmail = {
    from: { email: settings.fromEmail, name: settings.fromName },
    to: msg.toAddress,
    replyTo: settings.replyTo ?? undefined,
    subject: msg.subject ?? "",
    ...buildEmailContent(msg.body, settings, unsubscribeUrl(companyId, msg.id)),
    unsubscribeUrl: oneClickUnsubscribeUrl(companyId, msg.id),
    messageId: msg.id,
  };

  try {
    const res = await provider.send(email);
    const now = new Date();
    await db.message.update({
      where: { id: msg.id },
      data: {
        status: "SENT",
        sentAt: now,
        provider: provider.name,
        providerMessageId: res.providerMessageId || null,
        complianceStatus: isReply ? "SENDABLE" : rec!.status,
        error: null,
      },
    });
    if (rec) await db.complianceRecord.update({ where: { id: rec.id }, data: { lastContactedAt: now } });
    if (msg.contactId) await db.leadContact.updateMany({ where: { id: msg.contactId }, data: { lastContactedAt: now } });
    if (!isReply) {
      await db.lead.updateMany({ where: { id: msg.leadId, status: { in: [...CONTACTED_FROM] } }, data: { status: "CONTACTED" } });
      if (msg.campaignId) {
        await db.campaignLead.updateMany({
          where: { campaignId: msg.campaignId, leadId: msg.leadId, status: { in: [...CONTACTED_FROM] } },
          data: { status: "CONTACTED" },
        });
      }
    }
    if (msg.conversationId) await db.conversation.update({ where: { id: msg.conversationId }, data: { lastMessageAt: now } });
    await scheduleFollowUpsAfterSend(companyId, { ...msg, sentAt: now });
    return "sent";
  } catch (err) {
    const retryable = (err as { retryable?: boolean }).retryable !== false;
    const message = (err as Error).message.slice(0, 500);
    if (retryable) {
      // Geçici hata: kilidi aç, iş tekrar denensin (gönderilenler SENT olduğu için tekrar gönderilmez)
      await db.message.update({ where: { id: msg.id }, data: { status: "APPROVED", error: message } });
      // Ağ hatası gibi işaretsiz hatalar da geçici sayılır; iş katmanı bu işarete bakar
      (err as { retryable?: boolean }).retryable = true;
      throw err;
    }
    await db.message.update({ where: { id: msg.id }, data: { status: "FAILED", error: message } });
    return "failed";
  }
}

async function deliveryContext(companyId: string): Promise<DeliveryContext> {
  const provider = getEmailProvider();
  if (!provider) throw new AppError("VALIDATION", "E-posta sağlayıcısı yapılandırılmamış.");
  const { settings } = await getSenderSettings(companyId);
  if (!settings) throw new AppError("VALIDATION", "Gönderici kimliği eksik.");
  return { settings, provider };
}

async function remainingQuota(companyId: string) {
  const sentToday = await tenantDb({ companyId }).message.count({ where: { direction: "OUTBOUND", channel: "EMAIL", sentAt: { gte: startOfToday() } } });
  return Math.max(0, env().EMAIL_DAILY_LIMIT - sentToday);
}

/**
 * Onaylı kampanya mesajlarını gönderir. Her mesajdan hemen önce kampanya hâlâ RUNNING mi
 * kontrol edilir; günlük sınır aşılmaz. Tek ileti gönderimi `deliverMessage` ile yapılır.
 */
export async function sendApprovedMessages(
  companyId: string,
  campaignId: string,
  progress?: (pct: number) => Promise<void>,
): Promise<SendRunResult> {
  const db = tenantDb({ companyId });
  const dctx = await deliveryContext(companyId);
  const quota = await remainingQuota(companyId);
  const batch = await db.message.findMany({
    where: { campaignId, status: "APPROVED" },
    orderBy: { approvedAt: "asc" },
    take: quota,
  });

  const result: SendRunResult = { sent: 0, failed: 0, skipped: 0, remainingApproved: 0, quotaReached: false, paused: false };
  for (let i = 0; i < batch.length; i++) {
    const campaign = await db.campaign.findUnique({ where: { id: campaignId }, select: { status: true } });
    if (campaign?.status !== "RUNNING") {
      result.paused = true;
      break;
    }
    const outcome = await deliverMessage(companyId, batch[i]!, dctx);
    if (outcome === "sent") result.sent++;
    else if (outcome === "failed") result.failed++;
    else if (outcome === "skipped" || outcome === "cancelled") result.skipped++;
    await progress?.(((i + 1) / Math.max(1, batch.length)) * 95);
    if (outcome === "sent" && THROTTLE_MS() > 0) await new Promise((r) => setTimeout(r, THROTTLE_MS()));
  }

  result.remainingApproved = await db.message.count({ where: { campaignId, status: "APPROVED" } });
  result.quotaReached = result.remainingApproved > 0 && !result.paused && batch.length >= quota;

  // Açık mesaj ve planlı hatırlatma kalmadıysa kampanya tamamlanır
  const open = await db.message.count({ where: { campaignId, status: { in: ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SCHEDULED"] } } });
  const pendingFollowUps = await db.followUp.count({ where: { campaignId, status: "SCHEDULED" } });
  if (open === 0 && pendingFollowUps === 0 && !result.paused) {
    await db.campaign.updateMany({ where: { id: campaignId, status: "RUNNING" }, data: { status: "COMPLETED", completedAt: new Date() } });
  } else if (!result.paused && result.remainingApproved === 0) {
    // Gönderilecek onaylı mesaj kalmadı; onay bekleyen mesaj veya planlı hatırlatma var → hazır durumuna dön
    await db.campaign.updateMany({ where: { id: campaignId, status: "RUNNING" }, data: { status: "READY" } });
  }

  await audit({
    companyId,
    actorType: "SYSTEM",
    action: "campaign.send_batch",
    entityType: "Campaign",
    entityId: campaignId,
    metadata: { ...result },
  });
  return result;
}

/** Kampanya dışı tek ileti (ör. yanıt taslağı). HTTP isteğinde değil, iş (job) içinde çalışır. */
export async function sendSingleApprovedMessage(companyId: string, messageId: string): Promise<DeliveryOutcome> {
  const db = tenantDb({ companyId });
  const msg = await db.message.findUnique({ where: { id: messageId } });
  if (!msg || msg.status !== "APPROVED") return "busy";
  if (msg.channel === "WHATSAPP") return deliverWhatsApp(companyId, msg);
  if ((await remainingQuota(companyId)) <= 0) {
    await db.message.update({ where: { id: msg.id }, data: { error: "Günlük gönderim sınırı doldu; yarın tekrar deneyin." } });
    return "skipped";
  }
  return deliverMessage(companyId, msg, await deliveryContext(companyId));
}

/** Gönderim işi kalıcı olarak başarısız olursa kampanya duraklatılır (sessizce RUNNING kalmasın). */
export async function pauseAfterSendFailure(companyId: string, campaignId: string, error: string) {
  await tenantDb({ companyId }).campaign.updateMany({ where: { id: campaignId, status: "RUNNING" }, data: { status: "PAUSED" } });
  await audit({ companyId, actorType: "SYSTEM", action: "campaign.send_failed", entityType: "Campaign", entityId: campaignId, metadata: { error: error.slice(0, 500) } });
}

// ── Test e-postası ────────────────────────────────────────────────────

const TEST_EMAILS_PER_HOUR = 5;

/**
 * Yöneticinin kendi adresine örnek ileti: SMTP ayarları, spam klasörü ve alt bilgi kontrolü için.
 * Gerçek gönderimle aynı yol (sağlayıcı + gönderici kimliği + alt bilgi) kullanılır; müşteri iletisi
 * olarak kaydedilmez, günlük kotaya sayılmaz, kredi harcamaz. Kötüye kullanıma karşı saatte 5 ile sınırlı.
 */
export async function sendTestEmail(ctx: TenantContext, toInput: string) {
  assertCan(ctx, "email.settings");
  const to = normalizeEmail(toInput);
  if (!to) throw new AppError("VALIDATION", "Geçerli bir e-posta adresi girin.", { to: "Geçersiz adres" });
  const provider = getEmailProvider();
  if (!provider) throw new AppError("VALIDATION", "Sunucuda e-posta sağlayıcısı tanımlı değil (Coolify → EMAIL_PROVIDER ve SMTP_* değişkenleri, ardından Redeploy).");
  const { settings } = await getSenderSettings(ctx.companyId);
  if (!settings) throw new AppError("VALIDATION", "Önce yukarıdaki gönderici kimliğini kaydedin.");

  const recent = await tenantDb(ctx).auditLog.count({ where: { action: "email.test_sent", createdAt: { gte: new Date(Date.now() - 3600_000) } } });
  if (recent >= TEST_EMAILS_PER_HOUR) throw new AppError("RATE_LIMITED", `Saatte en fazla ${TEST_EMAILS_PER_HOUR} test e-postası gönderilebilir. Biraz sonra tekrar deneyin.`);

  const exampleUnsubscribe = `${env().APP_URL.replace(/\/$/, "")}/u/ornek-baglanti`;
  const body = [
    "Merhaba,",
    "Bu, AI Sales OS'tan gönderilen bir test iletisidir. Bu iletiyi okuyorsanız e-posta ayarlarınız çalışıyor.",
    "Kontrol edin: ileti gelen kutusuna mı yoksa spam klasörüne mi düştü? Gönderen adı ve adresi doğru mu? Alttaki gönderici kimliği ve ret bağlantısı görünüyor mu?",
    "Not: Alttaki ret bağlantısı bu test iletisinde örnektir; gerçek kampanya iletilerinde alıcıya özel, çalışan bir bağlantı eklenir.",
  ].join("\n\n");
  const content = buildEmailContent(body, settings, exampleUnsubscribe);
  const messageId = `test-${randomUUID()}`;
  const res = await provider.send({
    from: { email: settings.fromEmail, name: settings.fromName },
    to,
    replyTo: settings.replyTo ?? undefined,
    subject: `Test e-postası — ${settings.fromName}`,
    text: content.text,
    html: content.html,
    unsubscribeUrl: exampleUnsubscribe,
    messageId,
  });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "email.test_sent", metadata: { provider: provider.name, accepted: res.accepted } });
  if (!res.accepted) throw new AppError("EXTERNAL_FETCH", "Sağlayıcı iletiyi kabul etmedi. Gönderen adresin SMTP hesabına tanımlı olduğunu kontrol edin.");
  return { to, provider: provider.name };
}
