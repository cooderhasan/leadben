import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { rawDb } from "@/server/db";
import { __setEmailProviderForTests } from "@/server/providers/email";
import { describeSmtpError } from "@/server/providers/email/providers";
import type { EmailProvider, OutgoingEmail } from "@/server/providers/email/types";
import { saveSenderSettings } from "@/server/services/email-settings";
import { sendTestEmail } from "@/server/services/campaign-send";
import { createTenant, resetDb } from "./helpers";

class FakeEmail implements EmailProvider {
  readonly name = "fake";
  sent: OutgoingEmail[] = [];
  fail: Error | null = null;
  async send(email: OutgoingEmail) {
    if (this.fail) throw this.fail;
    this.sent.push(email);
    return { providerMessageId: `p-${email.messageId}`, accepted: true };
  }
}

const SENDER = { fromName: "Ahmet", fromEmail: "satis@aktifyay.net", replyTo: null, legalName: "Aktif Yay Ltd. Şti.", postalAddress: "Nilüfer OSB, Bursa", phone: null, signature: null };

let email: FakeEmail;
beforeEach(async () => {
  await resetDb();
  email = new FakeEmail();
  __setEmailProviderForTests(email);
});
afterEach(() => __setEmailProviderForTests(null));
afterAll(async () => {
  await rawDb.$disconnect();
});

describe("SMTP hata açıklamaları", () => {
  it("yaygın hataları düzeltilebilir Türkçe mesaja çevirir", () => {
    expect(describeSmtpError({ code: "EAUTH" }, { port: 587, secure: false })).toMatch(/uygulama şifresi/);
    expect(describeSmtpError({ code: "ESOCKET" }, { port: 587, secure: true })).toMatch(/SMTP_SECURE=false/);
    expect(describeSmtpError({ code: "ESOCKET" }, { port: 465, secure: false })).toMatch(/SMTP_SECURE=true/);
    expect(describeSmtpError({ code: "ETIMEDOUT" }, { port: 587, secure: false })).toMatch(/bağlanılamadı/);
    expect(describeSmtpError({ responseCode: 550, message: "relay denied" }, { port: 587, secure: false })).toMatch(/550/);
  });
});

describe("test e-postası", () => {
  it("gönderici kimliği ve alt bilgiyle gider; müşteri iletisi olarak kaydedilmez, kredi harcamaz", async () => {
    const a = await createTenant("A");
    await saveSenderSettings(a, SENDER);
    const credits = (await rawDb.company.findUniqueOrThrow({ where: { id: a.companyId } })).creditBalance;

    const res = await sendTestEmail(a, "  Ben@Aktifyay.net ");
    expect(res.to).toBe("ben@aktifyay.net");
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]).toMatchObject({ to: "ben@aktifyay.net", from: { email: "satis@aktifyay.net", name: "Ahmet" } });
    expect(email.sent[0]!.text).toContain("Aktif Yay Ltd. Şti.");
    expect(email.sent[0]!.text).toContain("Nilüfer OSB, Bursa");
    expect(await rawDb.message.count({ where: { companyId: a.companyId } })).toBe(0);
    expect((await rawDb.company.findUniqueOrThrow({ where: { id: a.companyId } })).creditBalance).toBe(credits);
  });

  it("gönderici kimliği yoksa, adres geçersizse veya sağlayıcı hata verirse anlaşılır hata döner", async () => {
    const a = await createTenant("A");
    await expect(sendTestEmail(a, "ben@aktifyay.net")).rejects.toThrow(/gönderici kimliğini/);
    await saveSenderSettings(a, SENDER);
    await expect(sendTestEmail(a, "gecersiz")).rejects.toThrow(/Geçerli bir e-posta/);
    email.fail = new Error("SMTP girişi reddedildi");
    await expect(sendTestEmail(a, "ben@aktifyay.net")).rejects.toThrow(/SMTP girişi reddedildi/);
  });

  it("saatte en fazla 5 test; yalnızca yönetici gönderebilir", async () => {
    const a = await createTenant("A");
    await saveSenderSettings(a, SENDER);
    for (let i = 0; i < 5; i++) await sendTestEmail(a, "ben@aktifyay.net");
    await expect(sendTestEmail(a, "ben@aktifyay.net")).rejects.toThrow(/Saatte en fazla 5/);

    const member = await createTenant("M", "MEMBER");
    await expect(sendTestEmail(member, "ben@aktifyay.net")).rejects.toThrow();
  });
});
