import type { Metadata } from "next";
import Link from "next/link";
import { Megaphone, Plus } from "lucide-react";
import { requireTenantPage } from "@/server/tenancy/context";
import { can } from "@/server/tenancy/permissions";
import { CAMPAIGN_STATUS_LABELS, listCampaigns } from "@/server/services/campaigns";
import { Badge, Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Kampanyalar" };

const fmt = (d: Date) => new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium" }).format(d);

export default async function CampaignsPage() {
  const ctx = await requireTenantPage();
  const campaigns = await listCampaigns(ctx);
  const canWrite = can(ctx, "campaign.write");

  return (
    <>
      <PageHeader
        title="Kampanyalar"
        description="AI strateji ve mesajları hazırlar; her mesaj ve kampanya sizin onayınızla gönderilir."
        actions={
          canWrite ? (
            <LinkButton href="/campaigns/new">
              <Plus className="size-4" aria-hidden /> Yeni kampanya
            </LinkButton>
          ) : undefined
        }
      />
      <Card>
        {campaigns.length === 0 ? (
          <EmptyState
            icon={<Megaphone className="size-8" />}
            title="Henüz kampanya yok"
            description="Önce Leads ekranında lead bulup puanlayın; ardından yüksek puanlı lead'lerle kampanya oluşturun."
            action={canWrite ? <LinkButton href="/campaigns/new">Kampanya oluştur</LinkButton> : undefined}
          />
        ) : (
          <ul className="divide-y divide-border">
            {campaigns.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <Link href={`/campaigns/${c.id}`} className="font-medium text-text hover:text-accent">{c.name}</Link>
                  <p className="truncate text-xs text-text-3">{c.targetDescription}</p>
                </div>
                <span className="text-xs text-text-2">{c._count.leads} lead · {c._count.messages} mesaj</span>
                <span className="text-xs text-text-3">{fmt(c.createdAt)}</span>
                <Badge tone={c.status === "RUNNING" ? "accent" : c.status === "COMPLETED" ? "success" : c.status === "PAUSED" ? "warning" : "neutral"}>
                  {CAMPAIGN_STATUS_LABELS[c.status]}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
