import "server-only";
import { rawDb } from "@/server/db";
import { createImapReader, isImapConfigured, type MailboxReader } from "@/server/providers/email/imap";
import { ingestRawEmail, type RawEmailOutcome } from "@/server/services/inbound-email";

const MAX_PER_POLL = 50;
/** İlk bağlantıda (veya posta kutusu sıfırlandığında) geriye dönük okunacak gün */
const FIRST_RUN_DAYS = 3;

let running = false;

export type PollResult = { skipped: true; reason: string } | { skipped: false; fetched: number; counts: Partial<Record<RawEmailOutcome | "error", number>> };

/**
 * Posta kutusundaki yeni iletileri okur ve gelen yanıtları ilgili şirketin konuşmasına ekler.
 * Son işlenen UID MailboxCursor'da tutulur; her ileti işlendikçe ilerler. Posta kutusu değiştirilmez.
 */
export async function pollMailbox(reader?: MailboxReader): Promise<PollResult> {
  if (!reader && !isImapConfigured()) return { skipped: true, reason: "not_configured" };
  if (running) return { skipped: true, reason: "already_running" };
  running = true;
  const r = reader ?? createImapReader();
  try {
    const row = await rawDb.mailboxCursor.findUnique({ where: { id: r.key } });
    const cursor = row ? { uidValidity: row.uidValidity, lastUid: row.lastUid } : null;

    let batch: Awaited<ReturnType<MailboxReader["read"]>>;
    try {
      batch = await r.read(cursor, { max: MAX_PER_POLL, firstRunDays: FIRST_RUN_DAYS });
    } catch (err) {
      const msg = (err as Error).message.slice(0, 500);
      console.warn("[imap] posta kutusu okunamadı:", msg);
      if (row) await rawDb.mailboxCursor.update({ where: { id: r.key }, data: { lastPollAt: new Date(), lastError: msg } });
      return { skipped: true, reason: "read_failed" };
    }

    const fresh = !cursor || cursor.uidValidity !== batch.uidValidity;
    // Yeni başlangıçta ileti yoksa imleç posta kutusunun sonuna konur (sonraki turda eski geçmiş okunmasın)
    let lastUid = fresh ? (batch.messages.length ? batch.messages[0]!.uid - 1 : Math.max(0, batch.uidNext - 1)) : cursor.lastUid;
    const save = () =>
      rawDb.mailboxCursor.upsert({
        where: { id: r.key },
        create: { id: r.key, uidValidity: batch.uidValidity, lastUid, lastPollAt: new Date() },
        update: { uidValidity: batch.uidValidity, lastUid, lastPollAt: new Date(), lastError: null },
      });

    const counts: Partial<Record<RawEmailOutcome | "error", number>> = {};
    for (const m of batch.messages) {
      let outcome: RawEmailOutcome | "error";
      try {
        outcome = await ingestRawEmail(m.source);
      } catch (err) {
        // Tek bozuk ileti okuyucuyu kilitlemesin: kaydedilir ve geçilir
        console.warn(`[imap] ileti işlenemedi (uid ${m.uid}):`, (err as Error).message);
        outcome = "error";
      }
      counts[outcome] = (counts[outcome] ?? 0) + 1;
      lastUid = Math.max(lastUid, m.uid);
      await save();
    }
    if (!batch.messages.length) await save();
    return { skipped: false, fetched: batch.messages.length, counts };
  } finally {
    running = false;
  }
}

/** Yönetim ekranı için son okuma durumu */
export async function mailboxStatus() {
  if (!isImapConfigured()) return null;
  const key = createImapReader().key;
  return rawDb.mailboxCursor.findUnique({ where: { id: key }, select: { lastPollAt: true, lastError: true } });
}
