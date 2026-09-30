import "server-only";
import { resolveTxt } from "node:dns/promises";
import { env } from "@/server/env";
import { BrevoProvider, ResendProvider, SmtpProvider } from "./providers";
import type { DomainAuthStatus, EmailProvider } from "./types";

let override: EmailProvider | null = null;

/** Yalnızca testlerde kullanılır. Production kodu bunu çağırmaz. */
export function __setEmailProviderForTests(p: EmailProvider | null) {
  override = p;
}

export function isEmailConfigured(): boolean {
  return Boolean(override) || Boolean(env().EMAIL_PROVIDER);
}

export function emailProviderLabel(): string | null {
  if (override) return override.name;
  return env().EMAIL_PROVIDER ?? null;
}

/** Platform e-posta sağlayıcısı. Yapılandırılmamışsa null (gönderim kapalı). */
export function getEmailProvider(): EmailProvider | null {
  if (override) return override;
  const e = env();
  switch (e.EMAIL_PROVIDER) {
    case "resend":
      return new ResendProvider(e.RESEND_API_KEY ?? "");
    case "brevo":
      return new BrevoProvider(e.BREVO_API_KEY ?? "");
    case "smtp":
      return new SmtpProvider({ host: e.SMTP_HOST ?? "", port: e.SMTP_PORT, secure: e.SMTP_SECURE, user: e.SMTP_USER, pass: e.SMTP_PASS });
    default:
      return null;
  }
}

type TxtResolver = (name: string) => Promise<string[][]>;

/**
 * Gönderici alan adının SPF / DMARC kayıtlarını DNS'ten kontrol eder (spec §58).
 * DKIM seçici (selector) sağlayıcıya özel olduğundan genel kontrol yapılamaz → "unknown".
 */
export async function checkSenderDomain(domain: string, resolver: TxtResolver = resolveTxt): Promise<DomainAuthStatus> {
  const notes: string[] = [];
  const txt = async (name: string) => {
    try {
      return (await resolver(name)).map((parts) => parts.join(""));
    } catch {
      return null;
    }
  };

  const root = await txt(domain);
  const spfRecords = (root ?? []).filter((r) => r.toLowerCase().startsWith("v=spf1"));
  let spf: DomainAuthStatus["spf"] = root === null ? "unknown" : spfRecords.length === 1 ? "pass" : spfRecords.length > 1 ? "fail" : "missing";
  if (spfRecords.length > 1) notes.push("Birden fazla SPF kaydı var; alıcılar bunu hata sayar. Tek kayıtta birleştirin.");
  if (spf === "pass" && /\+all\b/.test(spfRecords[0]!)) {
    spf = "fail";
    notes.push("SPF kaydı '+all' içeriyor — herkesin sizin adınıza göndermesine izin verir.");
  }
  if (spf === "missing") notes.push("SPF kaydı yok. E-posta sağlayıcınızın verdiği SPF kaydını DNS'e ekleyin.");

  const dmarcRecords = ((await txt(`_dmarc.${domain}`)) ?? []).filter((r) => r.toLowerCase().startsWith("v=dmarc1"));
  const dmarc: DomainAuthStatus["dmarc"] = dmarcRecords.length > 0 ? "pass" : "missing";
  if (dmarc === "missing") notes.push("DMARC kaydı yok. Toplu gönderimde Gmail/Yahoo DMARC ister: _dmarc TXT \"v=DMARC1; p=none\" ile başlayabilirsiniz.");

  notes.push("DKIM: sağlayıcınızın panelinde alan adı doğrulamasının 'verified' olduğunu kontrol edin.");
  return { spf, dkim: "unknown", dmarc, notes };
}
