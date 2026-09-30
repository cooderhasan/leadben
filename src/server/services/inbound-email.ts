import "server-only";
import * as cheerio from "cheerio";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import { findCompanyForInbound } from "@/server/tenancy/message-lookup";
import { recordInboundReply } from "./conversations";
import { applyBounceByIds } from "./email-events";

export interface ParsedInbound {
  from: string;
  to: string[];
  subject: string | null;
  text: string;
  references: string[];
  /** Gelen iletinin kendi Message-ID'si (tekrar kaydı önlemek için) */
  messageId?: string | null;
  receivedAt?: Date;
}

const splitRefs = (v: unknown): string[] =>
  typeof v === "string" ? v.split(/[\s,]+/).filter(Boolean) : Array.isArray(v) ? v.flatMap(splitRefs) : [];

const addr = (v: unknown): string | null => {
  if (!v) return null;
  if (typeof v === "string") return v.match(/<([^>]+)>/)?.[1] ?? v;
  if (typeof v === "object") {
    const o = v as { Address?: string; address?: string; email?: string };
    return o.Address ?? o.address ?? o.email ?? null;
  }
  return null;
};

/**
 * Gelen e-posta gövdesini ortak biçime çevirir.
 * Desteklenen: Brevo Inbound Parsing ({items:[…]}) ve genel JSON
 * ({from, to, subject, text, inReplyTo, references}) — Zapier/Make/n8n veya kendi IMAP köprünüz için.
 */
export function parseInboundPayload(body: unknown): ParsedInbound[] {
  const b = body as Record<string, unknown>;
  const items = Array.isArray(b?.items) ? (b.items as Array<Record<string, unknown>>) : [b];
  const out: ParsedInbound[] = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const from = addr(it.From ?? it.from);
    const toRaw = it.To ?? it.to;
    const to = (Array.isArray(toRaw) ? toRaw : [toRaw]).map(addr).filter((x): x is string => Boolean(x));
    const text =
      (typeof it.ExtractedMarkdownMessage === "string" && it.ExtractedMarkdownMessage) ||
      (typeof it.RawTextBody === "string" && it.RawTextBody) ||
      (typeof it.text === "string" && it.text) ||
      "";
    const headers = (it.Headers ?? it.headers ?? {}) as Record<string, unknown>;
    const references = [
      ...splitRefs(it.InReplyTo ?? it.inReplyTo ?? headers["In-Reply-To"] ?? headers["in-reply-to"]),
      ...splitRefs(it.References ?? it.references ?? headers.References ?? headers.references),
    ];
    const messageId = it.MessageId ?? it.messageId ?? headers["Message-ID"] ?? headers["Message-Id"] ?? headers["message-id"];
    if (!from || !text.trim()) continue;
    out.push({
      from,
      to,
      subject: typeof (it.Subject ?? it.subject) === "string" ? String(it.Subject ?? it.subject) : null,
      text,
      references,
      messageId: typeof messageId === "string" ? messageId : null,
    });
  }
  return out;
}

/** Gelen her yanıtı doğru şirkete kaydeder; eşleşmeyenler atlanır (başka şirkete yazılmaz). */
export async function ingestInbound(items: ParsedInbound[], source: "webhook" | "imap" = "webhook") {
  let recorded = 0;
  let unmatched = 0;
  let duplicates = 0;
  for (const item of items.slice(0, 50)) {
    const companyId = await findCompanyForInbound({ references: item.references, to: item.to });
    if (!companyId) {
      unmatched++;
      continue;
    }
    const res = await recordInboundReply(
      companyId,
      {
        fromAddress: item.from,
        toAddress: item.to[0] ?? null,
        subject: item.subject,
        body: item.text,
        references: item.references,
        externalId: item.messageId ?? null,
        receivedAt: item.receivedAt,
      },
      { source },
    );
    if (!res.matched) unmatched++;
    else if (res.duplicate) duplicates++;
    else recorded++;
  }
  return { recorded, unmatched, duplicates };
}

// ── Ham e-posta (IMAP) ────────────────────────────────────────────────

export type RawEmailKind =
  | { kind: "reply"; item: ParsedInbound }
  | { kind: "bounce"; ids: string[]; permanent: boolean }
  | { kind: "auto_reply" }
  | { kind: "skip"; reason: string };

const AUTO_SUBJECT = /^\s*(otomatik yan[ıi]t|auto(matic)?[\s-]*(reply|response|antwort)|out of (the )?office|ofis d[ıi][şs][ıi]nda|izindeyim|abwesenheit)/i;

/**
 * Otomatik yanıt mı? (izin / ofis dışı / otomatik alındı bildirimi). Bunlar gerçek yanıt sayılmaz:
 * hatırlatmaları durdurmaz, lead durumunu değiştirmez.
 */
export function isAutoReply(headers: Map<string, unknown>, subject: string | null): boolean {
  const h = (k: string) => {
    const v = headers.get(k);
    return typeof v === "string" ? v.toLowerCase() : v && typeof v === "object" && "value" in v ? String((v as { value: unknown }).value).toLowerCase() : "";
  };
  const autoSubmitted = h("auto-submitted");
  if (autoSubmitted && autoSubmitted !== "no") return true;
  if (headers.has("x-autoreply") || headers.has("x-autorespond")) return true;
  if (/^(auto_reply|bulk|junk|list)$/.test(h("precedence"))) return true;
  return AUTO_SUBJECT.test(subject ?? "");
}

/**
 * Geri dönme (bounce / DSN) bildirimi mi? Öyleyse orijinal iletimizin kimliklerini ve kalıcı olup olmadığını döner.
 * Kimlikler: bizim X-AISalesOS-Message-Id başlığımız ve iade edilen iletideki Message-ID.
 */
export function detectBounce(mail: { from: string | null; contentType: string; raw: string; ownMessageId: string | null }): { ids: string[]; permanent: boolean } | null {
  const isReport = /multipart\/report/i.test(mail.contentType) && /delivery-status/i.test(mail.contentType);
  const fromDaemon = /^(mailer-daemon|postmaster)@/i.test(mail.from ?? "");
  if (!isReport && !fromDaemon) return null;

  const own = mail.ownMessageId?.replace(/[<>]/g, "");
  const ids = new Set<string>();
  for (const m of mail.raw.matchAll(/^X-AISalesOS-Message-Id:\s*(\S+)/gim)) ids.add(m[1]!);
  for (const m of mail.raw.matchAll(/^Message-ID:\s*<([^>\s]+)>/gim)) if (m[1] !== own) ids.add(m[1]!);
  if (ids.size === 0) return null;

  const status = mail.raw.match(/^Status:\s*([245])\.\d{1,3}\.\d{1,3}/im)?.[1];
  const failed = /^Action:\s*failed/im.test(mail.raw);
  // 5.x.x kalıcı, 4.x.x geçici; durum kodu yoksa "failed" eylemi kalıcı sayılır
  const permanent = status ? status === "5" : failed;
  return { ids: [...ids], permanent };
}

const addresses = (a: AddressObject | AddressObject[] | undefined): string[] =>
  (Array.isArray(a) ? a : a ? [a] : []).flatMap((o) => o.value.map((v) => v.address ?? "")).filter(Boolean);

function mailText(mail: ParsedMail): string {
  if (mail.text?.trim()) return mail.text;
  if (typeof mail.html === "string" && mail.html) {
    const $ = cheerio.load(mail.html);
    $("script,style,head").remove();
    $("br").replaceWith("\n");
    $("p,div,tr,li,blockquote").append("\n");
    return $.root().text().replace(/\n{3,}/g, "\n\n").trim();
  }
  return "";
}

/** Ham e-postayı (RFC 822) sınıflandırır: yanıt, geri dönme, otomatik yanıt veya atla. Veritabanına dokunmaz. */
export async function classifyRawEmail(source: Buffer | string): Promise<RawEmailKind> {
  const mail = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true });
  const from = mail.from?.value[0]?.address?.toLowerCase() ?? null;
  const contentType = String((mail.headers.get("content-type") as { value?: string; params?: Record<string, string> } | undefined)?.value ?? "");
  const ctParams = (mail.headers.get("content-type") as { params?: Record<string, string> } | undefined)?.params ?? {};
  const raw = typeof source === "string" ? source : source.toString("utf8");

  const bounce = detectBounce({
    from,
    contentType: `${contentType}; ${Object.entries(ctParams).map(([k, v]) => `${k}=${v}`).join("; ")}`,
    raw,
    ownMessageId: mail.messageId ?? null,
  });
  if (bounce) return { kind: "bounce", ...bounce };
  if (!from) return { kind: "skip", reason: "no_sender" };
  if (isAutoReply(mail.headers, mail.subject ?? null)) return { kind: "auto_reply" };

  const text = mailText(mail);
  if (!text.trim()) return { kind: "skip", reason: "empty" };
  return {
    kind: "reply",
    item: {
      from,
      to: [...addresses(mail.to), ...addresses(mail.cc)],
      subject: mail.subject ?? null,
      text,
      references: [...splitRefs(mail.inReplyTo), ...splitRefs(mail.references)],
      messageId: mail.messageId ?? null,
      receivedAt: mail.date && !Number.isNaN(mail.date.getTime()) && mail.date <= new Date() ? mail.date : undefined,
    },
  };
}

export type RawEmailOutcome = "recorded" | "duplicate" | "unmatched" | "bounce" | "bounce_unmatched" | "auto_reply" | "skipped";

/** IMAP'ten gelen tek ham e-postayı işler. Eşleşmeyen iletilerin içeriği hiçbir yere kaydedilmez. */
export async function ingestRawEmail(source: Buffer | string): Promise<RawEmailOutcome> {
  const c = await classifyRawEmail(source);
  if (c.kind === "bounce") return (await applyBounceByIds(c.ids, c.permanent)) ? "bounce" : "bounce_unmatched";
  if (c.kind === "auto_reply") return "auto_reply";
  if (c.kind === "skip") return "skipped";
  const res = await ingestInbound([c.item], "imap");
  return res.recorded ? "recorded" : res.duplicates ? "duplicate" : "unmatched";
}
