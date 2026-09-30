import "server-only";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { Prisma } from "@prisma/client";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { assertCan } from "@/server/tenancy/permissions";
import type { TenantContext } from "@/server/tenancy/types";
import { findActiveApiKey, touchApiKey } from "@/server/tenancy/api-key-lookup";
import { decryptSecret, encryptSecret } from "@/server/security/secrets";
import { isPrivateAddress, normalizeUrl } from "@/server/web/ssrf";
import { allowPrivateFetch } from "@/server/jobs/handlers/website-analyze";
import { enqueue } from "@/server/jobs/queue";
import { audit } from "@/server/audit/audit";
import { AppError } from "@/lib/errors";

// ── API anahtarları ────────────────────────────────────────────────────

export const API_SCOPES = ["read", "write"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

export async function listApiKeys(ctx: TenantContext) {
  assertCan(ctx, "integrations.manage");
  return tenantDb(ctx).apiKey.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, prefix: true, scopes: true, lastUsedAt: true, revokedAt: true, createdAt: true },
  });
}

/** Yeni anahtar. Tam anahtar YALNIZCA bu yanıtta döner; veritabanında yalnızca özeti tutulur. */
export async function createApiKey(ctx: TenantContext, input: { name: string; scope: ApiScope }) {
  assertCan(ctx, "integrations.manage");
  const secret = randomBytes(24).toString("base64url");
  const key = `sos_live_${secret}`;
  const rec = await tenantDb(ctx).apiKey.create({
    data: {
      companyId: ctx.companyId,
      name: input.name.slice(0, 100),
      prefix: key.slice(0, 15),
      keyHash: hashKey(key),
      scopes: input.scope === "write" ? ["read", "write"] : ["read"],
      createdById: ctx.userId,
    },
  });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "api_key.created", entityType: "ApiKey", entityId: rec.id, metadata: { scope: input.scope } });
  return { id: rec.id, key };
}

export async function revokeApiKey(ctx: TenantContext, id: string) {
  assertCan(ctx, "integrations.manage");
  const res = await tenantDb(ctx).apiKey.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } });
  if (res.count === 0) throw new AppError("NOT_FOUND", "Anahtar bulunamadı.");
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "api_key.revoked", entityType: "ApiKey", entityId: id });
}

/**
 * "Authorization: Bearer sos_live_…" başlığını doğrular. API anahtarı, onu oluşturan kullanıcı adına,
 * kapsamına göre İzleyici (read) veya Üye (write) yetkisiyle çalışır — yöneticinin tam yetkisini almaz.
 */
export async function authenticateApiKey(authorization: string | null, need: ApiScope): Promise<TenantContext> {
  const key = authorization?.match(/^Bearer\s+(sos_live_[A-Za-z0-9_-]{20,})$/)?.[1];
  if (!key) throw new AppError("UNAUTHENTICATED", "Geçerli bir API anahtarı gerekli (Authorization: Bearer sos_live_…).");
  const rec = await findActiveApiKey(hashKey(key));
  if (!rec) throw new AppError("UNAUTHENTICATED", "API anahtarı geçersiz veya geri çekilmiş.");
  if (!rec.scopes.includes(need)) throw new AppError("FORBIDDEN", `Bu işlem için "${need}" yetkili anahtar gerekli.`);
  await touchApiKey(rec.id);
  return { userId: rec.createdById, companyId: rec.companyId, role: rec.scopes.includes("write") ? "MEMBER" : "VIEWER", isPlatformAdmin: false };
}

// ── Giden webhook'lar ──────────────────────────────────────────────────

export const WEBHOOK_EVENTS = {
  "lead.created": "Lead eklendi (elle / API)",
  "leads.imported": "Lead'ler toplu eklendi (arama / CSV)",
  "reply.received": "Yanıt geldi ve sınıflandırıldı",
  "opportunity.stage_changed": "Fırsat aşaması değişti",
  "proposal.accepted": "Teklif kabul edildi",
} as const;
export type WebhookEvent = keyof typeof WEBHOOK_EVENTS;

/** Hedef adres herkese açık bir https adresi olmalı (SSRF koruması: iç ağ / localhost engellenir). */
export async function assertPublicHttpsUrl(input: string): Promise<URL> {
  let url: URL;
  try {
    url = normalizeUrl(input);
  } catch {
    throw new AppError("VALIDATION", "Geçerli bir adres girin.", { url: "Geçersiz adres" });
  }
  if (allowPrivateFetch()) return url; // yalnızca test/geliştirme
  if (url.protocol !== "https:") throw new AppError("VALIDATION", "Webhook adresi https olmalı.", { url: "https gerekli" });
  const addrs = await lookup(url.hostname, { all: true }).catch(() => []);
  if (addrs.length === 0) throw new AppError("VALIDATION", "Adres çözümlenemedi.", { url: "Alan adı bulunamadı" });
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new AppError("VALIDATION", "İç ağ adreslerine webhook gönderilemez.", { url: "İç ağ adresi" });
  return url;
}

export async function listWebhooks(ctx: TenantContext) {
  assertCan(ctx, "integrations.manage");
  return tenantDb(ctx).webhookEndpoint.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, url: true, events: true, active: true, lastStatus: true, lastError: true, lastDeliveredAt: true, failureCount: true, createdAt: true },
  });
}

/** Gizli imza anahtarı YALNIZCA bu yanıtta gösterilir (alıcı tarafta doğrulama için). */
export async function createWebhook(ctx: TenantContext, input: { url: string; events: string[] }) {
  assertCan(ctx, "integrations.manage");
  const events = input.events.filter((e): e is WebhookEvent => e in WEBHOOK_EVENTS);
  if (events.length === 0) throw new AppError("VALIDATION", "En az bir olay seçin.", { events: "Olay seçin" });
  const url = await assertPublicHttpsUrl(input.url);
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  const rec = await tenantDb(ctx).webhookEndpoint.create({
    data: { companyId: ctx.companyId, url: url.toString(), events, secretEncrypted: encryptSecret(secret), createdById: ctx.userId },
  });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "webhook.created", entityType: "WebhookEndpoint", entityId: rec.id, metadata: { events } });
  return { id: rec.id, secret };
}

export async function deleteWebhook(ctx: TenantContext, id: string) {
  assertCan(ctx, "integrations.manage");
  const res = await tenantDb(ctx).webhookEndpoint.deleteMany({ where: { id } });
  if (res.count === 0) throw new AppError("NOT_FOUND", "Webhook bulunamadı.");
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "webhook.deleted", entityType: "WebhookEndpoint", entityId: id });
}

export async function sendTestWebhook(ctx: TenantContext, id: string) {
  assertCan(ctx, "integrations.manage");
  const ep = await tenantDb(ctx).webhookEndpoint.findUnique({ where: { id }, select: { id: true } });
  if (!ep) throw new AppError("NOT_FOUND", "Webhook bulunamadı.");
  return enqueue("webhook.deliver", { endpointId: id, eventId: `evt_test_${randomBytes(6).toString("hex")}`, event: "test", data: { message: "Bağlantı testi" } }, { companyId: ctx.companyId, maxAttempts: 1 });
}

/**
 * Olay yayınla: bu olaya abone her aktif uç nokta için ayrı teslim işi kuyruğa alınır.
 * Webhook hatası asıl işlemi asla bozmaz.
 */
export async function emitEvent(companyId: string, event: WebhookEvent, data: Record<string, unknown>) {
  try {
    const endpoints = await tenantDb({ companyId }).webhookEndpoint.findMany({ where: { active: true, events: { has: event } }, select: { id: true } });
    const eventId = `evt_${randomBytes(9).toString("hex")}`;
    for (const ep of endpoints) {
      await enqueue("webhook.deliver", { endpointId: ep.id, eventId, event, data }, { companyId, maxAttempts: 4 });
    }
  } catch (err) {
    console.error("[webhook] olay kuyruğa alınamadı", event, (err as Error).message);
  }
}

/** İmza: X-SOS-Signature = sha256=HMAC(secret, "<timestamp>.<gövde>") — alıcı tekrar saldırısını zaman damgasıyla sınırlar. */
export function signPayload(secret: string, timestamp: string, body: string) {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

const MAX_FAILURES_BEFORE_DISABLE = 20;

/** webhook.deliver işinden çağrılır. Başarısızlıkta hata fırlatır (iş tekrar dener). */
export async function deliverWebhook(companyId: string, input: { endpointId: string; eventId: string; event: string; data: unknown }, isFinalAttempt: boolean) {
  const db = tenantDb({ companyId });
  const ep = await db.webhookEndpoint.findUnique({ where: { id: input.endpointId } });
  if (!ep || !ep.active) return { skipped: true };
  const url = await assertPublicHttpsUrl(ep.url);
  const body = JSON.stringify({ id: input.eventId, type: input.event, createdAt: new Date().toISOString(), data: input.data });
  const timestamp = String(Math.floor(Date.now() / 1000));
  let status = 0;
  let error: string | null = null;
  try {
    const res = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        "user-agent": "AISalesOS-Webhook/1.0",
        "x-sos-event": input.event,
        "x-sos-event-id": input.eventId,
        "x-sos-timestamp": timestamp,
        "x-sos-signature": signPayload(decryptSecret(ep.secretEncrypted), timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = (err as Error).message.slice(0, 300);
  }

  if (!error) {
    await db.webhookEndpoint.update({ where: { id: ep.id }, data: { lastStatus: status, lastError: null, lastDeliveredAt: new Date(), failureCount: 0 } });
    return { status };
  }
  if (isFinalAttempt) {
    const failures = ep.failureCount + 1;
    await db.webhookEndpoint.update({
      where: { id: ep.id },
      data: { lastStatus: status || null, lastError: error, failureCount: failures, active: failures < MAX_FAILURES_BEFORE_DISABLE },
    });
    if (failures >= MAX_FAILURES_BEFORE_DISABLE) {
      await audit({ companyId, actorType: "SYSTEM", action: "webhook.disabled", entityType: "WebhookEndpoint", entityId: ep.id, metadata: { error } });
    }
  }
  throw new Error(`Webhook teslim edilemedi: ${error}`);
}

/** API yanıtları için lead'in dışa açık alanları (iç notlar, ham kaynak verisi hariç). */
export function publicLead(l: {
  id: string;
  companyName: string;
  website: string | null;
  domain: string | null;
  phone: string | null;
  genericEmail: string | null;
  city: string | null;
  district: string | null;
  country: string | null;
  industry: string | null;
  status: string;
  fitScore: number | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: l.id,
    companyName: l.companyName,
    website: l.website,
    domain: l.domain,
    phone: l.phone,
    email: l.genericEmail,
    city: l.city,
    district: l.district,
    country: l.country,
    industry: l.industry,
    status: l.status,
    fitScore: l.fitScore,
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
  } satisfies Record<string, Prisma.JsonValue>;
}
