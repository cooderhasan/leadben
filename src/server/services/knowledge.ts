import "server-only";
import type { DocumentKind } from "@prisma/client";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { assertCan } from "@/server/tenancy/permissions";
import type { TenantContext } from "@/server/tenancy/types";
import { audit } from "@/server/audit/audit";
import { consumeCredits, refundCredits } from "@/server/usage/credits";
import { enqueue } from "@/server/jobs/queue";
import { newStorageKey, storage } from "@/server/providers/storage";
import { detectMimeType, looksLikePdf, MAX_UPLOAD_BYTES } from "@/server/knowledge/extract-text";
import { searchKnowledge } from "@/server/knowledge/search";
import { AppError } from "@/lib/errors";
import { isAIConfigured } from "@/server/ai";

export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  CATALOG: "Katalog",
  PRODUCT_LIST: "Ürün listesi",
  PRICE_LIST: "Fiyat listesi",
  TECHNICAL: "Teknik doküman",
  CERTIFICATE: "Sertifika",
  FAQ: "SSS",
  SALES_RULES: "Satış kuralları",
  CASE_STUDY: "Başarı hikayesi",
  OTHER: "Diğer",
};

export async function listDocuments(ctx: TenantContext) {
  assertCan(ctx, "knowledge.read");
  return tenantDb(ctx).knowledgeDocument.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { chunks: true, products: true } } },
  });
}

export async function uploadDocument(
  ctx: TenantContext,
  file: { name: string; size: number; bytes: Buffer },
  meta: { title?: string; kind: DocumentKind },
) {
  assertCan(ctx, "knowledge.write");
  if (file.size === 0) throw new AppError("VALIDATION", "Dosya boş.");
  if (file.size > MAX_UPLOAD_BYTES) throw new AppError("VALIDATION", "Dosya en fazla 20 MB olabilir.");
  const mimeType = detectMimeType(file.name);
  if (!mimeType) throw new AppError("VALIDATION", "Desteklenen dosya türleri: PDF, TXT, MD, CSV.");
  if (mimeType === "application/pdf" && !looksLikePdf(file.bytes)) throw new AppError("VALIDATION", "Dosya geçerli bir PDF değil.");

  // AI yoksa doküman yalnızca arama için indekslenir (ürün çıkarımı yapılmaz) ve kredi düşülmez
  const usageId = isAIConfigured()
    ? (await consumeCredits({ companyId: ctx.companyId, operation: "document.analyze", userId: ctx.userId, refType: "KnowledgeDocument" })).usageId
    : undefined;

  const key = newStorageKey(ctx.companyId, "documents", file.name);
  try {
    await storage().put(key, file.bytes, mimeType);
  } catch (err) {
    if (usageId) await refundCredits(usageId, "storage.failed");
    console.error("[knowledge] depolama hatası", err);
    throw new AppError("VALIDATION", "Dosya kaydedilemedi. Lütfen tekrar deneyin.");
  }

  const db = tenantDb(ctx);
  const doc = await db.knowledgeDocument.create({
    data: {
      companyId: ctx.companyId,
      title: (meta.title?.trim() || file.name).slice(0, 200),
      kind: meta.kind,
      origin: "UPLOAD",
      storageKey: key,
      mimeType,
      sizeBytes: file.size,
      uploadedById: ctx.userId,
    },
  });
  const jobId = await enqueue("document.ingest", { documentId: doc.id, usageId }, { companyId: ctx.companyId, createdById: ctx.userId });
  await db.knowledgeDocument.update({ where: { id: doc.id }, data: { jobId } });
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "knowledge.document.uploaded", entityType: "KnowledgeDocument", entityId: doc.id, metadata: { kind: meta.kind, size: file.size } });
  return doc;
}

/** Şirket, dokümanın satış iletişiminde kaynak olarak kullanılmasını onaylar. */
export async function setDocumentVerified(ctx: TenantContext, id: string, verified: boolean) {
  assertCan(ctx, "knowledge.write");
  const res = await tenantDb(ctx).knowledgeDocument.updateMany({ where: { id, status: "READY" }, data: { verified } });
  if (res.count === 0) throw new AppError("NOT_FOUND", "Doküman bulunamadı veya henüz işlenmedi.");
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: verified ? "knowledge.document.verified" : "knowledge.document.unverified", entityType: "KnowledgeDocument", entityId: id });
}

export async function deleteDocument(ctx: TenantContext, id: string) {
  assertCan(ctx, "knowledge.write");
  const db = tenantDb(ctx);
  const doc = await db.knowledgeDocument.findUnique({ where: { id } });
  if (!doc) throw new AppError("NOT_FOUND", "Doküman bulunamadı.");
  // Dokümandan çıkarılmış ama henüz onaylanmamış ürün/fact'ler de silinir
  await db.product.deleteMany({ where: { source: "DOCUMENT", sourceRef: id, status: "PENDING" } });
  await db.companyFact.deleteMany({ where: { source: "DOCUMENT", sourceRef: id, status: "PENDING" } });
  await db.knowledgeDocument.delete({ where: { id } });
  if (doc.storageKey) await storage().delete(doc.storageKey).catch((e) => console.warn("[knowledge] dosya silinemedi", e));
  await audit({ companyId: ctx.companyId, userId: ctx.userId, action: "knowledge.document.deleted", entityType: "KnowledgeDocument", entityId: id });
}

export async function search(ctx: TenantContext, q: string, onlyVerified = false) {
  assertCan(ctx, "knowledge.read");
  return searchKnowledge(ctx, q, { limit: 10, onlyVerified });
}
