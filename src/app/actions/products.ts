"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireTenant } from "@/server/tenancy/context";
import { parseForm, safeAction } from "@/server/actions/safe-action";
import { createProduct, deleteProduct, setProductActive, updateProduct, verifyProducts } from "@/server/services/products";
import { productSchema } from "@/lib/validation";
import type { ActionState } from "@/lib/action-state";

export async function saveProductAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const id = fd.get("id");
  const result = await safeAction(async () => {
    const ctx = await requireTenant();
    const input = parseForm(productSchema, fd);
    if (typeof id === "string" && id) await updateProduct(ctx, id, input);
    else await createProduct(ctx, input);
    revalidatePath("/products");
  });
  if (result.ok) redirect("/products");
  return result;
}

export async function verifyProductsAction(fd: FormData) {
  const ctx = await requireTenant();
  const ids = fd.getAll("productId").filter((v): v is string => typeof v === "string");
  await verifyProducts(ctx, ids);
  revalidatePath("/products");
}

export async function toggleProductAction(fd: FormData) {
  const ctx = await requireTenant();
  await setProductActive(ctx, String(fd.get("id")), fd.get("active") === "true");
  revalidatePath("/products");
}

export async function deleteProductAction(fd: FormData) {
  const ctx = await requireTenant();
  await deleteProduct(ctx, String(fd.get("id")));
  revalidatePath("/products");
  redirect("/products");
}
