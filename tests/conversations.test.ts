import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { rawDb } from "@/server/db";
import { __setAIProviderForTests } from "@/server/ai";
import { __setEmailProviderForTests } from "@/server/providers/email";
import type { EmailProvider, OutgoingEmail } from "@/server/providers/email/types";
import { drainInlineJobs } from "@/server/jobs/queue";
import { runSchedulerTick } from "@/server/jobs/scheduler";
import { saveDiscoveredLeads } from "@/server/services/leads";
import { saveSenderSettings } from "@/server/services/email-settings";
import { findSuppression } from "@/server/services/compliance";
import {
  approveCampaign,
  approveMessages,
  approveStrategy,
  createCampaign,
  startMessageGeneration,
  startSending,
  startStrategyGeneration,
} from "@/server/services/campaigns";
import { addManualReply, draftReply, looksLikeUnsubscribe, recordInboundReply, sendReply, stripQuotedReply } from "@/server/services/conversations";
import { ingestInbound, parseInboundPayload } from "@/server/services/inbound-email";
import { processDueFollowUps } from "@/server/services/followups";
import type { TenantContext } from "@/server/tenancy/types";
import { MockAIProvider, createTenant, resetDb } from "./helpers";

// ── Birim ──────────────────────────────────────────────────────────────

describe("yanıt metni yardımcıları", () => {
  it("açık ret ifadelerini AI olmadan yakalar", () => {
    expect(looksLikeUnsubscribe("Lütfen beni listeden çıkarın.")).toBe(true);
    expect(looksLikeUnsubscribe("Bir daha mail atmayın")).toBe(true);
    expect(looksLikeUnsubscribe("Please remove me from your list")).toBe(true);
    expect(looksLikeUnsubscribe("Kataloğunuzu gönderebilir misiniz?")).toBe(false);
  });

  it("alıntılanan önceki yazışmayı atar", () => {
    const body = "Fiyat alabilir miyiz?\n\n20 Eyl 2026 tarihinde Ahmet yazdı:\n> Merhaba, basma yay...\n> Görüşelim";
    expect(stripQuotedReply(body)).toBe("Fiyat alabilir miyiz?");
    expect(stripQuotedReply("Sadece metin")).toBe("Sadece metin");
  });

  it("Brevo inbound ve genel JSON biçimlerini ayrıştırır", () => {
    const brevo = parseInboundPayload({
      items: [{ From: { Address: "info@alici.com" }, To: [{ Address: "ahmet@aktifyay.com.tr" }], Subject: "Re: Basma yay", RawTextBody: "İlgileniyoruz", InReplyTo: "<abc123@aktifyay.com.tr>" }],
    });
    expect(brevo[0]).toMatchObject({ from: "info@alici.com", to: ["ahmet@aktifyay.com.tr"], references: ["<abc123@aktifyay.com.tr>"] });
    const generic = parseInboundPayload({ from: "Ali <ali@x.com>", to: "satis@y.com", subject: "S", text: "Merhaba", references: "<a> <b>" });
    expect(generic[0]).toMatchObject({ from: "ali@x.com", to: ["satis@y.com"], references: ["<a>", "<b>"] });
    expect(parseInboundPayload({ items: [{ From: { Address: "a@b.com" } }] })).toEqual([]);
  });
});

// ── Entegrasyon ────────────────────────────────────────────────────────

class FakeEmail implements EmailProvider {
  readonly name = "fake";
  sent: OutgoingEmail[] = [];
  async send(email: OutgoingEmail) {
    this.sent.push(email);
    return { providerMessageId: `p-${email.messageId}`, accepted: true };
  }
}

const SENDER = { fromName: "Ahmet", fromEmail: "ahmet@aktifyay.com.tr", replyTo: null, legalName: "Aktif Yay Ltd. Şti.", postalAddress: "Nilüfer OSB, Bursa", phone: null, signature: null };

const strategyJson = JSON.stringify({
  valueProposition: "Basma yay tedariki.",
  targetRoles: ["Satın alma"],
  keyMessages: ["Basma yay üretimi"],
  callToAction: "Katalog paylaşalım mı?",
  tone: "Kısa",
  sequence: [
    { dayOffset: 0, name: "İlk temas", instruction: "Tanıt" },
    { dayOffset: 4, name: "Hatırlatma", instruction: "Kısa hatırlat" },
  ],
});
const firstMsg = JSON.stringify({ subject: "Basma yay tedariki", body: "Merhaba,\n\nPres ve kalıp üreticilerine basma yay üretiyoruz. Uygun görürseniz kataloğumuzu paylaşmak isterim; kısa bir görüşme de planlayabiliriz.", personalization: [] });
const followMsg = JSON.stringify({ subject: "Re: Basma yay tedariki", body: "Merhaba, geçen hafta basma yay tedariki hakkında yazmıştım. Kataloğumuzu paylaşmamı ister misiniz? İyi çalışmalar.", personalization: [] });

function mockAI(classification?: Record<string, unknown>) {
  return new MockAIProvider((input) => {
    const sys = input.system ?? "";
    if (sys.includes("stratejist")) return strategyJson;
    if (sys.includes("sınıflandır")) return JSON.stringify(classification ?? { category: "INTERESTED", confidence: 0.9, summary: "İlgileniyor, katalog istiyor.", request: "Katalog", followUpInDays: null });
    if (sys.includes("HATIRLATMA")) return followMsg;
    if (sys.includes("cevap taslağı")) return JSON.stringify({ subject: "Re: Basma yay", body: "Merhaba, ilginiz için teşekkürler. Kataloğumuzu ekte paylaşıyorum; teknik ihtiyaçlarınızı yazarsanız ekibimiz size dönecek.", unanswered: ["Fiyat"] });
    return firstMsg;
  });
}

async function sentCampaign(ctx: TenantContext, email = "info@alici.com") {
  await rawDb.product.create({ data: { companyId: ctx.companyId, name: "Basma Yay", status: "VERIFIED", source: "USER", active: true } });
  const { leadIds } = await saveDiscoveredLeads(ctx.companyId, [{ companyName: "Alıcı Firma", genericEmail: email, website: "alici.com", sourceType: "GOOGLE_MAPS" }], { provider: "fake" });
  const leadId = leadIds[0]!;
  await rawDb.lead.update({ where: { id: leadId }, data: { fitScore: 80 } });
  const campaign = await createCampaign(ctx, { name: "K", targetDescription: "Otomotiv firmaları", productIds: [] });
  await startStrategyGeneration(ctx, campaign.id);
  await drainInlineJobs();
  await approveStrategy(ctx, campaign.id);
  await startMessageGeneration(ctx, campaign.id);
  await drainInlineJobs();
  const msgs = await rawDb.message.findMany({ where: { campaignId: campaign.id } });
  await approveMessages(ctx, msgs.map((m) => m.id));
  await approveCampaign(ctx, campaign.id);
  await saveSenderSettings(ctx, SENDER);
  await startSending(ctx, campaign.id);
  await drainInlineJobs();
  const sent = await rawDb.message.findFirstOrThrow({ where: { campaignId: campaign.id, status: "SENT" } });
  return { leadId, campaignId: campaign.id, sent };
}

let email: FakeEmail;
beforeEach(async () => {
  await resetDb();
  email = new FakeEmail();
  __setEmailProviderForTests(email);
});
afterEach(() => {
  __setAIProviderForTests(null);
  __setEmailProviderForTests(null);
});
afterAll(async () => {
  await rawDb.$disconnect();
});

describe("hatırlatma motoru", () => {
  it("ilk ileti gidince sonraki adım planlanır; vakti gelince taslak üretilir, yanıt yoksa", async () => {
    const a = await createTenant("Aktif Yay");
    __setAIProviderForTests(mockAI());
    const { leadId, campaignId, sent } = await sentCampaign(a);

    const f = await rawDb.followUp.findFirstOrThrow({ where: { leadId } });
    expect(f.status).toBe("SCHEDULED");
    expect(Math.round((f.scheduledAt.getTime() - sent.sentAt!.getTime()) / 86_400_000)).toBe(4);
    // Planlı hatırlatma varken kampanya "tamamlandı" sayılmaz
    expect((await rawDb.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("READY");

    // Vakti gelmemiş: hiçbir şey yapılmaz
    expect(await processDueFollowUps(a.companyId, new Date())).toMatchObject({ drafted: 0 });
    // 5 gün sonra: taslak (1 kredi)
    const later = new Date(Date.now() + 5 * 86_400_000);
    const res = await processDueFollowUps(a.companyId, later);
    expect(res.drafted).toBe(1);
    const draft = await rawDb.message.findFirstOrThrow({ where: { campaignId, status: "PENDING_APPROVAL" } });
    expect(draft).toMatchObject({ toAddress: "info@alici.com", subject: "Re: Basma yay tedariki" });
    expect((await rawDb.followUp.findUniqueOrThrow({ where: { id: f.id } })).status).toBe("SENT");
  });

  it("yanıt gelince planlı hatırlatma iptal olur; zamanlayıcı yalnızca vakti gelen şirketi kuyruğa alır", async () => {
    const a = await createTenant("Aktif Yay");
    __setAIProviderForTests(mockAI());
    const { leadId } = await sentCampaign(a);

    // Zamanlayıcı: vakti gelmemiş → kuyruk boş
    expect((await runSchedulerTick(new Date())).enqueued).toBe(0);
    expect((await runSchedulerTick(new Date(Date.now() + 5 * 86_400_000))).enqueued).toBe(1);
    await drainInlineJobs();
    // 30 dk içinde ikinci tur aynı şirketi tekrar kuyruğa almaz
    expect((await runSchedulerTick(new Date(Date.now() + 5 * 86_400_000))).enqueued).toBe(0);

    await rawDb.followUp.updateMany({ where: { leadId }, data: { status: "SCHEDULED" } });
    await recordInboundReply(a.companyId, { fromAddress: "info@alici.com", body: "Teşekkürler, inceleyeceğiz." }, { source: "webhook" });
    const f = await rawDb.followUp.findFirstOrThrow({ where: { leadId } });
    expect(f).toMatchObject({ status: "CANCELLED", skipReason: "Yanıt geldi." });
  });
});

describe("gelen yanıtlar", () => {
  it("yanıt ilgili iletiyle eşleşir, AI sınıflandırır; ilgi → fırsat + görev + lead durumu", async () => {
    const a = await createTenant("Aktif Yay");
    __setAIProviderForTests(mockAI());
    const { leadId, sent } = await sentCampaign(a);

    const res = await recordInboundReply(
      a.companyId,
      { fromAddress: "info@alici.com", subject: "Re: Basma yay", body: "Merhaba, kataloğunuzu gönderir misiniz?\n\n> eski metin", references: [`<${sent.id}@aktifyay.com.tr>`] },
      { source: "webhook" },
    );
    expect(res.matched).toBe(true);
    await drainInlineJobs();

    const cm = await rawDb.conversationMessage.findFirstOrThrow({ where: { companyId: a.companyId } });
    expect(cm).toMatchObject({ category: "INTERESTED", direction: "INBOUND" });
    expect((await rawDb.message.findUniqueOrThrow({ where: { id: sent.id } })).conversationId).toBe(cm.conversationId);
    expect((await rawDb.lead.findUniqueOrThrow({ where: { id: leadId } })).status).toBe("INTERESTED");
    const opp = await rawDb.opportunity.findFirstOrThrow({ where: { leadId } });
    expect(opp.stage).toBe("INTERESTED");
    const task = await rawDb.task.findFirstOrThrow({ where: { leadId } });
    expect(task).toMatchObject({ createdByAI: true, status: "OPEN", priority: "HIGH", opportunityId: opp.id });
  });

  it("açık ret ifadesi AI olmadan engel listesine ekler; düşük güven yalnızca inceleme görevi açar", async () => {
    const a = await createTenant("Aktif Yay");
    __setAIProviderForTests(mockAI());
    const { leadId } = await sentCampaign(a);

    await recordInboundReply(a.companyId, { fromAddress: "info@alici.com", body: "Lütfen beni listeden çıkarın." }, { source: "webhook" });
    expect(await findSuppression(a.companyId, { email: "info@alici.com" })).toMatchObject({ source: "REPLY" });

    const b = await createTenant("B");
    __setAIProviderForTests(mockAI({ category: "REQUEST_FOR_QUOTE", confidence: 0.4, summary: "Belirsiz", request: null, followUpInDays: null }));
    const second = await sentCampaign(b, "satis@diger.com");
    await recordInboundReply(b.companyId, { fromAddress: "satis@diger.com", body: "Hmm belki bakarız" }, { source: "webhook" });
    await drainInlineJobs();
    expect((await rawDb.lead.findUniqueOrThrow({ where: { id: second.leadId } })).status).toBe("REPLIED");
    expect(await rawDb.opportunity.count({ where: { leadId: second.leadId } })).toBe(0);
    expect((await rawDb.task.findFirstOrThrow({ where: { leadId: second.leadId } })).title).toMatch(/AI emin değil/);
    expect(leadId).not.toBe(second.leadId);
  });

  it("webhook yanıtı doğru şirkete eşler; belirsiz/eşleşmeyen yanıt hiçbir şirkete yazılmaz", async () => {
    const a = await createTenant("Aktif Yay");
    __setAIProviderForTests(mockAI());
    const { sent } = await sentCampaign(a);
    const other = await createTenant("Başka");

    const res = await ingestInbound(
      parseInboundPayload({ items: [{ From: { Address: "info@alici.com" }, To: [{ Address: "ahmet@aktifyay.com.tr" }], RawTextBody: "İlgileniyoruz", InReplyTo: `<${sent.id}@aktifyay.com.tr>` }] }),
    );
    expect(res).toEqual({ recorded: 1, unmatched: 0, duplicates: 0 });
    expect(await rawDb.conversationMessage.count({ where: { companyId: a.companyId } })).toBe(1);

    const none = await ingestInbound(parseInboundPayload({ from: "x@y.com", to: "kimse@yok.com", text: "Merhaba" }));
    expect(none).toEqual({ recorded: 0, unmatched: 1, duplicates: 0 });
    expect(await rawDb.conversationMessage.count({ where: { companyId: other.companyId } })).toBe(0);
    await drainInlineJobs(); // kuyruğa alınan sınıflandırma bu testte bitsin (sonraki teste sızmasın)
  });

  it("elle yanıt: başka şirketin lead'ine eklenemez", async () => {
    const a = await createTenant("A");
    const b = await createTenant("B");
    const { leadIds } = await saveDiscoveredLeads(b.companyId, [{ companyName: "B lead", sourceType: "MANUAL" }], { provider: "fake" });
    await expect(addManualReply(a, { leadId: leadIds[0]!, fromAddress: "x@y.com", body: "merhaba" })).rejects.toThrow(/bulunamadı/);
  });
});

describe("yanıt taslağı ve gönderimi", () => {
  it("AI taslak (1 kredi) → onay → gönderim; frekans sınırı yanıtı engellemez, ret engeller", async () => {
    const a = await createTenant("Aktif Yay");
    __setAIProviderForTests(mockAI());
    await sentCampaign(a);
    const r = await recordInboundReply(a.companyId, { fromAddress: "info@alici.com", body: "Katalog rica ederiz." }, { source: "webhook" });
    await drainInlineJobs();
    if (!r.matched) throw new Error("eşleşmedi");

    const credits = (await rawDb.company.findUniqueOrThrow({ where: { id: a.companyId } })).creditBalance;
    const draft = await draftReply(a, r.conversationId);
    expect((await rawDb.company.findUniqueOrThrow({ where: { id: a.companyId } })).creditBalance).toBe(credits - 1);
    const notes = draft.qualityNotes as { issues: Array<{ code: string }> };
    expect(notes.issues.some((i) => i.code === "unanswered")).toBe(true);
    await expect(draftReply(a, r.conversationId)).rejects.toThrow(/zaten var/);

    await expect(sendReply(a, draft.id)).rejects.toThrow(/onaylayın/);
    await approveMessages(a, [draft.id]);
    const before = email.sent.length;
    await sendReply(a, draft.id);
    await drainInlineJobs();
    // İlk ileti 3 günden yeni olduğu halde yanıt gönderildi (alıcı kendisi yazdı)
    expect(email.sent.length).toBe(before + 1);
    expect((await rawDb.message.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("SENT");

    // Ret sonrası yeni taslak yazılamaz
    await recordInboundReply(a.companyId, { fromAddress: "info@alici.com", body: "Bir daha mail atmayın." }, { source: "webhook" });
    await expect(draftReply(a, r.conversationId)).rejects.toThrow(/ret/);
  });

  it("yanıt gönderimi yönetici yetkisi ister", async () => {
    const a = await createTenant("Aktif Yay");
    const member: TenantContext = { ...a, role: "MEMBER" };
    await expect(sendReply(member, "x")).rejects.toThrow(/yetki/);
  });
});
