import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Trash2 } from "lucide-react";
import { requireTenantPage } from "@/server/tenancy/context";
import { getProduct, listCategories } from "@/server/services/products";
import { deleteProductAction } from "@/app/actions/products";
import { isAppError } from "@/lib/errors";
import { specsToText } from "@/lib/validation";
import { Alert, Badge, Button, Card, CardBody, PageHeader } from "@/components/ui";
import { ProductForm } from "../product-form";

export const metadata: Metadata = { title: "Ürün" };

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireTenantPage();
  const { id } = await params;
  const product = await getProduct(ctx, id).catch((e: unknown) => {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  const categories = await listCategories(ctx);
  const pending = product.status === "PENDING";

  return (
    <>
      <PageHeader
        title={product.name}
        description={product.category?.name ?? undefined}
        actions={
          <form action={deleteProductAction}>
            <input type="hidden" name="id" value={product.id} />
            <Button type="submit" variant="danger" size="sm">
              <Trash2 className="size-4" aria-hidden /> Sil
            </Button>
          </form>
        }
      />
      {pending && (
        <Alert tone="warning" className="mb-4">
          Bu ürün bir dokümandan AI tarafından çıkarıldı ve onayınızı bekliyor. Bilgileri kontrol edip kaydettiğinizde onaylanır.
        </Alert>
      )}
      {product.documents.length > 0 && (
        <p className="mb-4 flex flex-wrap items-center gap-2 text-sm text-text-2">
          Kaynak doküman:
          {product.documents.map((d) => (
            <Link key={d.document.id} href="/knowledge"><Badge tone="accent">{d.document.title}</Badge></Link>
          ))}
        </p>
      )}
      <Card>
        <CardBody className="py-5">
          <ProductForm
            categories={categories.map((c) => c.name)}
            d={{
              id: product.id,
              name: product.name,
              sku: product.sku,
              categoryName: product.category?.name,
              description: product.description,
              technicalSpecsText: specsToText(product.technicalSpecs),
              materials: product.materials,
              dimensions: product.dimensions,
              applications: product.applications,
              industries: product.industries,
              minOrder: product.minOrder,
              priceRange: product.priceRange,
              deliveryTime: product.deliveryTime,
              certifications: product.certifications,
              active: pending ? true : product.active,
              pending,
            }}
          />
        </CardBody>
      </Card>
    </>
  );
}
