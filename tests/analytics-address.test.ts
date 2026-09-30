import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { rawDb } from "@/server/db";
import { getAnalytics } from "@/server/services/analytics";
import { mailboxBucket, normalizeCompanyName } from "@/lib/lead-normalize";
import type { TenantContext } from "@/server/tenancy/types";
import { createTenant, resetDb } from "./helpers";

describe("adres kutusu sınıflandırma", () => {
  it("kutu adına göre gruplar; kişi kaydı varsa kutu adına bakmaz", () => {
    expect(mailboxBucket("info@firma.com", false)).toBe("info");
    expect(mailboxBucket("bilgi@firma.com.tr", false)).toBe("info");
    expect(mailboxBucket("satinalma@firma.com", false)).toBe("purchasing");
    expect(mailboxBucket("satis@firma.com", false)).toBe("sales");
    expect(mailboxBucket("iletisim@firma.com", false)).toBe("contact");
    // Nokta / tire / alt çizgi ve büyük harf ayrımı sonucu değiştirmemeli
    expect(mailboxBucket("SATIN_ALMA@firma.com", false)).toBe("purchasing");
    expect(mailboxBucket("INFO@firma.com", false)).toBe("info");
    // Tanınmayan kutu uydurulmaz
    expect(mailboxBucket("murat@firma.com", false)).toBe("other");
    // Kişi kaydına gönderildiyse adres info@ bile olsa "kişiye özel"
    expect(mailboxBucket("info@firma.com", true)).toBe("person");
    expect(mailboxBucket(null, false)).toBe("other");
  });
});

beforeEach(resetDb);
afterAll(async () => {
  await rawDb.$disconnect();
});

/** Bir firmaya, verilen adrese ileti gönderir; replied ise yanıt da oluşturur. */
async function sendTo(
  ctx: TenantContext,
  opts: { address: string; personal?: boolean; replied?: boolean; positive?: boolean; bounced?: boolean; followUp?: boolean },
) {
  const name = `Firma ${opts.address}`;
  const lead = await rawDb.lead.create({
    data: {
      companyId: ctx.companyId,
      companyName: name,
      normalizedName: normalizeCompanyName(name),
      genericEmail: opts.personal ? null : opts.address,
    },
  });
  const contact = opts.personal
    ? await rawDb.leadContact.create({
        data: { companyId: ctx.companyId, leadId: lead.id, type: "PERSONAL", fullName: "Ahmet Yılmaz", email: opts.address, source: "COMPANY_WEBSITE" },
      })
    : null;
  const conv = opts.replied
    ? await rawDb.conversation.create({ data: { companyId: ctx.companyId, leadId: lead.id, channel: "EMAIL", lastMessageAt: new Date() } })
    : null;
  const message = {
    companyId: ctx.companyId,
    leadId: lead.id,
    contactId: contact?.id ?? null,
    channel: "EMAIL" as const,
    body: "x",
    toAddress: opts.address,
    status: opts.bounced ? ("BOUNCED" as const) : ("SENT" as const),
    sentAt: new Date(),
    conversationId: conv?.id ?? null,
  };
  await rawDb.message.create({ data: message });
  // Takip iletisi aynı konuşmaya bağlanır — yanıt iki kez sayılmamalı
  if (opts.followUp) await rawDb.message.create({ data: message });
  if (conv) {
    await rawDb.conversationMessage.create({
      data: {
        companyId: ctx.companyId,
        conversationId: conv.id,
        direction: "INBOUND",
        body: "y",
        category: opts.positive ? "INTERESTED" : "NOT_INTERESTED",
      },
    });
  }
  return lead;
}

describe("adres tipine göre yanıt kırılımı", () => {
  it("kutu tipine göre gönderim, yanıt ve geri dönmeyi ayırır; oranı hesaplar", async () => {
    const a = await createTenant("A");
    // info@: 4 gönderim, 1 yanıt (olumsuz), 1 geri dönen
    await sendTo(a, { address: "info@bir.com", replied: true });
    await sendTo(a, { address: "bilgi@iki.com" });
    await sendTo(a, { address: "info@uc.com" });
    await sendTo(a, { address: "info@dort.com", bounced: true });
    // satinalma@: 2 gönderim, 2 yanıt (biri olumlu)
    await sendTo(a, { address: "satinalma@bes.com", replied: true, positive: true });
    await sendTo(a, { address: "purchasing@alti.com", replied: true });
    // kişiye özel: 1 gönderim, 1 olumlu yanıt
    await sendTo(a, { address: "ahmet.yilmaz@yedi.com", personal: true, replied: true, positive: true });

    const s = await getAnalytics(a, 30);
    const by = Object.fromEntries(s.addressTypes.map((r) => [r.bucket, r]));

    expect(by.info).toMatchObject({ sent: 4, replies: 1, positive: 0, bounced: 1, replyRatePct: 25 });
    expect(by.purchasing).toMatchObject({ sent: 2, replies: 2, positive: 1, bounced: 0, replyRatePct: 100 });
    expect(by.person).toMatchObject({ sent: 1, replies: 1, positive: 1, replyRatePct: 100 });
    // En çok gönderilen üstte
    expect(s.addressTypes[0]!.bucket).toBe("info");
    // Toplamlar huni ile tutarlı
    expect(s.addressTypes.reduce((t, r) => t + r.sent, 0)).toBe(s.funnel.emailsSent);
    expect(s.addressTypes.reduce((t, r) => t + r.replies, 0)).toBe(s.funnel.replies);
  });

  it("aynı konuşmadaki takip iletisi yanıtı iki kez saymaz", async () => {
    const a = await createTenant("A");
    await sendTo(a, { address: "info@bir.com", replied: true, followUp: true });
    const s = await getAnalytics(a, 30);
    expect(s.addressTypes).toEqual([{ bucket: "info", sent: 2, replies: 1, positive: 0, bounced: 0, replyRatePct: 50 }]);
  });

  it("başka şirketin iletileri kırılıma karışmaz", async () => {
    const a = await createTenant("A");
    const b = await createTenant("B");
    await sendTo(a, { address: "info@bir.com", replied: true });
    await sendTo(b, { address: "satinalma@iki.com", replied: true });
    const s = await getAnalytics(a, 30);
    expect(s.addressTypes.map((r) => r.bucket)).toEqual(["info"]);
    expect(s.addressTypes[0]!.sent).toBe(1);
  });
});
