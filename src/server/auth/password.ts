import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

// Node'un yerleşik scrypt'i — native bağımlılık yok (Windows'ta sorunsuz).
// OWASP önerisine yakın parametreler: N=2^15, r=8, p=1
const PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } satisfies ScryptOptions;
const KEY_LEN = 64;

function scrypt(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize("NFKC"), salt, KEY_LEN, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** Biçim: scrypt$N$r$p$saltB64$hashB64 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, PARAMS);
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: PARAMS.maxmem,
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const PASSWORD_RULES = {
  minLength: 10,
  describe: "En az 10 karakter; harf ve rakam içermeli.",
};

export function validatePasswordStrength(password: string): string | null {
  if (password.length < PASSWORD_RULES.minLength) return `Parola en az ${PASSWORD_RULES.minLength} karakter olmalı.`;
  if (!/[a-zA-ZçğıöşüÇĞİÖŞÜ]/.test(password) || !/\d/.test(password)) return "Parola harf ve rakam içermeli.";
  return null;
}
