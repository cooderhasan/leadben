import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { rawDb } from "@/server/db";
import { drainInlineJobs } from "@/server/jobs/queue";
import { createApiKey, createWebhook, emitEvent, revokeApiKey, signPayload } from "@/server/services/integrations";
import { createManualLead } from "@/server/services/leads";
import { GET as listLeadsRoute, POST as createLeadRoute } from "@/app/api/v1/leads/route";
import { GET as getLeadRoute } from "@/app/api/v1/leads/[id]/route";
import { POST as createTaskRoute } from "@/app/api/v1/tasks/route";
import { createTenant, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await rawDb.$disconnect();
});

const call = async (handler: (req: Request, ctx: { params: Promise<never> }) => Promise<Response>, url: string, init: RequestInit & { key?: string } = {}, params: unknown = {}) => {
  const headers = new Headers(init.headers);
  if (init.key) headers.set("authorization", `Bearer ${init.key}`);
  const res = await handler(new Request(`http://localhost${url}`, { ...init, headers }), { params: Promise.resolve(params as never) });
  return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown>; error?: { code: string; message: string } } };
};

describe("REST API v1", () => {
  it("anahtar yoksa/geçersizse 401; okuma anahtarı yazamaz (403); yazma anahtarı lead ekler, dedupe çalışır", async () => {
    const a = await createTenant("A");
    const { key: readKey } = await createApiKey(a, { name: "okuma", scope: "read" });
    const { key: writeKey } = await createApiKey(a, { name: "yazma", scope: "write" });

    expect((await call(listLeadsRoute, "/api/v1/leads")).status).toBe(401);
    expect((await call(listLeadsRoute, "/api/v1/leads", { key: "sos_live_yanlisanahtar00000000000" })).status).toBe(401);

    const body = JSON.stringify({ companyName: "API Firma A.Ş.", website: "https://apifirma.com", city: "Bursa" });
    expect((await call(createLeadRoute, "/api/v1/leads", { method: "POST", body, key: readKey })).status).toBe(403);
    const created = await call(createLeadRoute, "/api/v1/leads", { method: "POST", body, key: writeKey });
    expect(created.status).toBe(200);
    expect(created.body.data).toMatchObject({ merged: false, lead: { companyName: "API Firma A.Ş.", domain: "apifirma.com" } });
    const again = await call(createLeadRoute, "/api/v1/leads", { method: "POST", body: JSON.stringify({ companyName: "Api Firma", website: "apifirma.com" }), key: writeKey });
    expect(again.body.data).toMatchObject({ merged: true });

    const list = await call(listLeadsRoute, "/api/v1/leads?limit=10", { key: readKey });
    expect(list.body.data).toMatchObject({ total: 1 });
    // İç alanlar (enrichment, ham kaynak verisi) dışarı verilmez
    expect(JSON.stringify(list.body.data)).not.toContain("enrichment");

    const invalid = await call(createLeadRoute, "/api/v1/leads", { method: "POST", body: JSON.stringify({ companyName: "x" }), key: writeKey });
    expect(invalid.status).toBe(422);
  });

  it("başka şirketin lead'i 404; geri çekilen anahtar çalışmaz; görev eklenir", async () => {
    const a = await createTenant("A");
    const b = await createTenant("B");
    const { key: bKey, id: bKeyId } = await createApiKey(b, { name: "b", scope: "write" });
    const { leadId } = await createManualLead(a, { companyName: "Gizli Lead", sourceType: "MANUAL" });

    expect((await call(getLeadRoute, `/api/v1/leads/${leadId}`, { key: bKey }, { id: leadId })).status).toBe(404);
    const task = await call(createTaskRoute, "/api/v1/tasks", { method: "POST", key: bKey, body: JSON.stringify({ title: "API görevi", priority: "HIGH" }) });
    expect(task.status).toBe(200);
    // Başka şirketin lead'ine görev bağlanamaz
    const cross = await call(createTaskRoute, "/api/v1/tasks", { method: "POST", key: bKey, body: JSON.stringify({ title: "Sızma denemesi", leadId }) });
    expect(cross.status).toBe(404);

    await revokeApiKey(b, bKeyId);
    expect((await call(listLeadsRoute, "/api/v1/leads", { key: bKey })).status).toBe(401);
    // Anahtarın kendisi veritabanında saklanmaz
    const stored = await rawDb.apiKey.findUniqueOrThrow({ where: { id: bKeyId } });
    expect(JSON.stringify(stored)).not.toContain(bKey);
  });

  it("anahtar yönetimi yalnızca yönetici", async () => {
    const m = await createTenant("M", "MEMBER");
    await expect(createApiKey(m, { name: "x", scope: "read" })).rejects.toThrow(/yetki/);
  });
});

describe("giden webhook", () => {
  let server: Server;
  let received: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
  let failNext = 0;
  let url = "";

  beforeEach(async () => {
    received = [];
    failNext = 0;
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        if (failNext > 0) {
          failNext--;
          res.writeHead(500).end();
        } else res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    return () => new Promise<void>((r) => server.close(() => r()));
  });

  it("abone olunan olay HMAC imzalı teslim edilir; abone olunmayan gönderilmez", async () => {
    const a = await createTenant("A");
    const { secret } = await createWebhook(a, { url, events: ["lead.created"] });
    await createManualLead(a, { companyName: "Yeni Firma", sourceType: "MANUAL" });
    await emitEvent(a.companyId, "reply.received", { x: 1 });
    await drainInlineJobs();

    expect(received).toHaveLength(1);
    const r = received[0]!;
    const payload = JSON.parse(r.body) as { type: string; data: { companyName: string } };
    expect(payload).toMatchObject({ type: "lead.created", data: { companyName: "Yeni Firma" } });
    expect(r.headers["x-sos-signature"]).toBe(signPayload(secret, String(r.headers["x-sos-timestamp"]), r.body));
    const ep = await rawDb.webhookEndpoint.findFirstOrThrow({ where: { companyId: a.companyId } });
    expect(ep).toMatchObject({ lastStatus: 200, failureCount: 0 });
    expect(ep.secretEncrypted).not.toContain(secret);
  });

  it("geçici hata tekrar denenir; kalıcı hatada hata kaydedilir; başka şirketin olayı gelmez", async () => {
    const a = await createTenant("A");
    const b = await createTenant("B");
    await createWebhook(a, { url, events: ["opportunity.stage_changed"] });
    failNext = 1;
    await emitEvent(a.companyId, "opportunity.stage_changed", { to: "WON" });
    await drainInlineJobs();
    expect(received).toHaveLength(2); // 500 → tekrar → 200

    failNext = 10;
    await emitEvent(a.companyId, "opportunity.stage_changed", { to: "LOST" });
    await drainInlineJobs();
    const ep = await rawDb.webhookEndpoint.findFirstOrThrow({ where: { companyId: a.companyId } });
    expect(ep).toMatchObject({ lastError: "HTTP 500", failureCount: 1, active: true });

    const before = received.length;
    await emitEvent(b.companyId, "opportunity.stage_changed", { to: "WON" });
    await drainInlineJobs();
    expect(received.length).toBe(before);
  });

  it("geçersiz adres ve olay reddedilir", async () => {
    const a = await createTenant("A");
    await expect(createWebhook(a, { url: "ftp://x", events: ["lead.created"] })).rejects.toThrow();
    await expect(createWebhook(a, { url, events: ["olmayan.olay"] })).rejects.toThrow(/olay/);
  });
});
