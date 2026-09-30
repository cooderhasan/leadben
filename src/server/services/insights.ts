import "server-only";
import type { Prisma } from "@prisma/client";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { assertCan } from "@/server/tenancy/permissions";
import type { TenantContext } from "@/server/tenancy/types";
import { ai, isAIConfigured } from "@/server/ai";
import { untrusted } from "@/server/ai/guardrails";
import { ASSISTANT_INSTRUCTIONS, REPORT_INSTRUCTIONS, REPORT_SHAPE, reportSchema } from "@/server/ai/prompts/insights";
import { consumeCredits, refundCredits } from "@/server/usage/credits";
import { audit } from "@/server/audit/audit";
import { AppError } from "@/lib/errors";
import { getAnalytics } from "./analytics";
import { getTodayAgenda, pipelineSummary } from "./crm";
import { buildVerifiedCompanyContext } from "./facts";

/** Rapor üretmek için gereken en az veri — altında AI'a yorum yazdırılmaz (sahte içgörü yok). */
export const MIN_SENT_FOR_REPORT = 10;

// ── Sayı doğrulama ─────────────────────────────────────────────────────

/** Metindeki sayıları normalize eder: "12,5" → "12.5", "1.250" → "1250" */
export function extractNumbers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\d+(?:[.,]\d+)*/g)) {
    let s = m[0];
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ""); // TR binlik
    else s = s.replace(",", ".");
    out.push(String(Number(s)));
  }
  return out;
}

/** Veri nesnesindeki tüm sayısal değerler (izin verilen sayı kümesi). */
/** Tarih / saat metni: içindeki sayılar veri sayılmaz (ör. saat 09:35 iken "%35" doğrulanmış görünmesin) */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/;

export function numbersIn(data: unknown, acc = new Set<string>()): Set<string> {
  if (typeof data === "number" && Number.isFinite(data)) acc.add(String(data));
  else if (data instanceof Date) return acc;
  else if (typeof data === "string") {
    if (!ISO_DATE.test(data.trim())) for (const n of extractNumbers(data)) acc.add(n);
  }
  else if (Array.isArray(data)) for (const d of data) numbersIn(d, acc);
  else if (data && typeof data === "object") for (const v of Object.values(data)) numbersIn(v, acc);
  return acc;
}

/**
 * Metinde geçip verilen kümede olmayan sayılar. Küçük sayılar da serbest değildir:
 * "5 fırsat kazandınız" gibi uydurma bir sayı tam olarak bu kontrolün yakalaması gereken şeydir.
 */
export function unverifiedNumbers(text: string, allowed: Set<string>): string[] {
  return [...new Set(extractNumbers(text).filter((n) => !allowed.has(n)))];
}

function pathExists(obj: unknown, path: string): boolean {
  let cur: unknown = obj;
  for (const part of path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[part];
    else return false;
  }
  return true;
}

// ── Rapor (AIInsight) ──────────────────────────────────────────────────

export async function generateReport(ctx: TenantContext, periodDays = 30) {
  assertCan(ctx, "campaign.write");
  if (!isAIConfigured()) throw new AppError("AI_UNAVAILABLE", "AI sağlayıcısı yapılandırılmamış (.env → ANTHROPIC_API_KEY).");
  const snapshot = await getAnalytics(ctx, periodDays);
  if (snapshot.funnel.emailsSent < MIN_SENT_FOR_REPORT) {
    throw new AppError(
      "VALIDATION",
      `Rapor için yeterli veri yok: son ${periodDays} günde ${snapshot.funnel.emailsSent} ileti gönderildi (en az ${MIN_SENT_FOR_REPORT} gerekli). Veri azken AI yorumu yanıltıcı olur.`,
    );
  }

  const { usageId } = await consumeCredits({ companyId: ctx.companyId, operation: "ai.deep_research", userId: ctx.userId, refType: "AIInsight" });
  try {
    const { data } = await ai({ companyId: ctx.companyId, operation: "insights.report" }).extract({
      schema: reportSchema,
      instructions: REPORT_INSTRUCTIONS,
      shape: REPORT_SHAPE,
      input: `METRİKLER (son ${periodDays} gün):\n${untrusted("metrics", JSON.stringify(snapshot), 20_000)}`,
      maxTokens: 2500,
    });

    // Her içgörü: kanıt yolları gerçek, metindeki her sayı veride olmalı — değilse atılır
    const allowed = numbersIn(snapshot);
    const accepted = data.insights.filter(
      (i) => i.evidence.every((p) => pathExists(snapshot, p)) && unverifiedNumbers(`${i.title} ${i.body}`, allowed).length === 0,
    );
    const summaryOk = unverifiedNumbers(data.summary, allowed).length === 0;
    if (accepted.length === 0 && !summaryOk) {
      throw new AppError("AI_UNAVAILABLE", "AI verilerle doğrulanabilir bir rapor üretemedi. Kredi iade edildi.");
    }

    const db = tenantDb(ctx);
    const basis = (paths: string[]) =>
      ({ periodDays, since: snapshot.since, generatedAt: new Date().toISOString(), evidence: paths, snapshot }) as unknown as Prisma.InputJsonValue;
    const created = [];
    if (summaryOk) {
      created.push(
        await db.aIInsight.create({
          data: { companyId: ctx.companyId, scope: "company", type: "report_summary", title: `Son ${periodDays} gün özeti`, body: data.summary, dataBasis: basis(["funnel", "rates"]) },
        }),
      );
    }
    for (const i of accepted) {
      created.push(
        await db.aIInsight.create({
          data: { companyId: ctx.companyId, scope: "company", type: `report_${i.type}`, title: i.title, body: i.body, dataBasis: basis(i.evidence) },
        }),
      );
    }
    await audit({
      companyId: ctx.companyId,
      userId: ctx.userId,
      actorType: "AI",
      action: "insights.report_generated",
      metadata: { accepted: accepted.length, dropped: data.insights.length - accepted.length },
    });
    return { created: created.length, dropped: data.insights.length - accepted.length };
  } catch (err) {
    await refundCredits(usageId, "insights.report.failed");
    throw err;
  }
}

export async function listInsights(ctx: TenantContext) {
  assertCan(ctx, "campaign.read");
  return tenantDb(ctx).aIInsight.findMany({
    where: { status: { not: "DISMISSED" } },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
}

export async function dismissInsight(ctx: TenantContext, id: string) {
  assertCan(ctx, "campaign.write");
  await tenantDb(ctx).aIInsight.updateMany({ where: { id }, data: { status: "DISMISSED" } });
}

// ── AI asistan ─────────────────────────────────────────────────────────

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

async function assistantData(ctx: TenantContext) {
  const db = tenantDb(ctx);
  const [analytics, agenda, pipeline, verified, topLeads, recentReplies, openTasks] = await Promise.all([
    getAnalytics(ctx, 30),
    getTodayAgenda(ctx),
    pipelineSummary(ctx),
    buildVerifiedCompanyContext(ctx),
    db.lead.findMany({
      where: { fitScore: { not: null }, suppressed: false },
      orderBy: { fitScore: "desc" },
      take: 15,
      select: { companyName: true, city: true, fitScore: true, status: true, industry: true },
    }),
    db.conversationMessage.findMany({
      where: { direction: "INBOUND" },
      orderBy: { receivedAt: "desc" },
      take: 8,
      select: { category: true, aiSummary: true, receivedAt: true, conversation: { select: { lead: { select: { companyName: true } } } } },
    }),
    db.task.findMany({ where: { status: "OPEN" }, orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }], take: 10, select: { title: true, dueAt: true, priority: true } }),
  ]);
  return {
    today: new Date().toISOString().slice(0, 10),
    company: { name: verified.name, sector: verified.sector, products: verified.products.map((p) => p.name).slice(0, 20) },
    last30Days: analytics,
    todayAgenda: agenda.map((a) => ({ item: a.text, count: a.count })),
    pipeline,
    topLeads,
    recentReplies: recentReplies.map((r) => ({
      company: r.conversation.lead.companyName,
      category: r.category,
      summary: r.aiSummary,
      date: r.receivedAt.toISOString().slice(0, 10),
    })),
    openTasks: openTasks.map((t) => ({ title: t.title, due: t.dueAt?.toISOString().slice(0, 10) ?? null, priority: t.priority })),
  };
}

/** Soru başına 1 kredi. Konuşma saklanmaz (yalnızca istemcide); audit'e yalnızca uzunluk yazılır. */
export async function askAssistant(ctx: TenantContext, question: string, history: ChatTurn[] = []) {
  assertCan(ctx, "lead.read");
  const q = question.trim();
  if (q.length < 2) throw new AppError("VALIDATION", "Bir soru yazın.", { question: "Soru gerekli" });
  if (q.length > 2000) throw new AppError("VALIDATION", "Soru en fazla 2000 karakter olabilir.", { question: "Çok uzun" });
  if (!isAIConfigured()) throw new AppError("AI_UNAVAILABLE", "AI sağlayıcısı yapılandırılmamış (.env → ANTHROPIC_API_KEY).");

  const { usageId } = await consumeCredits({ companyId: ctx.companyId, operation: "ai.message", userId: ctx.userId, refType: "assistant" });
  try {
    const data = await assistantData(ctx);
    const turns = history.slice(-6).map((t) => ({ role: t.role, content: t.content.slice(0, 3000) }));
    const res = await ai({ companyId: ctx.companyId, operation: "assistant.chat" }).generateText({
      system: `${ASSISTANT_INSTRUCTIONS}\n\nVERİLER:\n${untrusted("company-data", JSON.stringify(data), 40_000)}`,
      messages: [...turns, { role: "user", content: q }],
      maxTokens: 1000,
      tier: "default",
    });
    const answer = res.text.trim();
    // Kullanıcının kendi yazdığı sayılar (soru ve geçmiş) da cevapta geçebilir
    const allowed = numbersIn([data, q, turns.map((t) => t.content)]);
    const unknown = unverifiedNumbers(answer, allowed);
    await audit({ companyId: ctx.companyId, userId: ctx.userId, actorType: "AI", action: "assistant.asked", metadata: { questionLength: q.length, unverifiedNumbers: unknown.length } });
    return {
      answer,
      warning: unknown.length ? `Bu yanıttaki bazı sayılar (${unknown.slice(0, 5).join(", ")}) verilerinizde doğrulanamadı; kontrol edin.` : null,
    };
  } catch (err) {
    await refundCredits(usageId, "assistant.failed");
    throw err;
  }
}
