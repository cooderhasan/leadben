import type { Metadata } from "next";
import Link from "next/link";
import { Radar } from "lucide-react";
import { requireTenantPage } from "@/server/tenancy/context";
import { listRecentSignals } from "@/server/services/leads";
import { Badge, Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { scoreTone } from "@/lib/lead-scoring";

export const metadata: Metadata = { title: "Sinyaller" };

const SIGNAL_LABELS: Record<string, string> = {
  NEW_FACILITY: "Yeni tesis",
  NEW_PRODUCTION_LINE: "Yeni üretim hattı",
  CAPACITY_EXPANSION: "Kapasite artışı",
  NEW_PRODUCT: "Yeni ürün",
  HIRING: "Personel alımı",
  INVESTMENT: "Yatırım",
  NEW_CUSTOMER: "Yeni müşteri",
  EXPORT_EXPANSION: "İhracat",
  MACHINE_INVESTMENT: "Makine yatırımı",
  LINE_CHANGE: "Hat değişikliği",
  SUPPLIER_SEARCH: "Tedarikçi arayışı",
  TENDER: "İhale",
  SOCIAL_ANNOUNCEMENT: "Duyuru",
  WEBSITE_CHANGE: "Site değişikliği",
  OTHER: "Diğer",
};

const fmt = (d: Date) => new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium" }).format(d);

export default async function SignalsPage() {
  const ctx = await requireTenantPage();
  const signals = await listRecentSignals(ctx);

  return (
    <>
      <PageHeader
        title="Sinyaller"
        description="Lead'lerinizde tespit edilen satın alma sinyalleri. Yalnızca kaynağında kanıtı bulunan gelişmeler listelenir."
      />
      <Card>
        {signals.length === 0 ? (
          <EmptyState
            icon={<Radar className="size-8" />}
            title="Henüz sinyal yok"
            description="Bir lead'i &quot;AI ile Analiz Et&quot; ile araştırdığınızda yatırım, yeni tesis, personel alımı gibi gelişmeler burada görünür."
            action={<LinkButton href="/leads">Leads&apos;e git</LinkButton>}
          />
        ) : (
          <ol className="divide-y divide-border">
            {signals.map((s) => (
              <li key={s.id} className="flex flex-col gap-1 px-5 py-4 sm:flex-row sm:items-start sm:gap-4">
                <div className="flex shrink-0 items-center gap-2 sm:w-44 sm:flex-col sm:items-start">
                  <Badge tone="accent">{SIGNAL_LABELS[s.type] ?? s.type}</Badge>
                  <span className="text-xs text-text-3">{fmt(s.publishedAt ?? s.detectedAt)}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text">{s.title}</p>
                  {s.description && <p className="mt-0.5 text-sm text-text-2">{s.description}</p>}
                  <p className="mt-1 text-xs text-text-3">
                    <Link href={`/leads/${s.lead.id}`} className="font-medium text-accent-text hover:underline">
                      {s.lead.companyName}
                    </Link>
                    {s.lead.city && ` · ${s.lead.city}`}
                  </p>
                </div>
                {s.lead.fitScore !== null && <Badge tone={scoreTone(s.lead.fitScore)}>{s.lead.fitScore}</Badge>}
              </li>
            ))}
          </ol>
        )}
      </Card>
    </>
  );
}
