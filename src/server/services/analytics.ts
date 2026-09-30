import "server-only";
import type { ReplyCategory } from "@prisma/client";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { assertCan } from "@/server/tenancy/permissions";
import type { TenantContext } from "@/server/tenancy/types";
import { type MailboxBucket, mailboxBucket } from "@/lib/lead-normalize";
import { POSITIVE_CATEGORIES } from "./conversations";

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

export interface AnalyticsSnapshot {
  periodDays: number;
  since: string;
  funnel: {
    leadsDiscovered: number;
    leadsScored: number;
    highScoreLeads: number;
    emailsSent: number;
    leadsContacted: number;
    delivered: number;
    bounced: number;
    replies: number;
    positiveReplies: number;
    unsubscribes: number;
    opportunitiesCreated: number;
    won: number;
    lost: number;
  };
  rates: {
    replyRatePct: number | null;
    positiveReplyRatePct: number | null;
    bounceRatePct: number | null;
    unsubscribeRatePct: number | null;
    winRatePct: number | null;
  };
  replyCategories: Array<{ category: ReplyCategory; count: number }>;
  /** Gönderilen adres tipine göre yanıt kırılımı (info@ mı, satinalma@ mı, kişiye özel mi daha iyi çalışıyor). */
  addressTypes: Array<{
    bucket: MailboxBucket;
    sent: number;
    replies: number;
    positive: number;
    bounced: number;
    replyRatePct: number | null;
  }>;
  lostReasons: Array<{ reason: string; count: number }>;
  campaigns: Array<{
    id: string;
    name: string;
    status: string;
    leads: number;
    sent: number;
    replies: number;
    positive: number;
    replyRatePct: number | null;
  }>;
  ai: { calls: number; costUsd: number; creditsUsed: number };
}

/**
 * Tüm sayılar gerçek kayıtlardan hesaplanır. Oranlar burada hesaplanır ki AI rapor yazarken
 * kendi hesabını yapmasın (uydurma sayı riski).
 */
export async function getAnalytics(ctx: TenantContext, periodDays = 30): Promise<AnalyticsSnapshot> {
  assertCan(ctx, "campaign.read");
  const db = tenantDb(ctx);
  const since = new Date(Date.now() - periodDays * 86_400_000);

  const [
    leadsDiscovered,
    leadsScored,
    highScoreLeads,
    emailsSent,
    contactedLeads,
    delivered,
    bounced,
    replies,
    categoryRows,
    unsubscribes,
    opportunitiesCreated,
    won,
    lost,
    lostRows,
    campaigns,
    aiAgg,
    creditAgg,
    sentRows,
    inboundRows,
  ] = await Promise.all([
    db.lead.count({ where: { discoveredAt: { gte: since } } }),
    db.leadScore.count({ where: { createdAt: { gte: since } } }),
    db.lead.count({ where: { discoveredAt: { gte: since }, fitScore: { gte: 70 } } }),
    db.message.count({ where: { direction: "OUTBOUND", sentAt: { gte: since } } }),
    db.message.groupBy({ by: ["leadId"], where: { direction: "OUTBOUND", sentAt: { gte: since } } }),
    db.message.count({ where: { direction: "OUTBOUND", sentAt: { gte: since }, status: "DELIVERED" } }),
    db.message.count({ where: { direction: "OUTBOUND", sentAt: { gte: since }, status: "BOUNCED" } }),
    db.conversationMessage.count({ where: { direction: "INBOUND", receivedAt: { gte: since } } }),
    db.conversationMessage.groupBy({ by: ["category"], where: { direction: "INBOUND", receivedAt: { gte: since } }, _count: { _all: true } }),
    db.suppressionRecord.count({ where: { createdAt: { gte: since }, source: { in: ["UNSUBSCRIBE_LINK", "REPLY", "COMPLAINT"] } } }),
    db.opportunity.count({ where: { createdAt: { gte: since } } }),
    db.opportunity.count({ where: { wonAt: { gte: since } } }),
    db.opportunity.count({ where: { lostAt: { gte: since } } }),
    db.opportunity.groupBy({ by: ["lostReason"], where: { lostAt: { gte: since } }, _count: { _all: true } }),
    db.campaign.findMany({
      where: { status: { not: "ARCHIVED" }, OR: [{ createdAt: { gte: since } }, { messages: { some: { sentAt: { gte: since } } } }] },
      select: { id: true, name: true, status: true, _count: { select: { leads: true } } },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    db.aIUsageLog.aggregate({ where: { createdAt: { gte: since } }, _count: true, _sum: { estimatedCostUsd: true } }),
    db.usageRecord.aggregate({ where: { createdAt: { gte: since }, credits: { lt: 0 } }, _sum: { credits: true } }),
    db.message.findMany({ where: { direction: "OUTBOUND", sentAt: { gte: since } }, select: { contactId: true, toAddress: true, status: true, conversationId: true } }),
    db.conversationMessage.findMany({ where: { direction: "INBOUND", receivedAt: { gte: since } }, select: { conversationId: true, category: true } }),
  ]);

  const replyCategories = categoryRows
    .filter((r) => r.category)
    .map((r) => ({ category: r.category!, count: r._count._all }))
    .sort((a, b) => b.count - a.count);
  const positiveReplies = replyCategories.filter((r) => POSITIVE_CATEGORIES.includes(r.category)).reduce((s, r) => s + r.count, 0);

  // Adres tipi kırılımı: yanıt, giden iletinin bağlı olduğu konuşmadan gelir (gelen ileti
  // conversations.ts'te ilgili giden iletiyle eşleştirilip conversationId yazılır).
  const repliesByConversation = new Map<string, { replies: number; positive: number }>();
  for (const r of inboundRows) {
    if (!r.conversationId) continue;
    const e = repliesByConversation.get(r.conversationId) ?? { replies: 0, positive: 0 };
    e.replies += 1;
    if (r.category && POSITIVE_CATEGORIES.includes(r.category)) e.positive += 1;
    repliesByConversation.set(r.conversationId, e);
  }
  const bucketStats = new Map<MailboxBucket, { sent: number; replies: number; positive: number; bounced: number }>();
  // Takip iletileri aynı konuşmayı paylaşır; yanıt bir kez sayılsın
  const countedConversations = new Set<string>();
  for (const m of sentRows) {
    const bucket = mailboxBucket(m.toAddress, m.contactId !== null);
    const e = bucketStats.get(bucket) ?? { sent: 0, replies: 0, positive: 0, bounced: 0 };
    e.sent += 1;
    if (m.status === "BOUNCED") e.bounced += 1;
    if (m.conversationId && !countedConversations.has(m.conversationId)) {
      const inb = repliesByConversation.get(m.conversationId);
      if (inb) {
        e.replies += inb.replies;
        e.positive += inb.positive;
        countedConversations.add(m.conversationId);
      }
    }
    bucketStats.set(bucket, e);
  }
  const addressTypes = [...bucketStats.entries()]
    .map(([bucket, s]) => ({ bucket, ...s, replyRatePct: pct(s.replies, s.sent) }))
    .sort((a, b) => b.sent - a.sent);

  const campaignStats = [];
  for (const c of campaigns) {
    const [sent, repliedLeads] = await Promise.all([
      db.message.count({ where: { campaignId: c.id, sentAt: { not: null } } }),
      db.conversationMessage.findMany({
        where: { direction: "INBOUND", conversation: { outbound: { some: { campaignId: c.id } } } },
        select: { category: true },
      }),
    ]);
    const positive = repliedLeads.filter((r) => r.category && POSITIVE_CATEGORIES.includes(r.category)).length;
    campaignStats.push({
      id: c.id,
      name: c.name,
      status: c.status,
      leads: c._count.leads,
      sent,
      replies: repliedLeads.length,
      positive,
      replyRatePct: pct(repliedLeads.length, sent),
    });
  }

  return {
    periodDays,
    since: since.toISOString(),
    funnel: {
      leadsDiscovered,
      leadsScored,
      highScoreLeads,
      emailsSent,
      leadsContacted: contactedLeads.length,
      delivered,
      bounced,
      replies,
      positiveReplies,
      unsubscribes,
      opportunitiesCreated,
      won,
      lost,
    },
    rates: {
      replyRatePct: pct(replies, emailsSent),
      positiveReplyRatePct: pct(positiveReplies, emailsSent),
      bounceRatePct: pct(bounced, emailsSent),
      unsubscribeRatePct: pct(unsubscribes, emailsSent),
      winRatePct: pct(won, won + lost),
    },
    replyCategories,
    addressTypes,
    lostReasons: lostRows.filter((r) => r.lostReason).map((r) => ({ reason: r.lostReason!, count: r._count._all })),
    campaigns: campaignStats,
    ai: {
      calls: aiAgg._count,
      costUsd: Math.round(Number(aiAgg._sum.estimatedCostUsd ?? 0) * 100) / 100,
      creditsUsed: Math.abs(creditAgg._sum.credits ?? 0),
    },
  };
}
