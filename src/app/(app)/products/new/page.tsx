import type { Metadata } from "next";
import { requireTenantPage } from "@/server/tenancy/context";
import { listCategories } from "@/server/services/products";
import { Card, CardBody, PageHeader } from "@/components/ui";
import { ProductForm } from "../product-form";

export const metadata: Metadata = { title: "Yeni ürün" };

export default async function NewProductPage() {
  const ctx = await requireTenantPage();
  const categories = await listCategories(ctx);
  return (
    <>
      <PageHeader title="Yeni ürün" description="Elle eklediğiniz ürünler şirketinizin beyanı olarak doğrudan onaylı kabul edilir." />
      <Card>
        <CardBody className="py-5">
          <ProductForm d={{ active: true }} categories={categories.map((c) => c.name)} />
        </CardBody>
      </Card>
    </>
  );
}
