import "server-only";
import { Prisma } from "@prisma/client";
import { rawDb } from "@/server/db";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "./types";

/**
 * companyId alanı taşıyan modeller. Bu modellere tenantDb üzerinden yapılan her sorguya
 * `companyId = ctx.companyId` otomatik eklenir.
 *
 * Yeni bir tenant modeli eklendiğinde buraya da eklenmelidir — `tests/tenant-models.test.ts`
 * Prisma DMMF'i tarar ve eksik model varsa başarısız olur.
 */
export const TENANT_MODELS = new Set<Prisma.ModelName>([
  "CompanyMember",
  "CompanyProfile",
  "CompanyFact",
  "CompanyMemory",
  "TargetMarket",
  "ProductCategory",
  "Product",
  "ProductDocument",
  "KnowledgeDocument",
  "KnowledgeChunk",
  "WebsiteAnalysis",
  "Lead",
  "LeadList",
  "LeadListItem",
  "LeadContact",
  "LeadSource",
  "LeadSignal",
  "LeadScore",
  "Campaign",
  "CampaignLead",
  "CampaignStep",
  "Message",
  "Conversation",
  "ConversationMessage",
  "Opportunity",
  "Task",
  "CallLog",
  "FollowUp",
  "Proposal",
  "Competitor",
  "CompetitorSignal",
  "AIInsight",
  "ComplianceRecord",
  "SuppressionRecord",
  "UsageRecord",
  "AIUsageLog",
  "AuditLog",
  "Subscription",
  "Integration",
  "Job",
  "ApiKey",
  "WebhookEndpoint",
]);

/** Tenant bağlamında hiç erişilmemesi gereken modeller (kimlik tabloları). */
const FORBIDDEN_MODELS = new Set<Prisma.ModelName>(["User", "Session", "Account"]);

/** Global, salt-okunur paylaşılan veriler. */
const READ_ONLY_GLOBAL_MODELS = new Set<Prisma.ModelName>(["Industry"]);

const READ_OPS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);

type AnyArgs = Record<string, unknown> & {
  where?: Record<string, unknown>;
  data?: unknown;
  create?: Record<string, unknown>;
  update?: Record<string, unknown>;
};

function scopeData(model: string, data: unknown, companyId: string): unknown {
  if (Array.isArray(data)) return data.map((d) => scopeData(model, d, companyId));
  if (!data || typeof data !== "object") return data;
  const record = data as Record<string, unknown>;
  if ("company" in record) {
    throw new AppError("TENANT_VIOLATION", `${model}: 'company' ilişkisi tenantDb üzerinden bağlanamaz.`);
  }
  if (record.companyId !== undefined && record.companyId !== companyId) {
    throw new AppError("TENANT_VIOLATION", `${model}: başka bir şirkete veri yazılamaz.`);
  }
  return { ...record, companyId };
}

function assertNoCompanyChange(model: string, data: unknown, companyId: string) {
  if (!data || typeof data !== "object") return;
  const record = data as Record<string, unknown>;
  if ("company" in record) {
    throw new AppError("TENANT_VIOLATION", `${model}: şirket ilişkisi değiştirilemez.`);
  }
  if (record.companyId !== undefined && record.companyId !== companyId) {
    throw new AppError("TENANT_VIOLATION", `${model}: companyId değiştirilemez.`);
  }
}

/**
 * Tenant-scoped Prisma istemcisi.
 *
 * - Okuma/güncelleme/silme: `where`'e companyId eklenir (findUnique dahil — Prisma extendedWhereUnique).
 * - Oluşturma: `data.companyId` ctx.companyId olarak zorlanır; farklı değer → hata.
 * - `Company` modeli yalnızca kendi kaydına erişebilir, oluşturma/silme yapılamaz.
 * - User/Session/Account modellerine erişim engellidir.
 *
 * Not: Nested create/connect ile başka tabloya referans verilen ID'lerin (ör. categoryId) aynı
 * şirkete ait olduğu servis katmanında `assertOwned` ile doğrulanmalıdır.
 */
export function tenantDb(ctx: Pick<TenantContext, "companyId">) {
  const companyId = ctx.companyId;
  if (!companyId) throw new AppError("TENANT_VIOLATION", "Şirket bağlamı olmadan veri erişimi yapılamaz.");

  return rawDb.$extends({
    name: "tenant-scope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const m = model as Prisma.ModelName;
          const a = (args ?? {}) as AnyArgs;
          // Argümanlar dinamik olarak genişletildiği için gevşek tipte çağrılır
          const run = query as unknown as (args: unknown) => Promise<unknown>;

          if (FORBIDDEN_MODELS.has(m)) {
            throw new AppError("TENANT_VIOLATION", `${m} modeline tenant bağlamında erişilemez.`);
          }

          if (READ_ONLY_GLOBAL_MODELS.has(m)) {
            if (!READ_OPS.has(operation)) {
              throw new AppError("TENANT_VIOLATION", `${m} global bir tablodur, değiştirilemez.`);
            }
            return run(a);
          }

          if (m === "Company") {
            if (!READ_OPS.has(operation) && operation !== "update") {
              throw new AppError("TENANT_VIOLATION", `Company üzerinde '${operation}' yapılamaz.`);
            }
            if (operation === "update") {
              const data = (a.data ?? {}) as Record<string, unknown>;
              // Kredi bakiyesi yalnızca usage/credits.ts (atomik) üzerinden değişir
              for (const k of ["id", "creditBalance", "slug"]) {
                if (k in data) throw new AppError("TENANT_VIOLATION", `Company.${k} tenant bağlamında değiştirilemez.`);
              }
            }
            return run({ ...a, where: { ...(a.where ?? {}), id: companyId } });
          }

          if (!TENANT_MODELS.has(m)) {
            throw new AppError("TENANT_VIOLATION", `${m} modeli tenant listesinde tanımlı değil.`);
          }

          switch (operation) {
            case "create":
              return run({ ...a, data: scopeData(m, a.data, companyId) });
            case "createMany":
            case "createManyAndReturn":
              return run({ ...a, data: scopeData(m, a.data, companyId) });
            case "upsert":
              assertNoCompanyChange(m, a.update, companyId);
              return run({
                ...a,
                where: { ...(a.where ?? {}), companyId },
                create: scopeData(m, a.create, companyId) as Record<string, unknown>,
              });
            case "update":
            case "updateMany":
            case "updateManyAndReturn":
              assertNoCompanyChange(m, a.data, companyId);
              return run({ ...a, where: { ...(a.where ?? {}), companyId } });
            default:
              // find*, count, aggregate, groupBy, delete, deleteMany
              return run({ ...a, where: { ...(a.where ?? {}), companyId } });
          }
        },
      },
    },
  });
}

export type TenantDb = ReturnType<typeof tenantDb>;
