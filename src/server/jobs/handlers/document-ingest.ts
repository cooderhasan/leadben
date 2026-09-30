import "server-only";
import type { Prisma } from "@prisma/client";
import { rawDb } from "@/server/db";
import { ai, isAIConfigured } from "@/server/ai";
import { untrusted } from "@/server/ai/guardrails";
import {
  DOCUMENT_EXTRACTION_INSTRUCTIONS,
  DOCUMENT_EXTRACTION_SHAPE,
  documentExtractionSchema,
  type DocumentExtraction,
} from "@/server/ai/prompts/document-extraction";
import { storage } from "@/server/providers/storage";
import { chunkText } from "@/server/knowledge/chunker";
import { extractText } from "@/server/knowledge/extract-text";
import { storeEmbeddings } from "@/server/knowledge/search";
import { evidenceFound, valueFound } from "@/server/services/evidence";
import { refundCredits } from "@/server/usage/credits";
import { audit } from "@/server/audit/audit";
import { PermanentJobError, type JobHandler, type JobPayloads } from "../types";

const EMBED_BATCH = 64;
const EXTRACTION_KINDS = new Set(["CATALOG", "PRODUCT_LIST", "PRICE_LIST", "TECHNICAL", "CERTIFICATE", "OTHER"]);

export const ingestDocumentJob: JobHandler<"document.ingest"> = async ({ documentId }, h) => {
  const doc = await rawDb.knowledgeDocument.findUnique({ where: { id: documentId } });
  if (!doc) throw new PermanentJobError("Doküman bulunamadı.");
  if (doc.status === "READY") return { skipped: true };
  const companyId = doc.companyId;

  await rawDb.knowledgeDocument.update({ where: { id: documentId }, data: { status: "PROCESSING", error: null } });

  // 1) Metin
  let text: string;
  let pageCount: number | null = null;
  if (doc.storageKey && doc.mimeType) {
    const buf = await storage().get(doc.storageKey);
    try {
      ({ text, pageCount } = await extractText(buf, doc.mimeType));
    } catch (err) {
      throw new PermanentJobError(`Dosya okunamadı: ${(err as Error).message}`);
    }
  } else {
    throw new PermanentJobError("Doküman dosyası yok.");
  }
  const meaningful = text.replace(/\[Sayfa \d+\]/g, "").replace(/\s+/g, "");
  if (meaningful.length < 50) {
    throw new PermanentJobError(
      "Dokümandan metin çıkarılamadı. Taranmış (görüntü) PDF olabilir; OCR desteği sonraki fazda eklenecek.",
    );
  }
  await h.progress(20);

  // 2) Parçalama (yeniden denemelerde önce eski parçaları temizle)
  const chunks = chunkText(text);
  await rawDb.knowledgeChunk.deleteMany({ where: { documentId, companyId } });
  await rawDb.knowledgeChunk.createMany({
    data: chunks.map((c) => ({ companyId, documentId, index: c.index, content: c.content, tokenCount: c.tokenCount })),
  });
  await h.progress(40);

  // 3) Embedding (yapılandırılmışsa; başarısızlık tam metin aramasını engellemez)
  const service = ai({ companyId, operation: "document.ingest" });
  const saved = await rawDb.knowledgeChunk.findMany({ where: { documentId, companyId }, orderBy: { index: "asc" }, select: { id: true, content: true } });
  for (let i = 0; i < saved.length; i += EMBED_BATCH) {
    const batch = saved.slice(i, i + EMBED_BATCH);
    const emb = await service.embed(batch.map((c) => c.content));
    if (!emb) break;
    await storeEmbeddings(
      companyId,
      batch.map((c, j) => ({ chunkId: c.id, vector: emb.vectors[j] ?? [] })).filter((r) => r.vector.length > 0),
      emb.model,
    );
  }
  await h.progress(60);

  // 4) AI ile ürün ve şirket bilgisi çıkarma → PENDING kayıtlar (kullanıcı onayı bekler)
  let extracted = { products: 0, facts: 0, aiSkipped: false };
  if (EXTRACTION_KINDS.has(doc.kind) && !isAIConfigured()) {
    extracted.aiSkipped = true;
  } else if (EXTRACTION_KINDS.has(doc.kind)) {
    const { data } = await service.extract({
      schema: documentExtractionSchema,
      instructions: DOCUMENT_EXTRACTION_INSTRUCTIONS,
      shape: DOCUMENT_EXTRACTION_SHAPE,
      input: untrusted(`document:${doc.title}`, text, 80_000),
      maxTokens: 8000,
    });
    extracted = { ...(await persistExtraction(companyId, documentId, data, text)), aiSkipped: false };
  }

  await rawDb.knowledgeDocument.update({
    where: { id: documentId },
    data: { status: "READY", pageCount, charCount: text.length },
  });
  await audit({
    companyId,
    userId: h.createdById,
    actorType: "AI",
    action: "knowledge.document.ingested",
    entityType: "KnowledgeDocument",
    entityId: documentId,
    metadata: { chunks: chunks.length, ...extracted },
  });
  return { chunks: chunks.length, ...extracted };
};

/**
 * Çıkarılan ürünleri PENDING ürün olarak, şirket bilgilerini PENDING fact olarak kaydeder.
 * Fiyat/sertifika/MOQ gibi kritik alanlar dokümanda geçmiyorsa atılır.
 */
export async function persistExtraction(companyId: string, documentId: string, data: DocumentExtraction, corpus: string) {
  const inDoc = (v?: string | null, evidence?: string | null) =>
    Boolean(v) && (valueFound(v!, corpus) || evidenceFound(evidence, corpus));

  // Daha önce bu dokümandan çıkarılmış ve hâlâ onay bekleyen ürünleri temizle (yeniden işleme)
  await rawDb.product.deleteMany({ where: { companyId, source: "DOCUMENT", sourceRef: documentId, status: "PENDING" } });

  let products = 0;
  for (const p of data.products) {
    const product = await rawDb.product.create({
      data: {
        companyId,
        name: p.name,
        sku: p.sku ?? null,
        description: p.description ?? null,
        technicalSpecs: (p.technicalSpecs ?? undefined) as Prisma.InputJsonValue | undefined,
        materials: p.materials,
        dimensions: p.dimensions ?? null,
        applications: p.applications,
        industries: p.industries,
        minOrder: inDoc(p.minOrder) ? p.minOrder! : null,
        priceRange: inDoc(p.priceRange) ? p.priceRange! : null,
        deliveryTime: inDoc(p.deliveryTime) ? p.deliveryTime! : null,
        certifications: p.certifications.filter((c) => valueFound(c, corpus)),
        status: "PENDING",
        source: "DOCUMENT",
        sourceRef: documentId,
        active: false,
        documents: { create: { companyId, documentId } },
      },
    });
    if (p.category) {
      const cat = await rawDb.productCategory.upsert({
        where: { companyId_name: { companyId, name: p.category.slice(0, 200) } },
        create: { companyId, name: p.category.slice(0, 200) },
        update: {},
      });
      await rawDb.product.update({ where: { id: product.id }, data: { categoryId: cat.id } });
    }
    products++;
  }

  const facts: Array<{ key: string; value: string; confidence: number }> = [];
  for (const c of data.certifications) if (inDoc(c.value, c.evidence)) facts.push({ key: "certification", value: c.value, confidence: 0.9 });
  if (data.minOrder && inDoc(data.minOrder.value, data.minOrder.evidence)) facts.push({ key: "min_order", value: data.minOrder.value, confidence: 0.9 });
  if (data.deliveryTime && inDoc(data.deliveryTime.value, data.deliveryTime.evidence)) facts.push({ key: "delivery_time", value: data.deliveryTime.value, confidence: 0.9 });
  if (data.productionCapacity && inDoc(data.productionCapacity.value, data.productionCapacity.evidence)) facts.push({ key: "production_capacity", value: data.productionCapacity.value, confidence: 0.9 });
  for (const s of data.industriesServed) facts.push({ key: "industry_served", value: s.value, confidence: inDoc(s.value, s.evidence) ? 0.9 : 0.4 });

  await rawDb.companyFact.deleteMany({ where: { companyId, source: "DOCUMENT", sourceRef: documentId, status: "PENDING" } });
  if (facts.length) {
    await rawDb.companyFact.createMany({
      data: facts.map((f) => ({ companyId, key: f.key, value: f.value, confidence: f.confidence, source: "DOCUMENT" as const, sourceRef: documentId, status: "PENDING" as const })),
    });
  }
  return { products, facts: facts.length };
}

export async function onDocumentIngestFailure(payload: JobPayloads["document.ingest"], error: string) {
  await rawDb.knowledgeDocument.update({ where: { id: payload.documentId }, data: { status: "FAILED", error: error.slice(0, 500) } });
  if (payload.usageId) await refundCredits(payload.usageId, "document.ingest.failed");
}
