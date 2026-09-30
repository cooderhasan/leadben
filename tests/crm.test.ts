import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { rawDb } from "@/server/db";
import { saveDiscoveredLeads } from "@/server/services/leads";
import { createOpportunity, createTaskByUser, getTodayAgenda, listTasks, setTaskStatus, updateOpportunity } from "@/server/services/crm";
import { opportunityUpdateSchema } from "@/lib/validation";
import { createTenant, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await rawDb.$disconnect();
});

async function lead(companyId: string, name = "Alıcı") {
  const { leadIds } = await saveDiscoveredLeads(companyId, [{ companyName: name, genericEmail: `info@${name.toLowerCase()}.com`, sourceType: "MANUAL" }], { provider: "fake" });
  return leadIds[0]!;
}

describe("fırsatlar", () => {
  it("elle fırsat açılır; açık fırsat varken ikincisi açılmaz; başka şirketin lead'ine açılamaz", async () => {
    const a = await createTenant("A");
    const b = await createTenant("B");
    const l = await lead(a.companyId);
    const opp = await createOpportunity(a, { leadId: l });
    expect(opp.stage).toBe("QUALIFIED");
    expect((await rawDb.lead.findUniqueOrThrow({ where: { id: l } })).status).toBe("QUALIFIED_OPPORTUNITY");
    await expect(createOpportunity(a, { leadId: l })).rejects.toThrow(/zaten var/);
    await expect(createOpportunity(b, { leadId: l })).rejects.toThrow(/bulunamadı/);
    await expect(updateOpportunity(b, { id: opp.id, stage: "WON" })).rejects.toThrow(/bulunamadı/);
  });

  it("kaybedilen fırsat neden ister; kapanınca açık görevler ve planlı hatırlatmalar iptal olur", async () => {
    const a = await createTenant("A");
    const l = await lead(a.companyId);
    const opp = await createOpportunity(a, { leadId: l });
    await rawDb.task.create({ data: { companyId: a.companyId, leadId: l, opportunityId: opp.id, title: "Ara" } });
    await rawDb.followUp.create({ data: { companyId: a.companyId, leadId: l, scheduledAt: new Date(Date.now() + 86_400_000) } });

    await expect(updateOpportunity(a, { id: opp.id, stage: "LOST" })).rejects.toThrow(/neden/);
    await updateOpportunity(a, { id: opp.id, stage: "LOST", lostReason: "PRICE", lostNote: "Pahalı buldu" });
    const after = await rawDb.opportunity.findUniqueOrThrow({ where: { id: opp.id } });
    expect(after).toMatchObject({ stage: "LOST", lostReason: "PRICE" });
    expect(after.lostAt).not.toBeNull();
    expect((await rawDb.lead.findUniqueOrThrow({ where: { id: l } })).status).toBe("LOST");
    expect((await rawDb.task.findFirstOrThrow({ where: { opportunityId: opp.id } })).status).toBe("CANCELLED");
    expect((await rawDb.followUp.findFirstOrThrow({ where: { leadId: l } })).status).toBe("CANCELLED");
  });

  it("kazanılan fırsat: tutar insan girer (TR biçimi), lead WON olur", async () => {
    const a = await createTenant("A");
    const l = await lead(a.companyId);
    const opp = await createOpportunity(a, { leadId: l });
    const input = opportunityUpdateSchema.parse({ id: opp.id, stage: "WON", value: "125.000,50", probability: "100", expectedCloseAt: "2026-10-01", lostReason: "" });
    await updateOpportunity(a, input);
    const after = await rawDb.opportunity.findUniqueOrThrow({ where: { id: opp.id } });
    expect(Number(after.value)).toBe(125000.5);
    expect(after.wonAt).not.toBeNull();
    expect(after.lostReason).toBeNull();
    expect((await rawDb.lead.findUniqueOrThrow({ where: { id: l } })).status).toBe("WON");
  });
});

describe("görevler ve bugünün işleri", () => {
  it("görev eklenir ve tamamlanır; izleyici görev ekleyemez", async () => {
    const a = await createTenant("A");
    const v = await createTenant("V", "VIEWER");
    const t = await createTaskByUser(a, { title: "Numune gönder", dueAt: new Date() });
    expect((await listTasks(a)).map((x) => x.id)).toContain(t.id);
    await setTaskStatus(a, t.id, "DONE");
    expect((await listTasks(a)).length).toBe(0);
    expect((await listTasks(a, { status: "DONE" }))[0]!.completedAt).not.toBeNull();
    await expect(createTaskByUser(v, { title: "x" })).rejects.toThrow(/yetki/);
    await expect(setTaskStatus(v, t.id, "OPEN")).rejects.toThrow(/yetki/);
  });

  it("bugünün işleri yalnızca gerçek kayıtlardan sayılır; veri yoksa boştur", async () => {
    const a = await createTenant("A");
    expect(await getTodayAgenda(a)).toEqual([]);

    const l = await lead(a.companyId);
    await rawDb.lead.update({ where: { id: l }, data: { fitScore: 85 } });
    await rawDb.task.create({ data: { companyId: a.companyId, leadId: l, title: "Gecikti", dueAt: new Date(Date.now() - 3 * 86_400_000) } });
    await rawDb.message.create({ data: { companyId: a.companyId, leadId: l, channel: "EMAIL", body: "x", status: "PENDING_APPROVAL" } });
    const conv = await rawDb.conversation.create({ data: { companyId: a.companyId, leadId: l, channel: "EMAIL", lastMessageAt: new Date(), category: "INTERESTED" } });
    await rawDb.conversationMessage.create({ data: { companyId: a.companyId, conversationId: conv.id, direction: "INBOUND", body: "İlgileniyoruz" } });

    const agenda = await getTodayAgenda(a);
    const byKey = Object.fromEntries(agenda.map((x) => [x.key, x.count]));
    expect(byKey).toMatchObject({ overdue: 1, replies: 1, approve: 1, hot: 1 });
    // Sıralama: önce gecikenler ve bekleyen yanıtlar
    expect(agenda[0]!.key).toBe("overdue");

    // Başka şirketin verisi sayılmaz
    const b = await createTenant("B");
    expect(await getTodayAgenda(b)).toEqual([]);
  });
});
