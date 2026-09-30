import type { Metadata } from "next";
import { requireTenantPage } from "@/server/tenancy/context";
import { assertCan } from "@/server/tenancy/permissions";
import { listProducts } from "@/server/services/products";
import { Card, CardBody, PageHeader } from "@/components/ui";
import { CampaignCreateForm } from "../campaign-forms";

export const metadata: Metadata = { title: "Yeni kampanya" };

export default async function NewCampaignPage() {
  const ctx = await requireTenantPage();
  assertCan(ctx, "campaign.write");
  const products = (await listProducts(ctx, { status: "VERIFIED" })).filter((p) => p.active);
  return (
    <>
      <PageHeader
        title="Yeni kampanya"
        description="Puan eşiğini geçen lead'ler kampanyaya alınır ve her adresin gönderim uygunluğu hemen kontrol edilir. Bu adım kredi harcamaz."
      />
      <Card className="max-w-2xl">
        <CardBody>
          <CampaignCreateForm products={products.map((p) => ({ id: p.id, name: p.name }))} />
        </CardBody>
      </Card>
    </>
  );
}
