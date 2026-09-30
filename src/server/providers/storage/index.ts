import "server-only";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/server/env";

export interface StorageProvider {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

class LocalStorage implements StorageProvider {
  constructor(private readonly root: string) {}

  private resolve(key: string) {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error("Geçersiz depolama anahtarı");
    return full;
  }
  async put(key: string, body: Buffer) {
    const p = this.resolve(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, body);
  }
  async get(key: string) {
    return readFile(this.resolve(key));
  }
  async delete(key: string) {
    await rm(this.resolve(key), { force: true });
  }
}

class S3Storage implements StorageProvider {
  private clientPromise: Promise<import("@aws-sdk/client-s3").S3Client>;
  constructor(private readonly bucket: string) {
    this.clientPromise = import("@aws-sdk/client-s3").then(({ S3Client }) => {
      const e = env();
      return new S3Client({
        region: e.S3_REGION,
        endpoint: e.S3_ENDPOINT,
        forcePathStyle: true,
        credentials:
          e.S3_ACCESS_KEY_ID && e.S3_SECRET_ACCESS_KEY
            ? { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY }
            : undefined,
      });
    });
  }
  async put(key: string, body: Buffer, contentType: string) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.clientPromise).send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }
  async get(key: string) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const res = await (await this.clientPromise).send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) throw new Error("Dosya bulunamadı");
    return Buffer.from(bytes);
  }
  async delete(key: string) {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    await (await this.clientPromise).send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

let instance: StorageProvider | undefined;

export function storage(): StorageProvider {
  if (!instance) {
    const e = env();
    instance = e.STORAGE_DRIVER === "s3" ? new S3Storage(e.S3_BUCKET) : new LocalStorage(path.resolve(e.STORAGE_LOCAL_DIR));
  }
  return instance;
}

/** Tenant önekli, tahmin edilemez depolama anahtarı. */
export function newStorageKey(companyId: string, folder: string, filename: string): string {
  const ext = path.extname(filename).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 10);
  return `${companyId}/${folder}/${randomBytes(16).toString("hex")}${ext}`;
}
