import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "@/server/env";
import { AppError } from "@/lib/errors";

/**
 * Şirketlere ait API anahtarlarını (WhatsApp erişim anahtarı vb.) veritabanında şifreli saklar.
 * AES-256-GCM; anahtar ENCRYPTION_KEY'den türetilir. Düz metin anahtar hiçbir yerde loglanmaz / gösterilmez.
 */
function key(): Buffer {
  const k = env().ENCRYPTION_KEY;
  if (!k || k.length < 16) {
    if (env().NODE_ENV === "production") {
      throw new AppError("VALIDATION", "ENCRYPTION_KEY tanımlı değil (en az 16 karakter). Gizli anahtarlar kaydedilemez.");
    }
    return createHash("sha256").update("dev-only-encryption-key-change-me").digest();
  }
  return createHash("sha256").update(k).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), enc.toString("base64url")].join(":");
}

export function decryptSecret(payload: string): string {
  const [v, iv, tag, data] = payload.split(":");
  if (v !== "v1" || !iv || !tag || !data) throw new AppError("VALIDATION", "Şifreli anahtar okunamadı.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new AppError("VALIDATION", "Şifreli anahtar çözülemedi (ENCRYPTION_KEY değişmiş olabilir). Anahtarı yeniden girin.");
  }
}

/** Ekranda göstermek için: "EAAG…x9Qz" */
export function maskSecret(s: string): string {
  return s.length <= 8 ? "••••" : `${s.slice(0, 4)}…${s.slice(-4)}`;
}
