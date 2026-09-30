import "server-only";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Ham (tenant filtresiz) Prisma istemcisi.
 *
 * YALNIZCA auth, tenancy, jobs, audit, usage, admin ve seed katmanlarında kullanılır.
 * Müşteri verisine erişen servisler `tenantDb(ctx)` kullanmak zorundadır (ESLint kuralı ile zorlanır).
 */
function createClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL tanımlı değil");
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "test" ? [] : process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

const globalForPrisma = globalThis as unknown as { __rawDb?: PrismaClient };

export const rawDb: PrismaClient = globalForPrisma.__rawDb ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.__rawDb = rawDb;

export type Db = typeof rawDb;
