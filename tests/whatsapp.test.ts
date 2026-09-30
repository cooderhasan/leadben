import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { rawDb } from "@/server/db";
import { drainInlineJobs } from "@/server/jobs/queue";
import { __setWhatsAppProviderForTests, type WhatsAppProvider } from "@/server/providers/whatsapp";
import { decryptSecret, encryptSecret } from "@/server/security/secrets";
import {
  getWhatsAppSettings,
  processWhatsAppWebhook,
  replyWhatsApp,
  saveWhatsAppSettings,
  sendWhatsAppTemplate,
  verifyWebhookSignature,
  verifyWebhookSubscription,
} from "@/server/services/whatsapp";
import type { TenantContext } from "@/server/tenancy/types";
import { createTenant, resetDb } from "./helpers";

class FakeWA implements WhatsAppProvider {
  static sent: Array<{ to: string; body?: string; template?: string; params?: string[] }> = [];
  static failPhone = false;
  async getPhoneInfo() {
    if (FakeWA.failPhone) throw new Error("Invalid OAuth access token");
    return { displayPhone: "+90 224 000 00 00", verifiedName: "Aktif Yay" };
  }
  async sendText(to: string, body: string) {
    FakeWA.sent.push({ to, body });
    return { id: `wamid.${FakeWA.sent.length}` };
  }
  async sendTemplate(to: string, template: string, _lang: string, params: string[]) {
    FakeWA.sent.push({ to, template, params });
    return { id: `wamid.${FakeWA.sent.length}` };
  }
  async listTemplates() {
    return [{ name: "tanisma", language: "tr", status: "APPROVED", category: "MARKETING", bodyText: "Merhaba {{1}}, {{2}} hakkında bilgi vermek isteriz.", bodyParams: 2 }];
  }
}

const APP_SECRET = "test-app-secret-123";
const sign = (raw: string) => `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;
const inbound = (from: string, text: string, id = `wamid.in.${Math.random()}`, name = "Mehmet") => ({
  entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name } }], messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }],
});

beforeEach(async () => {
  await resetDb();
  FakeWA.sent = [];
  FakeWA.failPhone = false;
  __setWhatsAppProviderForTests(() => new FakeWA());
});
afterEach(() => __setWhatsAppProviderForTests(null));
afterAll(async () => {
  await rawDb.$disconnect();
});

async function connect(ctx: TenantContext) {
  return saveWhatsAppSettings(ctx, { phoneNumberId: "1234567890", wabaId: "9876543210", accessToken: "EAAG-secret-token-xyz", appSecret: APP_SECRET });
}

describe("gizli anahtarlar", () => {
  it("şifreler/çözer; değiştirilmiş veri çözülmez; kayıtta düz metin yok", async () => {
    const enc = encryptSecret("çok gizli");
    expect(decryptSecret(enc)).toBe("çok gizli");
    expect(enc).not.toContain("gizli");
    expect(() => decryptSecret(enc.slice(0, -2) + "AA")).toThrow(/çözülemedi/);

    const a = await createTenant("A");
    await connect(a);
    const row = await rawDb.integration.findFirstOrThrow({ where: { companyId: a.companyId, type: "WHATSAPP_BUSINESS" } });
    expect(row.secretsEncrypted).not.toContain("EAAG-secret");
    expect(JSON.stringify(row.config)).not.toContain("EAAG-secret");
    expect((await getWhatsAppSettings(a))?.tokenMask).toBe("EAAG…-xyz");
  });

  it("bağlantı doğrulanamazsa hata; yalnızca yönetici ayarlayabilir", async () => {
    const a = await createTenant("A");
    FakeWA.failPhone = true;
    await expect(connect(a)).rejects.toThrow(/doğrulanamadı/);
    expect((await rawDb.integration.findFirstOrThrow({ where: { companyId: a.companyId } })).status).toBe("ERROR");
    await expect(saveWhatsAppSettings({ ...a, role: "MEMBER" }, { phoneNumberId: "1", wabaId: "2" })).rejects.toThrow(/yetki/);
  });
});

describe("webhook", () => {
  it("abonelik doğrulaması ve imza kontrolü; yanlış imza/anahtar reddedilir", async () => {
    const a = await createTenant("A");
    const rec = await connect(a);
    const s = await getWhatsAppSettings(a);
    expect(await verifyWebhookSubscription(rec.id, "subscribe", s!.verifyToken, "c123")).toBe("c123");
    expect(await verifyWebhookSubscription(rec.id, "subscribe", "yanlis", "c123")).toBeNull();

    const raw = JSON.stringify(inbound("905321112233", "Merhaba"));
    expect(await verifyWebhookSignature(rec.id, raw, sign(raw))).toBe(a.companyId);
    expect(await verifyWebhookSignature(rec.id, raw, sign(raw + "x"))).toBeNull();
    expect(await verifyWebhookSignature("olmayanentegrasyon1", raw, sign(raw))).toBeNull();
  });

  it("bilinmeyen numaradan gelen mesaj 'gelen talep' lead'i açar; aynı mesaj iki kez gelirse tekrar kaydedilmez", async () => {
    const a = await createTenant("A");
    await connect(a);
    const body = inbound("905321112233", "Yay fiyatı alabilir miyim?", "wamid.X1");
    expect(await processWhatsAppWebhook(a.companyId, body)).toEqual({ received: 1 });
    expect(await processWhatsAppWebhook(a.companyId, body)).toEqual({ received: 0 });
    const lead = await rawDb.lead.findFirstOrThrow({ where: { companyId: a.companyId } });
    expect(lead).toMatchObject({ companyName: "Mehmet", normalizedPhone: "+905321112233", status: "REPLIED" });
    const contact = await rawDb.leadContact.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(contact.communicationBasis).toBe("INBOUND_REQUEST");
    const conv = await rawDb.conversation.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(conv.channel).toBe("WHATSAPP");
  });

  it("DUR yazan numara engellenir; sonra ne yanıt ne şablon gönderilebilir", async () => {
    const a = await createTenant("A");
    await connect(a);
    await processWhatsAppWebhook(a.companyId, inbound("905321112233", "Merhaba"));
    await processWhatsAppWebhook(a.companyId, inbound("905321112233", "DUR"));
    expect(await rawDb.suppressionRecord.findFirst({ where: { companyId: a.companyId, type: "PHONE", value: "+905321112233" } })).not.toBeNull();
    const conv = await rawDb.conversation.findFirstOrThrow({ where: { companyId: a.companyId } });
    await expect(replyWhatsApp(a, conv.id, "Tamam")).rejects.toThrow(/engel listesinde/);
    const contact = await rawDb.leadContact.findFirstOrThrow({ where: { companyId: a.companyId } });
    expect(contact.optOut).toBe(true);
    await expect(sendWhatsAppTemplate(a, { contactId: contact.id, templateName: "tanisma", language: "tr", params: ["a", "b"] })).rejects.toThrow();
    expect(FakeWA.sent).toEqual([]);
  });
});

describe("gönderim kuralları", () => {
  it("24 saat içinde serbest yanıt gönderilir; pencere kapanınca reddedilir; teslim durumu işlenir", async () => {
    const a = await createTenant("A");
    await connect(a);
    await processWhatsAppWebhook(a.companyId, inbound("905321112233", "Katalog var mı?"));
    const conv = await rawDb.conversation.findFirstOrThrow({ where: { companyId: a.companyId } });

    const { messageId } = await replyWhatsApp(a, conv.id, "Merhaba, katalog linkimizi iletiyorum.");
    await drainInlineJobs();
    expect(FakeWA.sent).toEqual([{ to: "+905321112233", body: "Merhaba, katalog linkimizi iletiyorum." }]);
    const sent = await rawDb.message.findUniqueOrThrow({ where: { id: messageId } });
    expect(sent).toMatchObject({ status: "SENT", channel: "WHATSAPP", providerMessageId: "wamid.1" });

    await processWhatsAppWebhook(a.companyId, { entry: [{ changes: [{ value: { statuses: [{ id: "wamid.1", status: "read" }] } }] }] });
    expect((await rawDb.message.findUniqueOrThrow({ where: { id: messageId } })).status).toBe("DELIVERED");

    // Pencere kapandı
    await rawDb.conversationMessage.updateMany({ where: { conversationId: conv.id }, data: { receivedAt: new Date(Date.now() - 25 * 3600_000) } });
    await expect(replyWhatsApp(a, conv.id, "Selam")).rejects.toThrow(/24 saatlik/);
  });

  it("şablon yalnızca izni/dayanağı olan kişiye ve doğru parametre sayısıyla; yetki yönetici", async () => {
    const a = await createTenant("A");
    await connect(a);
    const lead = await rawDb.lead.create({ data: { companyId: a.companyId, companyName: "Soğuk Lead", normalizedName: "soguk-lead" } });
    const cold = await rawDb.leadContact.create({ data: { companyId: a.companyId, leadId: lead.id, phone: "+905301234567", source: "GOOGLE_MAPS" } });
    await expect(sendWhatsAppTemplate(a, { contactId: cold.id, templateName: "tanisma", language: "tr", params: ["Ali", "yay"] })).rejects.toThrow(/izin/);

    await rawDb.leadContact.update({ where: { id: cold.id }, data: { communicationBasis: "EXISTING_RELATIONSHIP" } });
    await expect(sendWhatsAppTemplate(a, { contactId: cold.id, templateName: "tanisma", language: "tr", params: ["Ali"] })).rejects.toThrow(/2 parametre/);
    await expect(sendWhatsAppTemplate({ ...a, role: "MEMBER" }, { contactId: cold.id, templateName: "tanisma", language: "tr", params: ["Ali", "yay"] })).rejects.toThrow(/yetki/);

    await sendWhatsAppTemplate(a, { contactId: cold.id, templateName: "tanisma", language: "tr", params: ["Ali", "basma yay"] });
    await drainInlineJobs();
    expect(FakeWA.sent).toEqual([{ to: "+905301234567", template: "tanisma", params: ["Ali", "basma yay"] }]);
    const msg = await rawDb.message.findFirstOrThrow({ where: { companyId: a.companyId, channel: "WHATSAPP" } });
    expect(msg.body).toBe("Merhaba Ali, basma yay hakkında bilgi vermek isteriz.");
  });

  it("başka şirketin konuşmasına yanıt verilemez", async () => {
    const a = await createTenant("A");
    const b = await createTenant("B");
    await connect(a);
    await processWhatsAppWebhook(a.companyId, inbound("905321112233", "Merhaba"));
    const conv = await rawDb.conversation.findFirstOrThrow({ where: { companyId: a.companyId } });
    await expect(replyWhatsApp(b, conv.id, "x")).rejects.toThrow(/bulunamadı/);
  });
});
