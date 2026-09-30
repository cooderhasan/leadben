import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { rawDb } from "@/server/db";
import { __setAIProviderForTests } from "@/server/ai";
import { drainInlineJobs } from "@/server/jobs/queue";
import { saveDiscoveredLeads } from "@/server/services/leads";
import {
  approveProposal,
  computeTotal,
  createProposalEmail,
  getProposal,
  parseItems,
  proposalBlockers,
  sanitizeDraft,
  setProposalOutcome,
  startProposal,
  submitProposal,
  updateProposal,
} from "@/server/services/proposals";
import { proposalFormSchema } from "@/lib/validation";
import type { TenantContext } from "@/server/tenancy/types";
import { MockAIProvider, createTenant, resetDb } from "./helpers";

describe("teklif kuralları (birim)", () => {
  const products = [{ id: "p1", name: "Basma Yay" }];

  it("AI'ın ürün adı onaylı listede değilse kalem ürünsüz kalır; adet müşteride yoksa boş; fiyat her zaman boş", () => {
    const out = sanitizeDraft(
      {
        items: [
          { productName: "Basma Yay", requested: "basma yay", quantity: 5000, unit: "adet", note: null },
          { productName: "Uydurma Ürün", requested: "çekme yay", quantity: 200, unit: "adet", note: null },
        ],
        deliveryTerms: "15 iş günü",
        coverNote: "Talebiniz için teşekkürler.",
        missingInfo: [],
      },
      products,
      "Merhaba, 5000 adet basma yay ve biraz çekme yay istiyoruz.",
      JSON.stringify({ facts: [{ key: "delivery", value: "Standart ürünlerde 10 iş günü" }] }),
    );
    expect(out.items[0]).toMatchObject({ productId: "p1", name: "Basma Yay", quantity: 5000, unitPrice: null });
    expect(out.items[1]).toMatchObject({ productId: null, name: "çekme yay", quantity: null, unitPrice: null });
    expect(out.deliveryTerms).toBeNull(); // 15 doğrulanmış bilgide yok
    expect(out.missingInfo.join(" ")).toMatch(/onaylı ürün listenizde yok/);
    expect(out.missingInfo.join(" ")).toMatch(/Birim fiyatlar/);
  });

  it("toplam yalnızca tüm kalemler fiyatlı ve adetliyse hesaplanır", () => {
    const base = { productId: null, unit: "adet", note: null };
    expect(computeTotal([{ ...base, name: "A", quantity: 10, unitPrice: 2.5 }, { ...base, name: "B", quantity: 3, unitPrice: 100 }])).toBe(325);
    expect(computeTotal([{ ...base, name: "A", quantity: 10, unitPrice: null }])).toBeNull();
    expect(proposalBlockers([{ ...base, name: "A", quantity: null, unitPrice: null }], null)).toHaveLength(3);
  });

  it("form TR sayı biçimini ayrıştırır, boş satırları atar", () => {
    const v = proposalFormSchema.parse({
      id: "x",
      currency: "TRY",
      validUntil: "2026-10-30",
      item_name: ["Basma Yay", ""],
      item_qty: ["5.000", ""],
      item_unit: ["adet", ""],
      item_price: ["12,75", ""],
      item_note: ["", ""],
      item_productId: ["p1", ""],
    });
    expect(v.items).toEqual([{ productId: "p1", name: "Basma Yay", quantity: 5000, unit: "adet", unitPrice: 12.75, note: null }]);
  });
});

beforeEach(resetDb);
afterEach(() => __setAIProviderForTests(null));
afterAll(async () => {
  await rawDb.$disconnect();
});

async function setup() {
  const a = await createTenant("Aktif Yay");
  const product = await rawDb.product.create({ data: { companyId: a.companyId, name: "Basma Yay", status: "VERIFIED", source: "USER", active: true } });
  const { leadIds } = await saveDiscoveredLeads(a.companyId, [{ companyName: "Alıcı", genericEmail: "info@alici.com", sourceType: "MANUAL" }], { provider: "fake" });
  const leadId = leadIds[0]!;
  const opp = await rawDb.opportunity.create({ data: { companyId: a.companyId, leadId, title: "Alıcı", stage: "INTERESTED" } });
  const conv = await rawDb.conversation.create({ data: { companyId: a.companyId, leadId, channel: "EMAIL" } });
  await rawDb.conversationMessage.create({ data: { companyId: a.companyId, conversationId: conv.id, direction: "INBOUND", fromAddress: "info@alici.com", body: "3000 adet basma yay için fiyat verir misiniz?" } });
  return { a, product, leadId, opp };
}

const draftAI = () =>
  new MockAIProvider(() =>
    JSON.stringify({
      items: [{ productName: "Basma Yay", requested: "basma yay", quantity: 3000, unit: "adet", note: null }],
      deliveryTerms: null,
      coverNote: "Talebiniz için teklifimiz ektedir.",
      missingInfo: [],
      // AI fiyat yazmaya kalksa bile şema dışı alanlar atılır
      unitPrice: 99,
    }),
  );

describe("teklif akışı", () => {
  it("AI taslağı (5 kredi) → fiyat girilir → onaya → yönetici onayı → kabul → fırsat kazanıldı", async () => {
    const { a, product, leadId, opp } = await setup();
    __setAIProviderForTests(draftAI());
    const before = (await rawDb.company.findUniqueOrThrow({ where: { id: a.companyId } })).creditBalance;
    const { proposal } = await startProposal(a, { opportunityId: opp.id });
    await drainInlineJobs();
    expect((await rawDb.company.findUniqueOrThrow({ where: { id: a.companyId } })).creditBalance).toBe(before - 5);
    expect(proposal.number).toMatch(/^TKL-\d{4}-0001$/);

    const drafted = await getProposal(a, proposal.id);
    const items = parseItems(drafted.items);
    expect(items).toEqual([{ productId: product.id, name: "Basma Yay", quantity: 3000, unit: "adet", unitPrice: null, note: null }]);

    // Fiyatsız onaya gönderilemez
    await expect(submitProposal(a, proposal.id)).rejects.toThrow(/birim fiyat/);
    await updateProposal(a, {
      id: proposal.id,
      items: [{ ...items[0]!, unitPrice: 4.5 }],
      currency: "TRY",
      validUntil: new Date(Date.now() + 15 * 86_400_000),
      deliveryTerms: null,
      terms: "Teşekkürler",
    });
    await submitProposal(a, proposal.id);

    const member: TenantContext = { ...a, role: "MEMBER" };
    await expect(approveProposal(member, proposal.id)).rejects.toThrow(/yetki/);
    await approveProposal(a, proposal.id);
    // Onaylı teklif düzenlenemez
    await expect(updateProposal(a, { id: proposal.id, items: [], currency: "TRY", validUntil: null, deliveryTerms: null, terms: null })).rejects.toThrow(/düzenlenemez/);

    const email = await createProposalEmail(a, proposal.id);
    expect(email).toMatchObject({ status: "PENDING_APPROVAL", toAddress: "info@alici.com" });
    expect(email.body).toContain("13.500");

    await setProposalOutcome(a, proposal.id, "SENT");
    expect((await rawDb.opportunity.findUniqueOrThrow({ where: { id: opp.id } })).stage).toBe("QUOTE");
    await setProposalOutcome(a, proposal.id, "ACCEPTED");
    const won = await rawDb.opportunity.findUniqueOrThrow({ where: { id: opp.id } });
    expect(won.stage).toBe("WON");
    expect(Number(won.value)).toBe(13500);
    expect((await rawDb.lead.findUniqueOrThrow({ where: { id: leadId } })).status).toBe("WON");
  });

  it("başka şirketin ürünü kaleme eklenemez; başka şirket teklifi göremez; AI hatasında kredi iade", async () => {
    const { a, opp } = await setup();
    const b = await createTenant("B");
    const foreign = await rawDb.product.create({ data: { companyId: b.companyId, name: "B ürünü", status: "VERIFIED", source: "USER" } });
    __setAIProviderForTests(new MockAIProvider(() => new Error("down")));
    const before = (await rawDb.company.findUniqueOrThrow({ where: { id: a.companyId } })).creditBalance;
    const { proposal } = await startProposal(a, { opportunityId: opp.id });
    await drainInlineJobs();
    expect((await rawDb.company.findUniqueOrThrow({ where: { id: a.companyId } })).creditBalance).toBe(before);

    await expect(
      updateProposal(a, { id: proposal.id, items: [{ productId: foreign.id, name: "x", quantity: 1, unit: null, unitPrice: 1, note: null }], currency: "TRY", validUntil: null, deliveryTerms: null, terms: null }),
    ).rejects.toThrow(/Geçersiz ürün/);
    await expect(getProposal(b, proposal.id)).rejects.toThrow(/bulunamadı/);
    await expect(startProposal(b, { opportunityId: opp.id })).rejects.toThrow(/bulunamadı/);
  });

  it("teklif numaraları şirket içinde sıralı ve benzersizdir", async () => {
    const { a, leadId } = await setup();
    const p1 = await startProposal(a, { leadId });
    const p2 = await startProposal(a, { leadId });
    expect([p1.proposal.number.slice(-4), p2.proposal.number.slice(-4)]).toEqual(["0001", "0002"]);
  });
});
