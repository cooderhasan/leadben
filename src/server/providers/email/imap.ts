import "server-only";
import { ImapFlow } from "imapflow";
import { env } from "@/server/env";

export interface MailboxCursorState {
  uidValidity: bigint;
  lastUid: number;
}

export interface FetchedEmail {
  uid: number;
  source: Buffer;
}

/** Posta kutusundan yeni iletileri okuyan soyutlama (testlerde sahte okuyucu kullanılır). */
export interface MailboxReader {
  /** Posta kutusunu tanımlayan kalıcı anahtar (imleç kaydı için) */
  readonly key: string;
  /**
   * `cursor`dan sonraki iletileri UID sırasıyla döner. İmleç yoksa veya UIDVALIDITY değiştiyse
   * yalnızca son `firstRunDays` gün okunur (tüm geçmiş içe aktarılmaz).
   */
  read(cursor: MailboxCursorState | null, opts: { max: number; firstRunDays: number }): Promise<{ uidValidity: bigint; uidNext: number; messages: FetchedEmail[] }>;
}

const MAX_SOURCE_BYTES = 2_000_000;

export function isImapConfigured(): boolean {
  const e = env();
  return Boolean(e.IMAP_HOST && e.IMAP_USER && e.IMAP_PASS);
}

/**
 * IMAP okuyucu. Posta kutusu SALT OKUNUR (EXAMINE) açılır: okundu işareti konmaz, ileti silinmez/taşınmaz.
 */
export function createImapReader(): MailboxReader {
  const e = env();
  if (!e.IMAP_HOST || !e.IMAP_USER || !e.IMAP_PASS) throw new Error("IMAP yapılandırılmamış (IMAP_HOST / IMAP_USER / IMAP_PASS).");
  const host = e.IMAP_HOST;
  const user = e.IMAP_USER;
  const pass = e.IMAP_PASS;
  const mailbox = e.IMAP_MAILBOX;

  return {
    key: `imap:${user.toLowerCase()}@${host.toLowerCase()}/${mailbox}`,
    async read(cursor, { max, firstRunDays }) {
      const client = new ImapFlow({
        host,
        port: e.IMAP_PORT,
        secure: e.IMAP_SECURE,
        auth: { user, pass },
        logger: false,
        connectionTimeout: 20_000,
        greetingTimeout: 15_000,
        socketTimeout: 60_000,
        disableAutoIdle: true,
      });
      await client.connect();
      try {
        const box = await client.mailboxOpen(mailbox, { readOnly: true });
        const fresh = !cursor || cursor.uidValidity !== box.uidValidity;
        let uids: number[];
        if (fresh) {
          const found = await client.search({ since: new Date(Date.now() - firstRunDays * 86_400_000) }, { uid: true });
          uids = Array.isArray(found) ? found : [];
        } else {
          // "n:*" en az son iletiyi döner (UID'si küçük olsa bile) → aşağıda süzülür
          const found = await client.search({ uid: `${cursor.lastUid + 1}:*` }, { uid: true });
          uids = (Array.isArray(found) ? found : []).filter((u) => u > cursor.lastUid);
        }
        uids = [...new Set(uids)].sort((a, b) => a - b).slice(0, max);

        const messages: FetchedEmail[] = [];
        if (uids.length) {
          for await (const m of client.fetch(uids.join(","), { uid: true, source: { maxLength: MAX_SOURCE_BYTES } }, { uid: true })) {
            if (m.source) messages.push({ uid: m.uid, source: m.source });
          }
        }
        messages.sort((a, b) => a.uid - b.uid);
        return { uidValidity: box.uidValidity, uidNext: box.uidNext, messages };
      } finally {
        await client.logout().catch(() => client.close());
      }
    },
  };
}
