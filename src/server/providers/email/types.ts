/**
 * E-posta sağlayıcı sözleşmesi (spec §24, §94). Uygulamalar Faz 3'te:
 * SMTPProvider, ResendProvider, BrevoProvider, SendGridProvider.
 *
 * Gönderim ÖNCESİ zorunlu kontroller EmailProvider'ın değil, gönderim servisinin sorumluluğudur:
 * compliance status, suppression listesi, ret (unsubscribe) bağlantısı, gönderici kimliği, insan onayı.
 * Sağlayıcı yalnızca teknik gönderimi yapar.
 */
export interface OutgoingEmail {
  from: { email: string; name?: string };
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  /** RFC 8058 List-Unsubscribe başlıkları için zorunlu */
  unsubscribeUrl: string;
  headers?: Record<string, string>;
  /** Webhook eşleştirmesi için dahili mesaj ID'si */
  messageId: string;
}

export interface SendResult {
  providerMessageId: string;
  accepted: boolean;
}

export interface DomainAuthStatus {
  spf: "pass" | "fail" | "missing" | "unknown";
  dkim: "pass" | "fail" | "missing" | "unknown";
  dmarc: "pass" | "fail" | "missing" | "unknown";
  notes: string[];
}

export interface EmailProvider {
  readonly name: string;
  send(email: OutgoingEmail): Promise<SendResult>;
  /** SPF/DKIM/DMARC kontrolü (spec §58) */
  checkDomain?(domain: string): Promise<DomainAuthStatus>;
}
