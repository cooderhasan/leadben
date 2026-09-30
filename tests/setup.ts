import { config } from "dotenv";

config();
// Tüm testler ayrı test veritabanını kullanır
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
(process.env as Record<string, string>).NODE_ENV = "test";
process.env.QUEUE_DRIVER = "inline";
process.env.STORAGE_DRIVER = "local";
process.env.STORAGE_LOCAL_DIR = "./storage-test";
process.env.WEB_FETCH_ALLOW_PRIVATE = "1";
process.env.EMBEDDING_PROVIDER = "none";
process.env.SIGNUP_CREDITS = "100";
