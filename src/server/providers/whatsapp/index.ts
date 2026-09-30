import "server-only";
import { AppError } from "@/lib/errors";

/**
 * WhatsApp Business — yalnızca Meta'nın resmi Cloud API'si (graph.facebook.com).
 * Kullanıcı şifresi veya WhatsApp Web oturumu hiçbir yerde istenmez / kullanılmaz.
 */
export interface WhatsAppCredentials {
  phoneNumberId: string;
  wabaId: string;
  accessToken: string;
}

export interface WhatsAppTemplate {
  name: string;
  language: string;
  status: string;
  category: string;
  /** Gövdedeki {{1}}, {{2}} parametre sayısı */
  bodyParams: number;
  bodyText: string;
}

export interface WhatsAppProvider {
  getPhoneInfo(): Promise<{ displayPhone: string; verifiedName: string }>;
  sendText(to: string, body: string): Promise<{ id: string }>;
  sendTemplate(to: string, name: string, language: string, params: string[]): Promise<{ id: string }>;
  listTemplates(): Promise<WhatsAppTemplate[]>;
}

const GRAPH = "https://graph.facebook.com/v21.0";

class MetaCloudProvider implements WhatsAppProvider {
  constructor(private readonly c: WhatsAppCredentials) {}

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${GRAPH}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.c.accessToken}`, "content-type": "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg;
      } catch {
        /* düz metin */
      }
      const err = new AppError("EXTERNAL_FETCH", `WhatsApp API hatası (${res.status}): ${msg}`);
      (err as AppError & { retryable?: boolean }).retryable = res.status >= 500 || res.status === 429;
      throw err;
    }
    return JSON.parse(text) as T;
  }

  async getPhoneInfo() {
    const r = await this.call<{ display_phone_number: string; verified_name: string }>(`/${this.c.phoneNumberId}?fields=display_phone_number,verified_name`);
    return { displayPhone: r.display_phone_number, verifiedName: r.verified_name };
  }

  async sendText(to: string, body: string) {
    const r = await this.call<{ messages: Array<{ id: string }> }>(`/${this.c.phoneNumberId}/messages`, {
      method: "POST",
      body: JSON.stringify({ messaging_product: "whatsapp", to: to.replace(/^\+/, ""), type: "text", text: { body, preview_url: false } }),
    });
    return { id: r.messages[0]?.id ?? "" };
  }

  async sendTemplate(to: string, name: string, language: string, params: string[]) {
    const r = await this.call<{ messages: Array<{ id: string }> }>(`/${this.c.phoneNumberId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: to.replace(/^\+/, ""),
        type: "template",
        template: {
          name,
          language: { code: language },
          components: params.length ? [{ type: "body", parameters: params.map((p) => ({ type: "text", text: p })) }] : [],
        },
      }),
    });
    return { id: r.messages[0]?.id ?? "" };
  }

  async listTemplates() {
    const r = await this.call<{ data: Array<{ name: string; language: string; status: string; category: string; components?: Array<{ type: string; text?: string }> }> }>(
      `/${this.c.wabaId}/message_templates?fields=name,language,status,category,components&limit=100`,
    );
    return r.data
      .filter((t) => t.status === "APPROVED")
      .map((t) => {
        const body = t.components?.find((c) => c.type === "BODY")?.text ?? "";
        return { name: t.name, language: t.language, status: t.status, category: t.category, bodyText: body, bodyParams: new Set(body.match(/\{\{\d+\}\}/g) ?? []).size };
      });
  }
}

let override: ((c: WhatsAppCredentials) => WhatsAppProvider) | null = null;

/** Yalnızca testlerde kullanılır. */
export function __setWhatsAppProviderForTests(factory: ((c: WhatsAppCredentials) => WhatsAppProvider) | null) {
  override = factory;
}

export function whatsappProvider(c: WhatsAppCredentials): WhatsAppProvider {
  return override ? override(c) : new MetaCloudProvider(c);
}
