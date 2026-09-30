import { execSync } from "node:child_process";
import { config } from "dotenv";

/** Test veritabanına migration'ları uygular (her test çalıştırmasında bir kez). */
export default function setup() {
  config();
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL tanımlı değil (.env). Entegrasyon testleri ayrı bir veritabanı gerektirir.");
  if (url === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL, DATABASE_URL ile aynı olamaz — testler veriyi siler.");
  execSync("npx prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
}
