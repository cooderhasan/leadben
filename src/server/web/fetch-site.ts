import { lookup } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import * as cheerio from "cheerio";
import { isPrivateAddress, normalizeUrl, registrableHost } from "./ssrf";
import { getPageRenderer } from "@/server/providers/render";

export const USER_AGENT = "AISalesOS-SiteAnalyzer/1.0 (+company-profile-analysis)";
const MAX_BYTES = 2_000_000;
const MAX_TEXT_PER_PAGE = 15_000;

export interface FetchOptions {
  /** Yalnızca testler için: yerel test sunucusuna izin verir. */
  allowPrivateHosts?: boolean;
  timeoutMs?: number;
  /** JSON yanıt beklenen istekler (ör. DataTables veri kaynağı) */
  json?: boolean;
}

export interface PageContent {
  url: string;
  title: string;
  metaDescription: string;
  headings: string[];
  text: string;
  links: string[];
  emails: string[];
  phones: string[];
  /** Sayfada mesaj alanı olan bir iletişim formu var mı (e-posta bulunamayan firmalar için tek kanal) */
  hasContactForm: boolean;
}

export class FetchBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchBlockedError";
  }
}

/**
 * DNS çözümlemesini bağlantı anında doğrulayan agent — DNS rebinding ile iç ağa erişimi engeller.
 */
function safeAgent(allowPrivate: boolean) {
  return new Agent({
    connect: {
      lookup(hostname, options, callback) {
        lookup(hostname, { ...options, all: true }, (err, addresses) => {
          if (err) return callback(err, "", 0);
          const list = (Array.isArray(addresses) ? addresses : [addresses]) as Array<{ address: string; family: number }>;
          if (!allowPrivate && list.some((a) => isPrivateAddress(a.address))) {
            return callback(new FetchBlockedError(`Özel ağ adresine erişim engellendi: ${hostname}`), "", 0);
          }
          const first = list[0];
          if (!first) return callback(new Error("DNS sonucu yok"), "", 0);
          if ((options as { all?: boolean }).all) {
            return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
          }
          callback(null, first.address, first.family);
        });
      },
    },
  });
}

async function readLimited(res: Awaited<ReturnType<typeof undiciFetch>>): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Tek bir URL'yi güvenli şekilde getirir; yönlendirmeleri her adımda yeniden doğrular. */
export async function safeFetch(
  input: string | URL,
  opts: FetchOptions = {},
): Promise<{ finalUrl: URL; status: number; contentType: string; body: string }> {
  let url = typeof input === "string" ? normalizeUrl(input) : input;
  const agent = safeAgent(Boolean(opts.allowPrivateHosts));
  try {
    for (let hop = 0; hop < 5; hop++) {
      if (!opts.allowPrivateHosts && isIP(url.hostname) && isPrivateAddress(url.hostname)) {
        throw new FetchBlockedError("Özel ağ adreslerine erişim engellendi.");
      }
      const res = await undiciFetch(url, {
        dispatcher: agent,
        redirect: "manual",
        headers: opts.json
          ? { "user-agent": USER_AGENT, accept: "application/json", "x-requested-with": "XMLHttpRequest" }
          : { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain;q=0.8" },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        await res.body?.cancel();
        if (!loc) throw new Error("Yönlendirme adresi yok");
        url = normalizeUrl(new URL(loc, url).toString());
        continue;
      }
      const contentType = res.headers.get("content-type") ?? "";
      const readable = opts.json ? /json/i : /text\/(html|plain)|xhtml/i;
      const body = res.ok && readable.test(contentType) ? await readLimited(res) : "";
      if (!body) await res.body?.cancel().catch(() => undefined);
      return { finalUrl: url, status: res.status, contentType, body };
    }
    throw new Error("Çok fazla yönlendirme");
  } finally {
    await agent.close().catch(() => undefined);
  }
}

// ── robots.txt ─────────────────────────────────────────────────────────

export type RobotsRule = { allow: boolean; path: string };

export function parseRobots(txt: string, userAgent: string): RobotsRule[] {
  const rules: Record<string, RobotsRule[]> = {};
  let current: string[] = [];
  let lastWasAgent = false;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [k, ...rest] = line.split(":");
    const key = k?.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      if (!lastWasAgent) current = [];
      current.push(value.toLowerCase());
      rules[value.toLowerCase()] ??= [];
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      // Boş "Disallow:" her şeye izin demektir → kural eklenmez
      if ((key === "disallow" || key === "allow") && value) for (const a of current) rules[a]!.push({ allow: key === "allow", path: value });
    }
  }
  const ua = userAgent.toLowerCase().split("/")[0]!;
  const specific = Object.keys(rules).find((a) => a !== "*" && ua.includes(a));
  return rules[specific ?? "*"] ?? [];
}

function robotsRuleMatches(path: string, rule: string): boolean {
  // "*" herhangi bir dizi, sondaki "$" satır sonu (Google / RFC 9309 yorumu)
  const anchored = rule.endsWith("$");
  const body = (anchored ? rule.slice(0, -1) : rule).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path);
}

/**
 * En uzun eşleşen kural kazanır; eşitlikte Allow üstündür (RFC 9309).
 * `path` yol + sorgu dizesidir (ör. "/urunler?sayfa=2").
 */
export function isAllowedByRobots(path: string, rules: RobotsRule[]): boolean {
  let best: RobotsRule | undefined;
  for (const r of rules) {
    if (!robotsRuleMatches(path, r.path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

// ── İçerik çıkarma ─────────────────────────────────────────────────────

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_RE = /(?:\+?90[\s-]?)?\(?0?\s?[2-5]\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}/g;

/** Cloudflare'in XOR ile gizlediği e-posta adresini çözer (ilk bayt anahtardır). */
export function decodeCfEmail(hex: string): string | null {
  if (!/^[0-9a-f]{4,}$/i.test(hex) || hex.length % 2) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  const email = out.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email) ? email : null;
}

export function extractPage(html: string, pageUrl: URL): PageContent {
  const $ = cheerio.load(html);
  const emails = new Set<string>();
  const phones = new Set<string>();
  $("a[href^='mailto:']").each((_, el) => {
    const v = ($(el).attr("href") ?? "").replace(/^mailto:/i, "").split("?")[0]?.trim().toLowerCase();
    if (v) emails.add(v);
  });
  // Cloudflare e-posta gizleme: <a href="/cdn-cgi/l/email-protection#…"> ve <span data-cfemail="…">
  $("[data-cfemail]").each((_, el) => {
    const v = decodeCfEmail($(el).attr("data-cfemail") ?? "");
    if (v) emails.add(v);
  });
  $("a[href*='/cdn-cgi/l/email-protection#']").each((_, el) => {
    const v = decodeCfEmail(($(el).attr("href") ?? "").split("#")[1] ?? "");
    if (v) emails.add(v);
  });
  $("a[href^='tel:']").each((_, el) => {
    const v = ($(el).attr("href") ?? "").replace(/^tel:/i, "").trim();
    if (v) phones.add(v);
  });

  const links = new Set<string>();
  $("a[href]").each((_, el) => {
    try {
      const u = new URL($(el).attr("href") ?? "", pageUrl);
      if ((u.protocol === "http:" || u.protocol === "https:") && registrableHost(u.hostname) === registrableHost(pageUrl.hostname)) {
        u.hash = "";
        links.add(u.toString());
      }
    } catch {
      /* geçersiz link */
    }
  });

  const title = $("title").first().text().trim();
  const metaDescription = $("meta[name='description']").attr("content")?.trim() ?? "";
  const headings = $("h1, h2, h3")
    .map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
    .get()
    .filter((h) => h.length > 1 && h.length < 200)
    .slice(0, 60);

  // Form, metin çıkarılırken siliniyor → önce tespit edilir
  const hasContactForm = detectContactForm($);

  $("script, style, noscript, svg, iframe, template, form").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_PER_PAGE);

  for (const m of text.match(EMAIL_RE) ?? []) {
    if (!/\.(png|jpe?g|gif|webp|svg)$/i.test(m)) emails.add(m.toLowerCase());
  }
  for (const m of text.match(PHONE_RE) ?? []) phones.add(m.trim());

  return {
    url: pageUrl.toString(),
    title,
    metaDescription,
    headings,
    text,
    links: [...links],
    emails: [...emails].slice(0, 20),
    phones: [...phones].slice(0, 20),
    hasContactForm,
  };
}

export const CONTACT_PATH = /iletisim|iletişim|contact|bize-ula|ulasim|ulaşım/i;

/** Arama kutusu / bülten aboneliği gibi iletişim formu olmayan alan adları */
const NON_CONTACT_FIELD = /\b(search|arama|ara|query|q|keyword|newsletter|bulten|bülten|subscribe|abone|password|parola|login|giris|giriş|coupon|kupon|qty|quantity|adet)\b/i;

/**
 * Sayfada mesaj yazılabilen bir iletişim formu var mı? Ölçüt: <textarea> içeren bir form.
 * Arama kutuları ve bülten aboneliği kutularında mesaj alanı olmaz, bu yüzden elenir.
 * Kesinlik iddiası yok — bulunan adres kullanıcıya "olabilir" diye gösterilir, o doğrular.
 */
export function detectContactForm($: cheerio.CheerioAPI): boolean {
  let found = false;
  $("form").each((_, el) => {
    if (found) return;
    const form = $(el);
    if (form.find("textarea").length === 0) return;
    const names = form
      .find("input, textarea, select")
      .map((_, f) => `${$(f).attr("name") ?? ""} ${$(f).attr("id") ?? ""}`)
      .get()
      .join(" ");
    if (NON_CONTACT_FIELD.test(names)) return;
    found = true;
  });
  return found;
}

/** Şirket tanımak için öncelikli sayfa anahtar kelimeleri (TR + EN). */
const PRIORITY_KEYWORDS = [
  "hakkimizda", "hakkımızda", "kurumsal", "about", "company",
  "urun", "ürün", "product", "katalog", "catalog",
  "hizmet", "service", "uretim", "üretim", "production", "manufactur",
  "kalite", "quality", "sertifika", "certificate", "belge",
  "sektor", "sektör", "industr", "uygulama", "application",
  "iletisim", "iletişim", "contact", "referans", "reference",
];

const NON_PAGE_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|zip|rar|docx?|xlsx?|mp4|mp3|css|js|xml)$/i;
const PRODUCT_PATH = /urun|ürün|product|prodcts|hizmet|service|sektor|sektör|uygulama|application|faaliyet/i;

/** Sayfa anahtarı: aynı sayfanın farklı yazımları (sondaki /, #) bir kez taranır */
function pageKey(u: URL): string {
  return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}${u.search}`.toLowerCase();
}

/** Anahtar kelime puanı − derinlik cezası (anahtar kelimesiz sayfalar negatif ama sıradan çıkmaz) */
function linkScore(u: URL): number {
  const path = decodeURIComponent(u.pathname.toLowerCase());
  let s = 0;
  PRIORITY_KEYWORDS.forEach((k, i) => {
    if (path.includes(k)) s += 100 - i;
  });
  return s - path.split("/").length * 2;
}

export function rankLinks(links: string[], home: URL): string[] {
  const skip = /\.(pdf|jpe?g|png|gif|webp|svg|zip|rar|docx?|xlsx?|mp4)$/i;
  const score = (u: string) => {
    const path = decodeURIComponent(new URL(u).pathname.toLowerCase());
    let s = 0;
    PRIORITY_KEYWORDS.forEach((k, i) => {
      if (path.includes(k)) s += 100 - i;
    });
    return s - path.split("/").length * 2;
  };
  return links
    .filter((u) => !skip.test(u) && new URL(u).pathname !== home.pathname)
    .map((u) => ({ u, s: score(u) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.u);
}

export interface CrawlResult {
  homeUrl: string;
  pages: PageContent[];
  skipped: Array<{ url: string; reason: string }>;
}

/**
 * Kayıtlı adres önce; sonra https (www'suz / www'li), en son http. Dizinlerden gelen adresler çoğu zaman
 * "http://www.…" olur ve https'e yönlenir; sertifika ise yalnızca diğer ada verilmiş olabilir. IP'de yalnızca kendisi.
 */
export function originCandidates(start: URL): URL[] {
  if (isIP(start.hostname)) return [start];
  const path = `${start.pathname}${start.search}`;
  const bare = start.hostname.replace(/^www\./, "");
  const out = [start.toString(), ...["https:", "http:"].flatMap((proto) => [`${proto}//${bare}${path}`, `${proto}//www.${bare}${path}`])];
  return [...new Set(out)].map((u) => new URL(u));
}

/** Ağ hatasını kullanıcıya anlaşılır Türkçe açıklamaya çevirir */
export function describeNetworkError(err: unknown): string {
  const e = err as { message?: string; cause?: unknown } | null;
  // undici hata kodunu iç içe "cause" zincirinde taşır
  let code = "";
  for (let c: unknown = err, i = 0; c && i < 5 && !code; c = (c as { cause?: unknown }).cause, i++) {
    code = String((c as { code?: string }).code ?? "");
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "Alan adı bulunamadı — site kapanmış veya adres yanlış olabilir.";
  if (code.startsWith("ERR_TLS") || code.includes("SSL") || code.includes("CERT")) return "Sitenin güvenlik sertifikası (SSL) hatalı.";
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "UND_ERR_SOCKET") return "Site bağlantıyı reddetti.";
  if (code === "UND_ERR_CONNECT_TIMEOUT" || e?.message?.includes("timeout") || (err as Error)?.name === "TimeoutError") return "Site zamanında yanıt vermedi.";
  return e?.message ? `Siteye ulaşılamadı (${e.message}).` : "Siteye ulaşılamadı.";
}

/**
 * Şirket sitesini tarar: ana sayfa + en fazla `maxPages - 1` öncelikli iç sayfa.
 * robots.txt'ye uyar; sayfalar arası kısa bekleme yapar.
 */
export async function crawlSite(input: string, opts: FetchOptions & { maxPages?: number; ensureContactPage?: boolean } = {}): Promise<CrawlResult> {
  const maxPages = opts.maxPages ?? 6;
  const skipped: CrawlResult["skipped"] = [];

  // Çoğu küçük firma sitesi yalnızca "www." ile veya yalnızca http ile açılır (DNS kaydı / SSL sertifikası eksik).
  // Yanıt veren ilk adres kullanılır; robots.txt her zaman o adreste, sayfalardan ÖNCE okunur.
  let start = normalizeUrl(input);
  let disallowed: RobotsRule[] = [];
  let lastError: unknown = null;
  let reachable = false;
  for (const candidate of originCandidates(start)) {
    try {
      const robots = await safeFetch(new URL("/robots.txt", candidate), { ...opts, timeoutMs: 8_000 });
      start = candidate;
      reachable = true;
      if (robots.status === 200) disallowed = parseRobots(robots.body, USER_AGENT);
      break;
    } catch (err) {
      if (err instanceof FetchBlockedError) throw err;
      lastError = err;
    }
  }
  if (!reachable) throw new Error(describeNetworkError(lastError));
  if (!isAllowedByRobots(start.pathname + start.search, disallowed)) {
    throw new FetchBlockedError("Sitenin robots.txt dosyası analize izin vermiyor.");
  }

  let home = await safeFetch(start, opts);
  // Dizindeki adres eski bir alt sayfa olabilir (/iletisim-1.html → 404) → ana sayfaya dönülür
  if ((home.status >= 400 || !home.body) && start.pathname !== "/") {
    const root = new URL("/", start);
    if (isAllowedByRobots("/", disallowed)) home = await safeFetch(root, opts);
  }
  if (home.status >= 400 || !home.body) {
    throw new Error(`Site açılamadı (HTTP ${home.status}).`);
  }
  const homePage = extractPage(home.body, home.finalUrl);
  const pages: PageContent[] = [homePage];

  // Sıra: iletişim (istenirse) → anahtar kelimeli sayfalar → ürün / hizmet sayfalarının alt sayfaları → diğer iç sayfalar.
  // Küçük sitelerde sektör / ürün sayfaları çoğu zaman "dm.html", "oto.html" gibi adlarla ürünler sayfasının altındadır.
  const seen = new Set<string>([pageKey(home.finalUrl)]);
  const queue: Array<{ url: string; score: number }> = [];
  const addLinks = (links: string[], base: number) => {
    for (const link of links) {
      let u: URL;
      try {
        u = new URL(link);
      } catch {
        continue;
      }
      const key = pageKey(u);
      if (seen.has(key) || NON_PAGE_EXT.test(u.pathname) || /\/index\.(html?|php|aspx?)$/i.test(u.pathname) || u.pathname.includes(":")) continue;
      seen.add(key);
      const contactBoost = opts.ensureContactPage && CONTACT_PATH.test(decodeURIComponent(u.pathname)) ? 1000 : 0;
      queue.push({ url: link, score: base + linkScore(u) + contactBoost });
    }
  };
  addLinks(homePage.links, 0);

  while (pages.length < maxPages && queue.length) {
    queue.sort((a, b) => b.score - a.score);
    const { url: link } = queue.shift()!;
    const u = new URL(link);
    if (!isAllowedByRobots(u.pathname + u.search, disallowed)) {
      skipped.push({ url: link, reason: "robots.txt" });
      continue;
    }
    try {
      await new Promise((r) => setTimeout(r, 300));
      const res = await safeFetch(u, opts);
      if (res.status < 400 && res.body) {
        const page = extractPage(res.body, res.finalUrl);
        pages.push(page);
        // Ürün / hizmet / sektör sayfasının alt sayfaları, genel sayfalardan önce gelir
        if (PRODUCT_PATH.test(decodeURIComponent(u.pathname))) addLinks(page.links, 60);
        else addLinks(page.links, -50);
      } else skipped.push({ url: link, reason: `HTTP ${res.status}` });
    } catch (err) {
      skipped.push({ url: link, reason: (err as Error).message.slice(0, 120) });
    }
  }

  return { homeUrl: home.finalUrl.toString(), pages, skipped };
}

// ── Liste sayfası (OSB üye listesi, fuar katılımcıları, dernek üyeleri) ─────

const MAX_LIST_TEXT = 60_000;

/**
 * Tek bir liste sayfasını okur ve satır yapısını koruyan düz metne çevirir (tablo satırı → "a | b | c").
 * robots.txt'ye uyar. Sayfadaki web sitesi / e-posta bağlantıları metnin sonuna eklenir (AI eşleştirebilsin).
 */
export async function fetchListPage(
  input: string,
  opts: FetchOptions & { render?: boolean } = {},
): Promise<{ finalUrl: string; text: string; records: Array<Record<string, unknown>> | null; rendered: boolean }> {
  let start = normalizeUrl(input);
  let disallowed: RobotsRule[] = [];
  let reachable = false;
  let lastError: unknown = null;
  for (const candidate of originCandidates(start)) {
    try {
      const robots = await safeFetch(new URL("/robots.txt", candidate), { ...opts, timeoutMs: 8_000 });
      start = candidate;
      reachable = true;
      if (robots.status === 200) disallowed = parseRobots(robots.body, USER_AGENT);
      break;
    } catch (err) {
      if (err instanceof FetchBlockedError) throw err;
      lastError = err;
    }
  }
  if (!reachable) throw new Error(describeNetworkError(lastError));
  if (!isAllowedByRobots(start.pathname + start.search, disallowed)) {
    throw new FetchBlockedError("Bu sayfa robots.txt ile otomatik okumaya kapalı. Listeyi kopyalayıp metin olarak yapıştırabilirsiniz.");
  }
  // Satırları JavaScript ile yükleyen sayfalar (fuar katılımcı listeleri) sunucudan boş gelir:
  // istenirse sayfa gerçek tarayıcıda açtırılır. robots.txt kontrolü yukarıda zaten yapıldı.
  if (opts.render) {
    const text = await getPageRenderer().render(start.toString());
    return { finalUrl: start.toString(), text, records: null, rendered: true };
  }

  const page = await safeFetch(start, { ...opts, timeoutMs: 20_000 });
  if (page.status >= 400 || !page.body) throw new Error(`Sayfa açılamadı (HTTP ${page.status}).`);

  // Tablo satırları sonradan JavaScript ile (DataTables) yükleniyorsa veriyi kaynağından al:
  // yalnızca aynı site, robots.txt izin veriyorsa, tek istek.
  let records: Array<Record<string, unknown>> | null = null;
  const source = findDataTableSource(page.body, page.finalUrl);
  if (source && isAllowedByRobots(source.pathname + source.search, disallowed)) {
    try {
      const res = await safeFetch(source, { ...opts, json: true, timeoutMs: 30_000 });
      if (res.status < 400 && res.body) records = parseDataTableJson(res.body);
    } catch {
      /* veri kaynağı okunamadı → sayfa metniyle devam */
    }
  }
  return { finalUrl: page.finalUrl.toString(), text: htmlToListText(page.body, page.finalUrl), records, rendered: false };
}

/** Sayfadaki DataTables "ajax" veri kaynağı (aynı site ise). Saf fonksiyon. */
export function findDataTableSource(html: string, pageUrl: URL): URL | null {
  const m =
    html.match(/\bajax\s*:\s*['"]([^'"]+)['"]/) ??
    html.match(/\bajax\s*:\s*\{[^}]*?\burl\s*:\s*['"]([^'"]+)['"]/) ??
    html.match(/\bsAjaxSource['"]?\s*:\s*['"]([^'"]+)['"]/);
  if (!m?.[1]) return null;
  try {
    const u = new URL(m[1], pageUrl);
    return registrableHost(u.hostname) === registrableHost(pageUrl.hostname) && /^https?:$/.test(u.protocol) ? u : null;
  } catch {
    return null;
  }
}

/** DataTables yanıtı: {data:[…]} / {aaData:[…]} / […] → nesne satırları */
export function parseDataTableJson(body: string): Array<Record<string, unknown>> | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const o = json as { data?: unknown; aaData?: unknown };
  const rows = Array.isArray(json) ? json : Array.isArray(o?.data) ? o.data : Array.isArray(o?.aaData) ? o.aaData : null;
  if (!rows) return null;
  const objects = rows.filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object" && !Array.isArray(r));
  return objects.length ? objects.slice(0, 5000) : null;
}

/** HTML → satır korumalı metin. Saf fonksiyon (testlerde doğrudan kullanılır). */
export function htmlToListText(html: string, pageUrl: URL): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe, template, head, nav, footer").remove();
  const links = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (/^mailto:/i.test(href)) links.add(href.replace(/^mailto:/i, "").split("?")[0]!.toLowerCase());
    else {
      try {
        const u = new URL(href, pageUrl);
        // Yalnızca dış siteler (listedeki firmaların siteleri); listenin kendi sayfaları değil
        if ((u.protocol === "http:" || u.protocol === "https:") && registrableHost(u.hostname) !== registrableHost(pageUrl.hostname)) links.add(`${u.protocol}//${u.hostname}`);
      } catch {
        /* geçersiz bağlantı */
      }
    }
  });
  $("tr").each((_, tr) => {
    const cells = $(tr)
      .children("td, th")
      .map((__, c) => $(c).text().replace(/\s+/g, " ").trim())
      .get()
      .filter(Boolean);
    $(tr).replaceWith(`\n${cells.join(" | ")}\n`);
  });
  $("br").replaceWith("\n");
  $("p, div, li, h1, h2, h3, h4, h5, h6, dt, dd, section, article").append("\n");
  const text = $("body")
    .text()
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  const linkBlock = links.size ? `\n\nSAYFADAKİ BAĞLANTILAR:\n${[...links].slice(0, 400).join("\n")}` : "";
  return (text + linkBlock).slice(0, MAX_LIST_TEXT);
}
