import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { rawDb } from "@/server/db";
import { __setAIProviderForTests } from "@/server/ai";
import { __setEmailProviderForTests, checkSenderDomain } from "@/server/providers/email";
import type { EmailProvider, OutgoingEmail } from "@/server/providers/email/types";
import { drainInlineJobs } from "@/server/jobs/queue";
import { saveDiscoveredLeads } from "@/server/services/leads";
import {
  addSuppression,
  addSuppressionByUser,
  findSuppression,
  refreshLeadCompliance,
  removeSuppression,
  reviewComplianceRecord,
} from "@/server/services/compliance";
import { saveSenderSettings } from "@/server/services/email-settings";
import {
  approveCampaign,
  approveMessages,
  approveStrategy,
  createCampaign,
  getCampaign,
  pauseCampaign,
  startMessageGeneration,
  startSending,
  startStrategyGeneration,
  updateMessage,
} from "@/server/services/campaigns";
import { buildEmailContent } from "@/server/services/campaign-send";
import { checkMessageQuality } from "@/server/services/message-quality";
import { processUnsubscribe, unsubscribeToken, verifyUnsubscribeToken } from "@/server/services/unsubscribe";
import { applyEmailEvent, parseBrevoEvents, parseResendEvents } from "@/server/services/email-events";
import { evaluateEmailCompliance } from "@/lib/compliance";
import type { TenantContext } from "@/server/tenancy/types";
import { MockAIProvider, createTenant, resetDb } from "./helpers";

// ── Birim ──────────────────────────────────────────────────────────────

describe("uyum kuralları", () => {
  const base = { contactType: "COMPANY_GENERIC" as const, basis: "B2B_TRADER_ADDRESS" as const, consent: "UNKNOWN" as const, optOut: false, suppressed: false };

  it("kurumsal genel adres gönderilebilir; engel, ret ve sistem adresi gönderilmez", () => {
    expect(evaluateEmailCompliance({ ...base, address: "info@firma.com.tr" }).status).toBe("SENDABLE");
    expect(evaluateEmailCompliance({ ...base, address: "info@firma.com.tr", suppressed: true }).status).toBe("DO_NOT_SEND");
    expect(evaluateEmailCompliance({ ...base, address: "info@firma.com.tr", optOut: true }).status).toBe("DO_NOT_SEND");
    expect(evaluateEmailCompliance({ ...base, address: "noreply@firma.com.tr" }).status).toBe("DO_NOT_SEND");
    expect(evaluateEmailCompliance({ ...base, address: "gecersiz" }).status).toBe("DO_NOT_SEND");
  });

  it("kişisel adres ve ücretsiz servis adresi insan incelemesi ister; inceleme sonrası gönderilebilir", () => {
    const personal = { ...base, contactType: "PERSONAL" as const, basis: "NONE" as const, address: "ahmet.yilmaz@firma.com.tr" };
    expect(evaluateEmailCompliance(personal).status).toBe("REVIEW_REQUIRED");
    expect(evaluateEmailCompliance({ ...base, address: "firma@gmail.com" }).status).toBe("REVIEW_REQUIRED");
    expect(evaluateEmailCompliance({ ...personal, basis: "EXISTING_RELATIONSHIP" }).status).toBe("SENDABLE");
    expect(evaluateEmailCompliance({ ...base, address: "firma@gmail.com", reviewed: true }).status).toBe("SENDABLE");
    // İnceleme bile engeli aşamaz
    expect(evaluateEmailCompliance({ ...personal, basis: "EXPLICIT_CONSENT", reviewed: true, suppressed: true }).status).toBe("DO_NOT_SEND");
  });

  it("son 3 günde iletişim kurulan adres frekans sınırına takılır", () => {
    const now = new Date("2026-09-20T10:00:00Z");
    expect(evaluateEmailCompliance({ ...base, address: "info@firma.com.tr", lastContactedAt: new Date("2026-09-19T10:00:00Z"), now }).status).toBe("REVIEW_REQUIRED");
    expect(evaluateEmailCompliance({ ...base, address: "info@firma.com.tr", lastContactedAt: new Date("2026-09-10T10:00:00Z"), now }).status).toBe("SENDABLE");
  });
});

describe("mesaj kalite kontrolü", () => {
  const corpus = JSON.stringify({ facts: [{ key: "certification", value: "ISO 9001:2015" }, { key: "delivery", value: "Standart ürünlerde 10 iş günü içinde teslim" }], products: [{ name: "Basma Yay" }] });

  it("doğrulanmamış fiyat, sertifika, yüzde ve yer tutucuyu engeller", () => {
    const r = checkMessageQuality(
      { subject: "Merhaba [Ad]", body: "Basma yaylarımız 12.500 TL'den başlar, IATF 16949 sertifikalıyız ve %30 daha dayanıklıyız. Görüşelim mi? Size uygun bir zamanda kısa bir görüşme yapabiliriz." },
      corpus,
    );
    expect(r.blocked).toBe(true);
    const codes = r.issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["placeholder", "unverified_price", "unverified_cert", "unverified_percent"]));
  });

  it("doğrulanmış bilgideki iddialara izin verir", () => {
    const r = checkMessageQuality(
      { subject: "Basma yay tedariki", body: "Merhaba, ISO 9001:2015 belgeli üretimimizle basma yay tedarik ediyoruz. Standart ürünlerde 10 iş günü içinde teslim ediyoruz. Uygunsa kataloğumuzu paylaşabilirim; ihtiyaçlarınızı kısaca konuşmak için 15 dakikalık bir görüşme de yapabiliriz." },
      corpus,
    );
    expect(r.blocked).toBe(false);
    expect(r.issues.filter((i) => i.severity === "block")).toEqual([]);
  });

  it("sahte önceki ilişki iddiasını engeller, spam ifadesini uyarır", () => {
    const r = checkMessageQuality({ subject: "ÜCRETSİZ NUMUNE!!!", body: "Daha önce görüştüğümüz gibi size yazıyorum. Kaçırmayın, stoklarımız sınırlı ve fırsatlar bu hafta geçerli olacak şekilde planlandı." }, corpus);
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["fake_relation", "spammy", "caps"]));
    expect(r.blocked).toBe(true);
  });
});

describe("e-posta alt bilgisi ve ret bağlantısı", () => {
  it("gönderici kimliği ve ret bağlantısı her iletiye eklenir; HTML kaçışı yapılır", () => {
    const sender = { fromName: "Ahmet", fromEmail: "ahmet@aktifyay.com.tr", replyTo: null, legalName: "Aktif Yay San. Ltd. Şti.", postalAddress: "Nilüfer / Bursa", phone: null, signature: null };
    const c = buildEmailContent("Merhaba <b>test</b>", sender, "https://x/u/abc");
    expect(c.text).toContain("Aktif Yay San. Ltd. Şti.");
    expect(c.text).toContain("Nilüfer / Bursa");
    expect(c.text).toContain("https://x/u/abc");
    expect(c.html).toContain("&lt;b&gt;test&lt;/b&gt;");
    expect(c.html).toContain('href="https://x/u/abc"');
  });

  it("imzalı token doğrulanır; değiştirilmiş token reddedilir", () => {
    const t = unsubscribeToken("cmpany0000001", "message000001");
    expect(verifyUnsubscribeToken(t)).toEqual({ companyId: "cmpany0000001", messageId: "message000001" });
    expect(verifyUnsubscribeToken(t.replace("message000001", "message000002"))).toBeNull();
    expect(verifyUnsubscribeToken("a.b")).toBeNull();
  });
});

describe("DNS ve webhook ayrıştırma", () => {
  it("SPF/DMARC kayıtlarını değerlendirir", async () => {
    const dns = (records: Record<string, string[][]>) => async (name: string) => {
      if (!records[name]) throw new Error("ENODATA");
      return records[name]!;
    };
    const ok = await checkSenderDomain("firma.com", dns({ "firma.com": [["v=spf1 include:_spf.resend.com ~all"]], "_dmarc.firma.com": [["v=DMARC1; p=none"]] }));
    expect(ok).toMatchObject({ spf: "pass", dmarc: "pass", dkim: "unknown" });
    const bad = await checkSenderDomain("firma.com", dns({ "firma.com": [["v=spf1 +all"]] }));
    expect(bad).toMatchObject({ spf: "fail", dmarc: "missing" });
    const none = await checkSenderDomain("firma.com", dns({ "firma.com": [["google-site-verification=x"]] }));
    expect(none.spf).toBe("missing");
  });

  it("Resend ve Brevo olaylarını ayrıştırır", () => {
    expect(parseResendEvents({ type: "email.bounced", data: { email_id: "r1", bounce: { type: "Permanent" } } })).toEqual([{ type: "bounced", providerMessageId: "r1", permanent: true }]);
    expect(parseResendEvents({ type: "email.complained", data: { email_id: "r2" } })[0]!.type).toBe("complaint");
    expect(parseBrevoEvents([{ event: "hard_bounce", "message-id": "<b1>" }, { event: "soft_bounce", "message-id": "<b2>" }])).toEqual([
      { type: "bounced", providerMessageId: "<b1>", permanent: true },
      { type: "bounced", providerMessageId: "<b2>", permanent: false },
    ]);
    expect(parseResendEvents({ nope: 1 })).toEqual([]);
  });
});

// ── Entegrasyon (gerçek Postgres) ──────────────────────────────────────

class FakeEmail implements EmailProvider {
  readonly name = "fake";
  sent: OutgoingEmail[] = [];
  constructor(private readonly failWith?: { retryable: boolean }) {}
  async send(email: OutgoingEmail) {
    if (this.failWith) {
      const err = new Error("sağlayıcı hatası") as Error & { retryable?: boolean };
      err.retryable = this.failWith.retryable;
      throw err;
    }
    this.sent.push(email);
    return { providerMessageId: `p-${email.messageId}`, accepted: true };
  }
}

const SENDER = {
  fromName: "Ahmet — Aktif Yay",
  fromEmail: "ahmet@aktifyay.com.tr",
  replyTo: null,
  legalName: "Aktif Yay San. ve Tic. Ltd. Şti.",
  postalAddress: "Nilüfer OSB, Bursa",
  phone: null,
  signature: null,
};

const strategyJson = JSON.stringify({
  valueProposition: "Pres hatlarınız için dayanıklı basma yay tedariki.",
  targetRoles: ["Satın alma müdürü"],
  painPoints: ["Tedarik sürekliliği"],
  keyMessages: ["Basma yay üretimi"],
  objections: [],
  callToAction: "Katalog paylaşalım mı?",
  tone: "Kısa ve saygılı",
  sequence: [{ dayOffset: 3, name: "İlk temas", instruction: "Kendini tanıt, katalog öner." }, { dayOffset: 7, name: "Hatırlatma", instruction: "Kısa hatırlatma." }],
  risks: ["Fiyat bilgisi doğrulanmadı; fiyat verilmeyecek."],
});

const goodMessage = JSON.stringify({
  subject: "Basma yay tedariki hakkında",
  body: "Merhaba,\n\nAktif Yay olarak pres ve kalıp üreticilerine basma yay üretiyoruz. Hatlarınızda kullandığınız yaylar için alternatif bir tedarikçi arıyorsanız kataloğumuzu paylaşmak isterim.\n\nUygun olursa kısa bir görüşme de planlayabiliriz.",
  personalization: ["Firma pres parçaları üretiyor"],
});

async function setupSeller(role: TenantContext["role"] = "OWNER") {
  const ctx = await createTenant("Aktif Yay", role);
  await rawDb.product.create({ data: { companyId: ctx.companyId, name: "Basma Yay", status: "VERIFIED", source: "USER", active: true } });
  return ctx;
}

async function addLead(companyId: string, name: string, extra: Record<string, unknown> = {}) {
  const { leadIds } = await saveDiscoveredLeads(companyId, [{ companyName: name, sourceType: "GOOGLE_MAPS", ...extra }], { provider: "fake" });
  await rawDb.lead.update({ where: { id: leadIds[0]! }, data: { fitScore: 80 } });
  return leadIds[0]!;
}

const balance = async (companyId: string) =>
  (await rawDb.company.findUniqueOrThrow({ where: { id: companyId }, select: { creditBalance: true } })).creditBalance;

/** Strateji + mesaj üretimi + onay: gönderime hazır kampanya */
async function readyCampaign(ctx: TenantContext) {
  __setAIProviderForTests(new MockAIProvider((input) => (input.system?.includes("stratejist") ? strategyJson : goodMessage)));
  const campaign = await createCampaign(ctx, { name: "Test kampanya", targetDescription: "Otomotiv yan sanayi firmalarına basma yay", productIds: [], minScore: 45 });
  await startStrategyGeneration(ctx, campaign.id);
  await drainInlineJobs();
  await approveStrategy(ctx, campaign.id);
  await startMessageGeneration(ctx, campaign.id);
  await drainInlineJobs();
  return campaign;
}

beforeEach(resetDb);
afterEach(() => {
  __setAIProviderForTests(null);
  __setEmailProviderForTests(null);
});
afterAll(async () => {
  await rawDb.$disconnect();
});

describe("engel listesi", () => {
  it("adres eklenince bekleyen mesajlar iptal olur; alıcı talebi kaldırılamaz, elle eklenen kaldırılır", async () => {
    const a = await setupSeller();
    const leadId = await addLead(a.companyId, "Firma X", { genericEmail: "info@firmax.com" });
    const msg = await rawDb.message.create({ data: { companyId: a.companyId, leadId, channel: "EMAIL", toAddress: "info@firmax.com", body: "x", status: "APPROVED" } });

    await addSuppression(a.companyId, { type: "EMAIL", value: "INFO@firmax.com", source: "UNSUBSCRIBE_LINK" });
    expect((await rawDb.message.findUniqueOrThrow({ where: { id: msg.id } })).status).toBe("CANCELLED");
    expect(await findSuppression(a.companyId, { email: "info@firmax.com" })).not.toBeNull();

    const rec = await rawDb.suppressionRecord.findFirstOrThrow({ where: { companyId: a.companyId } });
    await expect(removeSuppression(a, rec.id)).rejects.toThrow(/kaldırılamaz/);

    const manual = await addSuppressionByUser(a, { type: "DOMAIN", value: "https://www.rakip.com" });
    expect(manual.record.value).toBe("rakip.com");
    expect(await findSuppression(a.companyId, { email: "satis@rakip.com" })).not.toBeNull();
    await removeSuppression(a, manual.record.id);
    expect(await findSuppression(a.companyId, { email: "satis@rakip.com" })).toBeNull();
  });

  it("platform geneli engel tüm şirketlere uygulanır; şirket listeleri birbirinden ayrıdır", async () => {
    const a = await setupSeller();
    const b = await createTenant("B");
    await rawDb.suppressionRecord.create({ data: { companyId: null, type: "DOMAIN", value: "sikayetci.com", source: "COMPLAINT" } });
    await addSuppression(b.companyId, { type: "EMAIL", value: "info@sadeceb.com", source: "MANUAL" });

    expect(await findSuppression(a.companyId, { email: "info@sikayetci.com" })).not.toBeNull();
    expect(await findSuppression(a.companyId, { email: "info@sadeceb.com" })).toBeNull();
    expect(await findSuppression(b.companyId, { email: "info@sadeceb.com" })).not.toBeNull();
  });

  it("izleyici ve üye engel listesini değiştiremez", async () => {
    const m = await createTenant("M", "MEMBER");
    await expect(addSuppressionByUser(m, { type: "EMAIL", value: "a@b.com" })).rejects.toThrow(/yetki/);
  });
});

describe("uyum kayıtları", () => {
  it("kurumsal adresi gönderilebilir, kişisel adresi inceleme bekler; yönetici incelemesi korunur", async () => {
    const a = await setupSeller();
    const leadId = await addLead(a.companyId, "Firma Y", {
      genericEmail: "info@firmay.com",
      personalContacts: [{ fullName: "Ayşe K", email: "ayse.k@firmay.com" }],
    });
    const { records, best } = await refreshLeadCompliance(a.companyId, leadId);
    expect(best?.address).toBe("info@firmay.com");
    const personal = records.find((r) => r.address === "ayse.k@firmay.com")!;
    expect(personal.status).toBe("REVIEW_REQUIRED");

    const member = await createTenant("üye yok", "MEMBER");
    await expect(reviewComplianceRecord(member, personal.id, "B2B_TRADER_ADDRESS")).rejects.toThrow();

    const reviewed = await reviewComplianceRecord(a, personal.id, "EXISTING_RELATIONSHIP");
    expect(reviewed?.status).toBe("SENDABLE");
    // Yeniden değerlendirme insan kararını ezmez
    const again = await refreshLeadCompliance(a.companyId, leadId);
    expect(again.records.find((r) => r.id === personal.id)?.communicationBasis).toBe("EXISTING_RELATIONSHIP");
  });
});

describe("kampanya akışı", () => {
  it("strateji → onay → mesaj → mesaj onayı → kampanya onayı → gönderim; kredi ve durumlar doğru", async () => {
    const a = await setupSeller();
    const okLead = await addLead(a.companyId, "Uygun Firma", { genericEmail: "info@uygun.com" });
    await addLead(a.companyId, "E-postasız Firma");
    const before = await balance(a.companyId);

    const campaign = await readyCampaign(a);
    const c = await getCampaign(a, campaign.id);
    expect(c.leads).toHaveLength(2);
    expect(c.steps.map((s) => s.dayOffset)).toEqual([0, 7]); // ilk adım her zaman gün 0
    expect(c.strategyStatus).toBe("VERIFIED");

    const msgs = await rawDb.message.findMany({ where: { campaignId: campaign.id } });
    expect(msgs).toHaveLength(1); // e-postasız lead için mesaj üretilmez
    expect(msgs[0]).toMatchObject({ leadId: okLead, toAddress: "info@uygun.com", status: "PENDING_APPROVAL", complianceStatus: "SENDABLE" });
    // 3 (strateji) + 1 (tek mesaj)
    expect(await balance(a.companyId)).toBe(before - 4);

    // Onaylı mesaj olmadan kampanya onaylanamaz
    await expect(approveCampaign(a, campaign.id)).rejects.toThrow(/mesaj/);
    await approveMessages(a, [msgs[0]!.id]);
    await approveCampaign(a, campaign.id);

    // Gönderici ve sağlayıcı yoksa gönderim başlamaz
    await expect(startSending(a, campaign.id)).rejects.toThrow(/sağlayıcı/);
    const email = new FakeEmail();
    __setEmailProviderForTests(email);
    await expect(startSending(a, campaign.id)).rejects.toThrow(/Gönderici/);
    await saveSenderSettings(a, SENDER);

    await startSending(a, campaign.id);
    await drainInlineJobs();

    expect(email.sent).toHaveLength(1);
    const sent = email.sent[0]!;
    expect(sent.to).toBe("info@uygun.com");
    expect(sent.text).toContain(SENDER.legalName);
    expect(sent.text).toContain("/u/");
    expect(sent.unsubscribeUrl).toContain("/api/unsubscribe/");

    const after = await rawDb.message.findUniqueOrThrow({ where: { id: msgs[0]!.id } });
    expect(after).toMatchObject({ status: "SENT", provider: "fake", providerMessageId: `p-${msgs[0]!.id}` });
    expect((await rawDb.lead.findUniqueOrThrow({ where: { id: okLead } })).status).toBe("CONTACTED");
    // Stratejide 2. adım (gün 7) var: hatırlatma planlandı, kampanya tamamlanmadı, "hazır" bekliyor
    expect((await rawDb.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe("READY");
    const followUp = await rawDb.followUp.findFirstOrThrow({ where: { leadId: okLead } });
    expect(followUp).toMatchObject({ status: "SCHEDULED", campaignId: campaign.id });

    // Aynı adrese 3 gün içinde tekrar gönderilmez (frekans sınırı)
    const { best } = await refreshLeadCompliance(a.companyId, okLead);
    expect(best?.status).toBe("REVIEW_REQUIRED");
  });

  it("doğrulanmamış iddia içeren mesaj onaylanamaz; düzeltilince onaylanır", async () => {
    const a = await setupSeller();
    await addLead(a.companyId, "Firma Z", { genericEmail: "info@firmaz.com" });
    __setAIProviderForTests(
      new MockAIProvider((input) =>
        input.system?.includes("stratejist")
          ? strategyJson
          : JSON.stringify({ subject: "Fiyat avantajı", body: "Merhaba, basma yaylarımız rakiplerden %40 daha ucuz ve 5.000 TL altı siparişlerde kargo bizden. Görüşmek isterseniz haber verin, kataloğumuzu da paylaşabilirim.", personalization: [] }),
      ),
    );
    const campaign = await createCampaign(a, { name: "K", targetDescription: "Otomotiv firmaları hedef", productIds: [] });
    await startStrategyGeneration(a, campaign.id);
    await drainInlineJobs();
    await approveStrategy(a, campaign.id);
    await startMessageGeneration(a, campaign.id);
    await drainInlineJobs();

    const msg = await rawDb.message.findFirstOrThrow({ where: { campaignId: campaign.id } });
    expect((msg.qualityNotes as { blocked: boolean }).blocked).toBe(true);
    const res = await approveMessages(a, [msg.id]);
    expect(res.approved).toBe(0);
    expect(res.rejected[0]!.reason).toMatch(/Doğrulanmamış/);

    const q = await updateMessage(a, { id: msg.id, subject: "Basma yay tedariki", body: "Merhaba, pres hatlarında kullanılan basma yaylar üretiyoruz. Uygun görürseniz kataloğumuzu paylaşabilirim; kısa bir görüşme de planlayabiliriz. İyi çalışmalar dilerim." });
    expect(q.blocked).toBe(false);
    expect((await approveMessages(a, [msg.id])).approved).toBe(1);
  });

  it("onaydan sonra ret gelen adrese gönderilmez; duraklatılan kampanya gönderimi durdurur", async () => {
    const a = await setupSeller();
    await addLead(a.companyId, "Ret Eden", { genericEmail: "info@reteden.com" });
    await addLead(a.companyId, "Diğer", { genericEmail: "info@diger.com" });
    const campaign = await readyCampaign(a);
    const msgs = await rawDb.message.findMany({ where: { campaignId: campaign.id } });
    await approveMessages(a, msgs.map((m) => m.id));
    await approveCampaign(a, campaign.id);
    await saveSenderSettings(a, SENDER);

    // Ret bağlantısı onaydan SONRA kullanıldı
    const target = msgs.find((m) => m.toAddress === "info@reteden.com")!;
    const unsub = await processUnsubscribe(unsubscribeToken(a.companyId, target.id));
    expect(unsub.ok).toBe(true);

    const email = new FakeEmail();
    __setEmailProviderForTests(email);
    await startSending(a, campaign.id);
    await drainInlineJobs();
    expect(email.sent.map((e) => e.to)).toEqual(["info@diger.com"]);
    expect((await rawDb.message.findUniqueOrThrow({ where: { id: target.id } })).status).toBe("CANCELLED");

    // Planlı hatırlatmalar sürdüğü için kampanya duraklatılabilir; duraklatınca hatırlatmalar bekler
    await pauseCampaign(a, campaign.id);
    expect((await rawDb.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe("PAUSED");
    await expect(pauseCampaign(a, campaign.id)).rejects.toThrow(/aktif gönderim yok/);
  });

  it("günlük sınır aşılmaz; kalan mesajlar onaylı bekler", async () => {
    process.env.EMAIL_DAILY_LIMIT = "1";
    const { resetEnvCache } = await import("@/server/env");
    resetEnvCache();
    try {
      const a = await setupSeller();
      await addLead(a.companyId, "Bir", { genericEmail: "info@bir.com" });
      await addLead(a.companyId, "İki", { genericEmail: "info@iki.com" });
      const campaign = await readyCampaign(a);
      const msgs = await rawDb.message.findMany({ where: { campaignId: campaign.id } });
      await approveMessages(a, msgs.map((m) => m.id));
      await approveCampaign(a, campaign.id);
      await saveSenderSettings(a, SENDER);
      const email = new FakeEmail();
      __setEmailProviderForTests(email);
      await startSending(a, campaign.id);
      await drainInlineJobs();
      expect(email.sent).toHaveLength(1);
      expect(await rawDb.message.count({ where: { campaignId: campaign.id, status: "APPROVED" } })).toBe(1);
      const job = await rawDb.job.findFirstOrThrow({ where: { type: "campaign.send" } });
      expect(job.result).toMatchObject({ sent: 1, quotaReached: true, remainingApproved: 1 });
    } finally {
      delete process.env.EMAIL_DAILY_LIMIT;
      (await import("@/server/env")).resetEnvCache();
    }
  });

  it("kalıcı sağlayıcı hatası mesajı FAILED yapar, tekrar göndermez", async () => {
    const a = await setupSeller();
    await addLead(a.companyId, "Hatalı", { genericEmail: "info@hatali.com" });
    const campaign = await readyCampaign(a);
    const msgs = await rawDb.message.findMany({ where: { campaignId: campaign.id } });
    await approveMessages(a, msgs.map((m) => m.id));
    await approveCampaign(a, campaign.id);
    await saveSenderSettings(a, SENDER);
    __setEmailProviderForTests(new FakeEmail({ retryable: false }));
    await startSending(a, campaign.id);
    await drainInlineJobs();
    expect((await rawDb.message.findUniqueOrThrow({ where: { id: msgs[0]!.id } })).status).toBe("FAILED");
  });

  it("gönderim ve kampanya onayı yönetici yetkisi ister; başka şirketin kampanyasına erişilemez", async () => {
    const a = await setupSeller();
    await addLead(a.companyId, "F", { genericEmail: "info@f.com" });
    const campaign = await readyCampaign(a);
    const member: TenantContext = { ...a, role: "MEMBER" };
    await expect(approveCampaign(member, campaign.id)).rejects.toThrow(/yetki/);
    await expect(startSending(member, campaign.id)).rejects.toThrow(/yetki/);

    const b = await createTenant("B");
    await expect(getCampaign(b, campaign.id)).rejects.toThrow(/bulunamadı/);
    await expect(approveStrategy(b, campaign.id)).rejects.toThrow(/bulunamadı/);
  });

  it("uygun lead yoksa kampanya oluşturulmaz; yalnızca onaylı ürün seçilebilir", async () => {
    const a = await setupSeller();
    await expect(createCampaign(a, { name: "Boş", targetDescription: "hedef açıklaması", productIds: [] })).rejects.toThrow(/uygun lead yok/);
    const pending = await rawDb.product.create({ data: { companyId: a.companyId, name: "Onaysız", status: "PENDING", source: "WEBSITE" } });
    await addLead(a.companyId, "L", { genericEmail: "info@l.com" });
    await expect(createCampaign(a, { name: "X", targetDescription: "hedef açıklaması", productIds: [pending.id] })).rejects.toThrow(/onaylı ürün/);
  });
});

describe("ret ve sağlayıcı olayları", () => {
  it("ret bağlantısı adresi engeller, kişiyi optOut yapar; kalıcı geri dönme ve şikâyet engel listesine ekler", async () => {
    const a = await setupSeller();
    const leadId = await addLead(a.companyId, "R", { genericEmail: "info@r.com", personalContacts: [{ email: "can@r.com" }] });
    const m1 = await rawDb.message.create({ data: { companyId: a.companyId, leadId, channel: "EMAIL", toAddress: "can@r.com", body: "x", status: "SENT", providerMessageId: "prov-1" } });
    const m2 = await rawDb.message.create({ data: { companyId: a.companyId, leadId, channel: "EMAIL", toAddress: "info@r.com", body: "x", status: "SENT", providerMessageId: "prov-2" } });

    expect((await processUnsubscribe(unsubscribeToken(a.companyId, m1.id))).ok).toBe(true);
    expect((await rawDb.leadContact.findFirstOrThrow({ where: { email: "can@r.com" } })).optOut).toBe(true);
    expect((await processUnsubscribe("sahte.token.imza")).ok).toBe(false);

    expect(await applyEmailEvent({ type: "bounced", providerMessageId: "prov-2", permanent: true })).toBe(true);
    expect((await rawDb.message.findUniqueOrThrow({ where: { id: m2.id } })).status).toBe("BOUNCED");
    const recs = await rawDb.suppressionRecord.findMany({ where: { companyId: a.companyId }, orderBy: { createdAt: "asc" } });
    expect(recs.map((r) => [r.value, r.source])).toEqual([["can@r.com", "UNSUBSCRIBE_LINK"], ["info@r.com", "BOUNCE"]]);

    expect(await applyEmailEvent({ type: "delivered", providerMessageId: "bilinmeyen" })).toBe(false);
  });
});
