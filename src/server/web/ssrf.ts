import { isIP } from "node:net";

/**
 * Dışarıya istek atılmaması gereken adresler (SSRF koruması):
 * loopback, özel ağlar, link-local (bulut metadata 169.254.169.254 dahil), CGNAT, multicast, ayrılmış.
 */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateV4(ip);
  if (version === 6) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateV4(mapped[1]);
    if (lower === "::" || lower === "::1") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 unique local
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 link-local
    if (lower.startsWith("ff")) return true; // multicast
    if (lower.startsWith("64:ff9b:")) return true; // NAT64
    if (lower.startsWith("2001:db8:")) return true; // dokümantasyon
    return false;
  }
  return true; // IP değilse güvenli sayma
}

function isPrivateV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local / metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast + ayrılmış
  );
}

/** Kullanıcının girdiği adresi normalize eder: şema ekler, fragment'ı atar. */
export function normalizeUrl(input: string): URL {
  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Geçerli bir web adresi girin (ör. aktifyay.com.tr).");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Yalnızca http/https adresleri desteklenir.");
  if (url.username || url.password) throw new Error("Kullanıcı adı/parola içeren adresler desteklenmez.");
  if (!url.hostname.includes(".") && isIP(url.hostname) === 0) throw new Error("Geçerli bir alan adı girin.");
  url.hash = "";
  return url;
}

export function registrableHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}
