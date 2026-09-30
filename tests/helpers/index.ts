import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { rawDb } from "@/server/db";
import { registerUser } from "@/server/auth/service";
import { resetRateLimits } from "@/server/auth/rate-limit";
import { resetEnvCache } from "@/server/env";
import type { TenantContext } from "@/server/tenancy/types";
import type { AIProvider, GenerateTextInput, GenerateTextResult } from "@/server/ai/types";

/** Industry hariç tüm tabloları temizler. */
export async function resetDb() {
  resetEnvCache();
  resetRateLimits();
  const tables = await rawDb.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename::text AS tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations', 'Industry')`;
  if (tables.length) {
    await rawDb.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
  }
}

let seq = 0;
export async function createTenant(companyName: string, role: TenantContext["role"] = "OWNER"): Promise<TenantContext> {
  seq += 1;
  const { userId, companyId } = await registerUser({
    name: `Test ${seq}`,
    email: `user${seq}-${Date.now()}@test.local`,
    password: "testparola123",
    companyName,
  });
  if (role !== "OWNER") await rawDb.companyMember.updateMany({ where: { userId, companyId }, data: { role } });
  return { userId, companyId, role, isPlatformAdmin: false };
}

/**
 * Test AI sağlayıcısı. Gerçek API çağırmaz; verilen yanıtları sırayla döner
 * veya bir fonksiyonla girdiye göre yanıt üretir.
 */
export class MockAIProvider implements AIProvider {
  readonly name = "anthropic" as const;
  calls: GenerateTextInput[] = [];
  constructor(private readonly respond: (input: GenerateTextInput, callIndex: number) => string | Error) {}
  async generateText(input: GenerateTextInput & { model: string }): Promise<GenerateTextResult> {
    this.calls.push(input);
    const out = this.respond(input, this.calls.length - 1);
    if (out instanceof Error) throw out;
    return { text: out, provider: "anthropic", model: "mock-model", inputTokens: 100, outputTokens: 50 };
  }
}

/** Yerel sahte şirket sitesi (web sitesi analizi testleri için). */
export async function startSite(pages: Record<string, string>): Promise<{ url: string; server: Server; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    const body = pages[req.url ?? "/"];
    if (body === undefined) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const type = req.url === "/robots.txt" ? "text/plain" : (req.url ?? "").split("?")[0]!.endsWith(".json") ? "application/json" : "text/html; charset=utf-8";
    res.writeHead(200, { "content-type": type });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  // normalizeUrl alan adı ister; localhost IP'si için 127.0.0.1 kullanılır
  return { url: `http://127.0.0.1:${port}`, server, hits };
}
