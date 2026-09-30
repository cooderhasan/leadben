import type { Metadata } from "next";
import { requireTenantPage } from "@/server/tenancy/context";
import { getCompanyOverview } from "@/server/services/company";
import { roleLabel } from "@/server/tenancy/permissions";
import { Badge, Card, CardBody, CardHeader, LinkButton } from "@/components/ui";
import { formatDate } from "@/lib/cn";

export const metadata: Metadata = { title: "Ayarlar" };

const PLAN: Record<string, string> = { STARTER: "Starter", GROWTH: "Growth", PRO: "Pro" };
const SUB: Record<string, string> = { TRIALING: "Deneme", ACTIVE: "Aktif", PAST_DUE: "Ödeme gecikti", CANCELLED: "İptal" };

export default async function SettingsPage() {
  const ctx = await requireTenantPage();
  const { company } = await getCompanyOverview(ctx);
  const sub = company.subscription;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader title="Şirket" action={<LinkButton href="/onboarding?step=company&return=/settings" size="sm" variant="secondary">Düzenle</LinkButton>} />
        <CardBody className="flex flex-col gap-2 text-sm">
          <p><span className="text-text-2">Ad:</span> {company.name}</p>
          <p><span className="text-text-2">Web sitesi:</span> {company.website ?? "—"}</p>
          <p><span className="text-text-2">Rolünüz:</span> {roleLabel(ctx.role)}</p>
          <p><span className="text-text-2">Oluşturulma:</span> {formatDate(company.createdAt)}</p>
          <p className="pt-2">
            <LinkButton href="/onboarding?step=website" size="sm" variant="ghost">Kurulum sihirbazını tekrar aç</LinkButton>
          </p>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Plan" />
        <CardBody className="flex flex-col gap-2 text-sm">
          <p className="flex items-center gap-2">
            <span className="text-base font-semibold">{PLAN[sub?.plan ?? "STARTER"]}</span>
            <Badge tone="accent">{SUB[sub?.status ?? "TRIALING"]}</Badge>
          </p>
          <p className="text-text-2">Aylık kredi: {sub?.monthlyCredits ?? 0} · Lead limiti: {sub?.leadLimit ?? 0}</p>
          <p className="text-xs text-text-3">
            Ödeme entegrasyonu (Stripe / iyzico / PayTR) sonraki fazda eklenecek. Mimari hazır: Subscription.provider alanı.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
