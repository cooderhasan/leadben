"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { DocumentKind } from "@prisma/client";
import { requireTenant } from "@/server/tenancy/context";
import { safeAction } from "@/server/actions/safe-action";
import { deleteDocument, setDocumentVerified, uploadDocument } from "@/server/services/knowledge";
import { AppError } from "@/lib/errors";
import { isAIConfigured } from "@/server/ai";
import type { ActionState } from "@/lib/action-state";

const kinds = ["CATALOG", "PRODUCT_LIST", "PRICE_LIST", "TECHNICAL", "CERTIFICATE", "FAQ", "SALES_RULES", "CASE_STUDY", "OTHER"] as const;

export async function uploadDocumentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new AppError("VALIDATION", "Bir dosya seçin.", { file: "Dosya seçin" });
    const kind = z.enum(kinds).parse(fd.get("kind") ?? "OTHER") as DocumentKind;
    const title = typeof fd.get("title") === "string" ? String(fd.get("title")) : undefined;
    await uploadDocument(ctx, { name: file.name, size: file.size, bytes: Buffer.from(await file.arrayBuffer()) }, { title, kind });
    revalidatePath("/knowledge");
    return {
      ok: true,
      message: isAIConfigured()
        ? "Doküman yüklendi, işleniyor. Bitince ürünler ve bilgiler onayınıza sunulacak."
        : "Doküman arama için indeksleniyor. AI anahtarı tanımlı olmadığı için ürün çıkarımı yapılmayacak.",
    };
  });
}

export async function setDocumentVerifiedAction(fd: FormData) {
  const ctx = await requireTenant();
  await setDocumentVerified(ctx, String(fd.get("id")), fd.get("verified") === "true");
  revalidatePath("/knowledge");
}

export async function deleteDocumentAction(fd: FormData) {
  const ctx = await requireTenant();
  await deleteDocument(ctx, String(fd.get("id")));
  revalidatePath("/knowledge");
  revalidatePath("/products");
}
