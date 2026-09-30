import "server-only";
import { rawDb } from "@/server/db";
import { AppError } from "@/lib/errors";

/** İşlem başına kredi maliyeti (spec §67). Tek kaynak burasıdır. */
export const CREDIT_COSTS = {
  "lead.discovery": 1,
  "website.analyze": 2,
  "lead.enrich": 2,
  "lead.score": 1,
  /** Liste sayfasından firma çıkarma (AI) — sayfa / metin parçası başına */
  "lead.list_import": 3,
  "ai.deep_research": 3,
  "ai.message": 1,
  "document.analyze": 5,
  "quotation.generate": 5,
} as const;

export type CreditOperation = keyof typeof CREDIT_COSTS;

export const OPERATION_LABELS: Record<string, string> = {
  "lead.discovery": "Lead bulma",
  "website.analyze": "Web sitesi analizi",
  "lead.enrich": "Lead zenginleştirme",
  "lead.score": "Lead puanlama",
  "lead.list_import": "Listeden içe aktarma",
  "ai.deep_research": "AI derin araştırma",
  "ai.message": "AI mesaj",
  "document.analyze": "Doküman analizi",
  "quotation.generate": "Teklif",
  "credit.grant": "Kredi yükleme",
  "credit.refund": "Kredi iadesi",
};

interface ConsumeInput {
  companyId: string;
  operation: CreditOperation;
  quantity?: number;
  userId?: string | null;
  refType?: string;
  refId?: string;
}

/**
 * Krediyi atomik olarak düşer. Bakiye yetersizse hiçbir şey yazılmaz ve INSUFFICIENT_CREDITS fırlatılır.
 * Koşullu UPDATE ile yarış durumu (iki eşzamanlı istek) engellenir.
 */
export async function consumeCredits(input: ConsumeInput): Promise<{ remaining: number; usageId: string }> {
  const quantity = input.quantity ?? 1;
  const cost = CREDIT_COSTS[input.operation] * quantity;

  return rawDb.$transaction(async (tx) => {
    const updated = await tx.company.updateMany({
      where: { id: input.companyId, creditBalance: { gte: cost } },
      data: { creditBalance: { decrement: cost } },
    });
    if (updated.count === 0) {
      throw new AppError(
        "INSUFFICIENT_CREDITS",
        `Bu işlem için ${cost} kredi gerekiyor, bakiyeniz yetersiz.`,
      );
    }
    const usage = await tx.usageRecord.create({
      data: {
        companyId: input.companyId,
        operation: input.operation,
        credits: -cost,
        quantity,
        userId: input.userId ?? null,
        refType: input.refType,
        refId: input.refId,
      },
    });
    const company = await tx.company.findUniqueOrThrow({
      where: { id: input.companyId },
      select: { creditBalance: true },
    });
    return { remaining: company.creditBalance, usageId: usage.id };
  });
}

/**
 * Başarısız işlemde krediyi iade eder (ör. AI veya kaynak hatası).
 * `amount` verilirse kısmi iade yapılır (ör. 50 lead için ayrılan kredinin yalnızca 12 lead kullanılması).
 * Her kullanım kaydı için en fazla bir iade yapılır (idempotent).
 */
export async function refundCredits(usageId: string, reason: string, amount?: number): Promise<void> {
  await rawDb.$transaction(async (tx) => {
    const usage = await tx.usageRecord.findUnique({ where: { id: usageId } });
    if (!usage || usage.credits >= 0) return;
    const already = await tx.usageRecord.findFirst({
      where: { companyId: usage.companyId, operation: "credit.refund", refId: usageId },
    });
    if (already) return;
    const refund = Math.min(-usage.credits, amount ?? -usage.credits);
    if (refund <= 0) return;
    await tx.company.update({ where: { id: usage.companyId }, data: { creditBalance: { increment: refund } } });
    await tx.usageRecord.create({
      data: {
        companyId: usage.companyId,
        operation: "credit.refund",
        credits: refund,
        refType: reason.slice(0, 100),
        refId: usageId,
      },
    });
  });
}

export async function grantCredits(companyId: string, credits: number, userId?: string | null): Promise<void> {
  await rawDb.$transaction([
    rawDb.company.update({ where: { id: companyId }, data: { creditBalance: { increment: credits } } }),
    rawDb.usageRecord.create({ data: { companyId, operation: "credit.grant", credits, userId: userId ?? null } }),
  ]);
}
