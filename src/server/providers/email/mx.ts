import "server-only";
import { resolveMx, resolve4 } from "node:dns/promises";

export type MailDomainStatus = "ok" | "no_mx" | "unknown";

interface Cached {
  status: MailDomainStatus;
  at: number;
}

const TTL_MS = 12 * 3600_000;
const cache = new Map<string, Cached>();

export interface DnsLookups {
  mx: (host: string) => Promise<Array<{ exchange: string }>>;
  a: (host: string) => Promise<string[]>;
}

const defaultLookups: DnsLookups = { mx: resolveMx, a: resolve4 };

let testOverride: DnsLookups | null = null;

/** Yalnızca testlerde: gerçek DNS'e çıkılmaz. Production kodu bunu çağırmaz. */
export function __setDnsLookupsForTests(l: DnsLookups | null) {
  testOverride = l;
  cache.clear();
}

/**
 * Alan adı e-posta alabiliyor mu? MX kaydı yoksa RFC 5321 gereği A kaydı da kabul edilir.
 * İkisi de yoksa gönderim kesin geri döner (kapanmış site / yanlış alan adı).
 * DNS geçici hatalarında "unknown" döner — gönderim engellenmez.
 */
export async function checkMailDomain(domain: string, lookups?: DnsLookups): Promise<MailDomainStatus> {
  const dns = lookups ?? testOverride ?? defaultLookups;
  // Testlerde sahte DNS verilmediyse ağa çıkılmaz
  if (!lookups && !testOverride && process.env.NODE_ENV === "test") return "unknown";
  const host = domain.trim().toLowerCase();
  if (!host || !host.includes(".")) return "no_mx";
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.status;

  let status: MailDomainStatus;
  try {
    const mx = await dns.mx(host);
    status = mx.some((r) => r.exchange?.trim()) ? "ok" : "no_mx";
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";
    if (code === "ENOTFOUND" || code === "ENODATA") {
      // MX yok → A kaydı varsa posta yine de kabul edilebilir
      try {
        status = (await dns.a(host)).length > 0 ? "ok" : "no_mx";
      } catch (err2) {
        const code2 = (err2 as { code?: string }).code ?? "";
        status = code2 === "ENOTFOUND" || code2 === "ENODATA" ? "no_mx" : "unknown";
      }
    } else {
      status = "unknown";
    }
  }
  cache.set(host, { status, at: Date.now() });
  return status;
}

/** Testler için önbelleği boşaltır */
export function __clearMailDomainCache() {
  cache.clear();
}
