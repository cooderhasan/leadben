import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { rawDb } from "@/server/db";
import { __setAIProviderForTests } from "@/server/ai";
import { drainInlineJobs } from "@/server/jobs/queue";
import { pollMailbox } from "@/server/jobs/imap-poll";
import type { FetchedEmail, MailboxCursorState, MailboxReader } from "@/server/providers/email/imap";
import { classifyRawEmail, detectBounce, isAutoReply } from "@/server/services/inbound-email";
import { saveDiscoveredLeads } from "@/server/services/leads";
import { findSuppression } from "@/server/services/compliance";
import type { TenantContext } from "@/server/tenancy/types";
import { MockAIProvider, createTenant, resetDb } from "./helpers";

function rawMail(o: { from: string; to?: string; subject?: string; body: string; messageId: string; inReplyTo?: string; headers?: string[] }) {
  return [
    `From: ${o.from}`,
    `To: ${o.to ?? "satis@aktifyay.net"}`,
    `Subject: ${o.subject ?? "Re: Basma yay tedariki"}`,
    `Message-ID: <${o.messageId}>`,
    ...(o.inReplyTo ? [`In-Reply-To: <${o.inReplyTo}>`, `References: <${o.inReplyTo}>`] : []),
    ...(o.headers ?? []),
    "Date: Mon, 21 Sep 2026 09:00:00 +0300",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    o.body,
  ].join("\r\n");
}

function bounceMail(originalMessageId: string, status: string) {
  const b = "BOUNDARY42";
  return [
    "From: Mail Delivery Subsystem <MAILER-DAEMON@mx.aktifyay.net>",
    "To: satis@aktifyay.net",
    "Subject: Undelivered Mail Returned to Sender",
    "Message-ID: <dsn-1@mx.aktifyay.net>",
    `Content-Type: multipart/report; report-type=delivery-status; boundary="${b}"`,
    "MIME-Version: 1.0",
    "",
    `--${b}`,
    "Content-Type: text/plain",
    "",
    "Mesaj teslim edilemedi.",
    `--${b}`,
    "Content-Type: message/delivery-status",
    "",
    "Final-Recipient: rfc822; yok@alici.com",
    "Action: failed",
    `Status: ${status}`,
    `--${b}`,
    "Content-Type: text/rfc822-headers",
    "",
    "From: satis@aktifyay.net",
    `Message-ID: <${originalMessageId}>`,
    `--${b}--`,
    "",
  ].join("\r\n");
}

class FakeReader implements MailboxReader {
  readonly key = "imap:test@example/INBOX";
  calls: Array<MailboxCursorState | null> = [];
  constructor(
    public mails: FetchedEmail[],
    public uidValidity = 1n,
  ) {}
  async read(cursor: MailboxCursorState | null, { max }: { max: number; firstRunDays: number }) {
    this.calls.push(cursor);
    const fresh = !cursor || cursor.uidValidity !== this.uidValidity;
    const messages = this.mails.filter((m) => fresh || m.uid > cursor.lastUid).slice(0, max);
    const uidNext = Math.max(0, ...this.mails.map((m) => m.uid)) + 1;
    return { uidValidity: this.uidValidity, uidNext, messages };
  }
}

const mail = (uid: number, raw: string): FetchedEmail => ({ uid, source: Buffer.from(raw) });

async function sentMessage(ctx: TenantContext, to = "info@alici.com") {
  const { leadIds } = await saveDiscoveredLeads(ctx.companyId, [{ companyName: "Alıcı", genericEmail: to, sourceType: "MANUAL" }], { provider: "fake" });
  const msg = await rawDb.message.create({
    data: { companyId: ctx.companyId, leadId: leadIds[0]!, channel: "EMAIL", body: "Merhaba", status: "SENT", sentAt: new Date(), toAddress: to },
  });
  const providerMessageId = `<${msg.id}@aktifyay.net>`;
  await rawDb.message.update({ where: { id: msg.id }, data: { providerMessageId } });
  return { leadId: leadIds[0]!, msg: { ...msg, providerMessageId } };
}

const classification = (category = "INTERESTED") =>
  new MockAIProvider(() => JSON.stringify({ category, confidence: 0.9, summary: "Katalog istiyor.", request: null, followUpInDays: null }));

beforeEach(resetDb);
afterEach(() => __setAIProviderForTests(null));
afterAll(async () => {
  await rawDb.$disconnect();
});

// ── Birim ──────────────────────────────────────────────────────────────

describe("otomatik yanıt ve geri dönme tespiti", () => {
  it("izin / ofis dışı yanıtlarını gerçek yanıttan ayırır", () => {
    expect(isAutoReply(new Map([["auto-submitted", "auto-replied"]]), "Re: Teklif")).toBe(true);
    expect(isAutoReply(new Map([["auto-submitted", "no"]]), "Re: Teklif")).toBe(false);
    expect(isAutoReply(new Map([["precedence", "bulk"]]), "Bülten")).toBe(true);
    expect(isAutoReply(new Map(), "Otomatik yanıt: izindeyim")).toBe(true);
    expect(isAutoReply(new Map(), "Out of Office: back Monday")).toBe(true);
    expect(isAutoReply(new Map(), "Re: Basma yay tedariki")).toBe(false);
  });

  it("DSN'den orijinal ileti kimliğini ve kalıcılığı çıkarır; normal postayı bounce saymaz", () => {
    const raw = bounceMail("abc@aktifyay.net", "5.1.1");
    expect(detectBounce({ from: "mailer-daemon@mx.aktifyay.net", contentType: "multipart/report; report-type=delivery-status", raw, ownMessageId: "dsn-1@mx.aktifyay.net" })).toEqual({
      ids: ["abc@aktifyay.net"],
      permanent: true,
    });
    const soft = detectBounce({ from: "mailer-daemon@x", contentType: "multipart/report; report-type=delivery-status", raw: bounceMail("abc@x", "4.2.2"), ownMessageId: "dsn-1@mx.aktifyay.net" });
    expect(soft?.permanent).toBe(false);
    expect(detectBounce({ from: "ali@alici.com", contentType: "text/plain", raw: "Message-ID: <a@b>\r\n\r\nMerhaba", ownMessageId: "a@b" })).toBeNull();
  });

  it("ham yanıtı ayrıştırır; yalnızca HTML gövdesi metne çevrilir", async () => {
    const c = await classifyRawEmail(rawMail({ from: "Ali <ali@alici.com>", body: "Katalog gönderir misiniz?", messageId: "r1@alici.com", inReplyTo: "m1@aktifyay.net" }));
    expect(c).toMatchObject({ kind: "reply", item: { from: "ali@alici.com", to: ["satis@aktifyay.net"], references: ["<m1@aktifyay.net>", "<m1@aktifyay.net>"], messageId: "<r1@alici.com>" } });

    const html = [
      "From: ali@alici.com",
      "To: satis@aktifyay.net",
      "Subject: Re: yay",
      "Message-ID: <h1@alici.com>",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<html><head><style>p{}</style></head><body><p>Fiyat alabilir miyiz?</p><script>x()</script></body></html>",
    ].join("\r\n");
    const h = await classifyRawEmail(html);
    expect(h.kind).toBe("reply");
    if (h.kind === "reply") {
      expect(h.item.text).toContain("Fiyat alabilir miyiz?");
      expect(h.item.text).not.toContain("x()");
    }
  });
});

// ── Uçtan uca (sahte posta kutusu) ─────────────────────────────────────

describe("IMAP posta kutusu okuma", () => {
  it("yanıtı doğru lead'e kaydeder; ilgisiz posta ve otomatik yanıt kaydedilmez; imleç ilerler", async () => {
    const a = await createTenant("Aktif Yay");
    const other = await createTenant("Başka");
    __setAIProviderForTests(classification());
    const { leadId, msg } = await sentMessage(a);

    const reader = new FakeReader([
      mail(10, rawMail({ from: "info@alici.com", body: "Kataloğunuzu gönderir misiniz?", messageId: "r1@alici.com", inReplyTo: `${msg.id}@aktifyay.net` })),
      mail(11, rawMail({ from: "fatura@banka.com", subject: "Ekstreniz", body: "Hesap özetiniz ektedir.", messageId: "b1@banka.com" })),
      mail(12, rawMail({ from: "info@alici.com", subject: "Otomatik yanıt: izindeyim", body: "25 Eylül'e kadar izindeyim.", messageId: "oo1@alici.com", inReplyTo: `${msg.id}@aktifyay.net`, headers: ["Auto-Submitted: auto-replied"] })),
    ]);
    const res = await pollMailbox(reader);
    await drainInlineJobs();
    expect(res).toMatchObject({ skipped: false, fetched: 3, counts: { recorded: 1, unmatched: 1, auto_reply: 1 } });

    const cms = await rawDb.conversationMessage.findMany({ where: { companyId: a.companyId } });
    expect(cms).toHaveLength(1);
    expect(cms[0]).toMatchObject({ externalId: "r1@alici.com", category: "INTERESTED", direction: "INBOUND" });
    expect((await rawDb.lead.findUniqueOrThrow({ where: { id: leadId } })).status).not.toBe("NEW");
    expect(await rawDb.opportunity.count({ where: { leadId } })).toBe(1);
    // İlgisiz posta hiçbir şirkete yazılmaz
    expect(await rawDb.conversationMessage.count({ where: { companyId: other.companyId } })).toBe(0);
    expect(await rawDb.mailboxCursor.findUniqueOrThrow({ where: { id: reader.key } })).toMatchObject({ lastUid: 12, lastError: null });

    // İkinci tur: yalnızca yeni iletiler okunur; aynı Message-ID tekrar kaydedilmez
    reader.mails.push(mail(13, rawMail({ from: "info@alici.com", body: "Kataloğunuzu gönderir misiniz?", messageId: "r1@alici.com", inReplyTo: `${msg.id}@aktifyay.net` })));
    const res2 = await pollMailbox(reader);
    await drainInlineJobs();
    expect(reader.calls[1]).toEqual({ uidValidity: 1n, lastUid: 12 });
    expect(res2).toMatchObject({ fetched: 1, counts: { duplicate: 1 } });
    expect(await rawDb.conversationMessage.count({ where: { companyId: a.companyId } })).toBe(1);
  });

  it("kalıcı geri dönme adresi engel listesine ekler ve iletiyi BOUNCED yapar; yanıt sayılmaz", async () => {
    const a = await createTenant("Aktif Yay");
    const { msg } = await sentMessage(a, "yok@alici.com");
    const res = await pollMailbox(new FakeReader([mail(5, bounceMail(`${msg.id}@aktifyay.net`, "5.1.1"))]));
    expect(res).toMatchObject({ counts: { bounce: 1 } });
    expect((await rawDb.message.findUniqueOrThrow({ where: { id: msg.id } })).status).toBe("BOUNCED");
    expect(await findSuppression(a.companyId, { email: "yok@alici.com" })).not.toBeNull();
    expect(await rawDb.conversationMessage.count({ where: { companyId: a.companyId } })).toBe(0);
  });

  it("boş posta kutusunda imleç sona konur; okuma hatası imleci bozmaz", async () => {
    const reader = new FakeReader([]);
    reader.read = async (cursor) => {
      reader.calls.push(cursor);
      return { uidValidity: 7n, uidNext: 501, messages: [] };
    };
    await pollMailbox(reader);
    expect(await rawDb.mailboxCursor.findUniqueOrThrow({ where: { id: reader.key } })).toMatchObject({ uidValidity: 7n, lastUid: 500 });

    reader.read = async () => {
      throw new Error("AUTHENTICATIONFAILED");
    };
    expect(await pollMailbox(reader)).toEqual({ skipped: true, reason: "read_failed" });
    expect(await rawDb.mailboxCursor.findUniqueOrThrow({ where: { id: reader.key } })).toMatchObject({ lastUid: 500, lastError: "AUTHENTICATIONFAILED" });
  });
});
