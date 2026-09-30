import type { Metadata } from "next";
import { requireTenantPage } from "@/server/tenancy/context";
import { assertCan } from "@/server/tenancy/permissions";
import { Card, CardBody, PageHeader } from "@/components/ui";
import { ManualLeadForm } from "../lead-forms";

export const metadata: Metadata = { title: "Lead ekle" };

export default async function NewLeadPage() {
  const ctx = await requireTenantPage();
  assertCan(ctx, "lead.write");
  return (
    <>
      <PageHeader
        title="Lead ekle"
        description="Aynı alan adı, telefon veya firma adı + şehir ile kayıtlı bir lead varsa yeni kayıt açılmaz; eksik bilgiler tamamlanır."
      />
      <Card className="max-w-2xl">
        <CardBody>
          <ManualLeadForm />
        </CardBody>
      </Card>
    </>
  );
}
