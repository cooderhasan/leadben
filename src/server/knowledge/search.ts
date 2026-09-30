import "server-only";
import { Prisma } from "@prisma/client";
import { rawDb } from "@/server/db";
import { ai, getEmbeddingProvider } from "@/server/ai";
import type { TenantContext } from "@/server/tenancy/types";

export interface KnowledgeHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  verified: boolean;
  content: string;
  score: number;
}

/**
 * Şirketin bilgi bankasında arama. Tenant izolasyonu SQL seviyesinde `companyId = $1` ile sağlanır
 * (bu dosya rawDb kullanan tek servis dosyasıdır; tests/knowledge.test.ts izolasyonu doğrular).
 *
 * - Her zaman: Postgres tam metin araması (GIN indeksli)
 * - Embedding sağlayıcısı açıksa: vektör araması + Reciprocal Rank Fusion ile birleştirme
 * - onlyVerified: satış iletişimi üretirken yalnızca şirketin onayladığı dokümanlar
 */
export async function searchKnowledge(
  ctx: Pick<TenantContext, "companyId">,
  query: string,
  opts: { limit?: number; onlyVerified?: boolean } = {},
): Promise<KnowledgeHit[]> {
  const q = query.trim();
  if (!q) return [];
  const limit = Math.min(opts.limit ?? 8, 50);
  const verifiedFilter = opts.onlyVerified ? Prisma.sql`AND d."verified" = true` : Prisma.empty;

  const fts = await rawDb.$queryRaw<Array<Omit<KnowledgeHit, "score"> & { rank: number }>>`
    SELECT c."id" AS "chunkId", c."documentId", d."title" AS "documentTitle", d."verified", c."content",
           ts_rank(to_tsvector('simple', c."content"), websearch_to_tsquery('simple', ${q})) AS rank
    FROM "KnowledgeChunk" c
    JOIN "KnowledgeDocument" d ON d."id" = c."documentId" AND d."companyId" = c."companyId"
    WHERE c."companyId" = ${ctx.companyId}
      AND d."status" = 'READY'
      ${verifiedFilter}
      AND to_tsvector('simple', c."content") @@ websearch_to_tsquery('simple', ${q})
    ORDER BY rank DESC
    LIMIT ${limit * 2}`;

  let vector: Array<Omit<KnowledgeHit, "score"> & { distance: number }> = [];
  const provider = getEmbeddingProvider();
  if (provider) {
    const emb = await ai({ companyId: ctx.companyId, operation: "knowledge.search" }).embed([q]);
    if (emb?.vectors[0]) {
      const literal = `[${emb.vectors[0].join(",")}]`;
      vector = await rawDb.$queryRaw`
        SELECT c."id" AS "chunkId", c."documentId", d."title" AS "documentTitle", d."verified", c."content",
               (c."embedding" <=> ${literal}::vector) AS distance
        FROM "KnowledgeChunk" c
        JOIN "KnowledgeDocument" d ON d."id" = c."documentId" AND d."companyId" = c."companyId"
        WHERE c."companyId" = ${ctx.companyId}
          AND d."status" = 'READY'
          ${verifiedFilter}
          AND c."embedding" IS NOT NULL
          AND c."embeddingModel" = ${emb.model}
        ORDER BY distance ASC
        LIMIT ${limit * 2}`;
    }
  }

  // Reciprocal Rank Fusion
  const K = 60;
  const merged = new Map<string, KnowledgeHit>();
  const add = (rows: Array<Omit<KnowledgeHit, "score">>) =>
    rows.forEach((r, i) => {
      const prev = merged.get(r.chunkId);
      const score = 1 / (K + i + 1);
      merged.set(r.chunkId, {
        chunkId: r.chunkId,
        documentId: r.documentId,
        documentTitle: r.documentTitle,
        verified: r.verified,
        content: r.content,
        score: (prev?.score ?? 0) + score,
      });
    });
  add(fts);
  add(vector);
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Parçaların embedding'ini yazar (pgvector). */
export async function storeEmbeddings(
  companyId: string,
  rows: Array<{ chunkId: string; vector: number[] }>,
  model: string,
): Promise<void> {
  for (const r of rows) {
    const literal = `[${r.vector.join(",")}]`;
    await rawDb.$executeRaw`
      UPDATE "KnowledgeChunk" SET "embedding" = ${literal}::vector, "embeddingModel" = ${model}
      WHERE "id" = ${r.chunkId} AND "companyId" = ${companyId}`;
  }
}
