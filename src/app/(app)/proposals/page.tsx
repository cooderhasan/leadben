import type { Metadata } from "next";
import Link from "next/link";
import { FileText } from "lucide-react";
import { requireTenantPage } from "@/server/tenancy/context";
import { listProposals, PROPOSAL_STATUS_LABELS } from "@/server/services/proposals";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Teklifler" };

const fmt = (d: Date) => new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium" }).format(d);

export default async function ProposalsPage() {
  const ctx = await requireTenantPage();
  const proposals = await listProposals(ctx);
  return (
    <>
      <PageHeader
        title="Teklifler"
        description="AI müşteri talebini onaylı ürünlerinizle eşleştirir; fiyatları siz girersiniz ve yönetici onaylar. Yeni teklif Pipeline veya lead sayfasından başlatılır."
      />
      <Card>
        {proposals.length === 0 ? (
          <EmptyState icon={<FileText className="size-8" />} title="Henüz teklif yok" description="Pipeline'daki bir fırsatta veya lead sayfasında &quot;Teklif hazırla&quot;ya basın." />
        ) : (
          <ul className="divide-y divide-border">
            {proposals.map((p) => (
              <li key={p.id}>
                <Link href={`/proposals/${p.id}`} className="flex flex-wrap items-center gap-3 px-5 py-3 hover:bg-surface-2">
                  <span className="font-mono text-xs text-text-3">{p.number}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{p.lead.companyName}</span>
                  <span className="text-sm tabular-nums text-text-2">
                    {p.totalAmount != null ? new Intl.NumberFormat("tr-TR", { style: "currency", currency: p.currency }).format(Number(p.totalAmount)) : "—"}
                  </span>
                  <Badge tone={p.status === "ACCEPTED" ? "success" : p.status === "REJECTED" ? "danger" : p.status === "DRAFT" ? "neutral" : "accent"}>{PROPOSAL_STATUS_LABELS[p.status]}</Badge>
                  <span className="text-xs text-text-3">{fmt(p.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
