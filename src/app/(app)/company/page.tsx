import type { Metadata } from "next";
import Link from "next/link";
import { Pencil, RefreshCw } from "lucide-react";
import { requireTenantPage } from "@/server/tenancy/context";
import { getCompanyOverview, decimalToNumber } from "@/server/services/company";
import { listFacts } from "@/server/services/facts";
import { getLatestOwnAnalysis } from "@/server/services/website-analysis";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { FactReview, SummaryCard } from "@/components/fact-review";
import { FactAddButton, FactEditButton, FactRemoveButton } from "@/components/fact-editors";
import { JobPoller } from "@/components/job-poller";
import { Badge, Card, CardBody, CardHeader, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { FACT_GROUP_ORDER, FACT_KEYS, FACT_SOURCE_LABELS, factGroup, factLabel } from "@/lib/facts";
import { formatDateTime, formatMoney } from "@/lib/cn";

export const metadata: Metadata = { title: "Şirketim" };

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  const empty = value == null || value === "" || (Array.isArray(value) && value.length === 0);
  return (
    <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 py-2 text-sm">
      <dt className="text-text-2">{label}</dt>
      <dd className={empty ? "text-text-3" : "text-text"}>{empty ? "—" : Array.isArray(value) ? value.join(", ") : value}</dd>
    </div>
  );
}

function Section({ title, step, children }: { title: string; step: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader
        title={title}
        action={
          <Link href={`/onboarding?step=${step}&return=/company`} className="inline-flex items-center gap-1 text-sm text-accent hover:underline">
            <Pencil className="size-3.5" aria-hidden /> Düzenle
          </Link>
        }
      />
      <CardBody className="py-2">
        <dl className="divide-y divide-border">{children}</dl>
      </CardBody>
    </Card>
  );
}

export default async function CompanyPage() {
  const ctx = await requireTenantPage();
  const [overview, pending, verified, analysis] = await Promise.all([
    getCompanyOverview(ctx),
    listFacts(ctx, "PENDING"),
    listFacts(ctx, "VERIFIED"),
    getLatestOwnAnalysis(ctx),
  ]);
  const { company } = overview;
  const p = company.profile;
  const target = overview.targetMarkets.find((t) => !t.isExcluded);
  const excluded = overview.targetMarkets.find((t) => t.isExcluded);
  const running = analysis && (analysis.status === "QUEUED" || analysis.status === "RUNNING");
  const job = running ? await tenantDb(ctx).websiteAnalysis.findUnique({ where: { id: analysis.id }, select: { jobId: true } }) : null;

  const verifiedByGroup = new Map<string, typeof verified>();
  for (const f of verified) verifiedByGroup.set(factGroup(f.key), [...(verifiedByGroup.get(factGroup(f.key)) ?? []), f]);

  return (
    <>
      <PageHeader
        title="Şirketim"
        description="AI'ın şirketiniz hakkında bildikleri. Yalnızca onaylı bilgiler satış iletişiminde kullanılır."
        actions={
          <LinkButton href="/onboarding?step=website&return=/company" variant="secondary">
            <RefreshCw className="size-4" aria-hidden /> Web sitesini yeniden analiz et
          </LinkButton>
        }
      />

      <div className="flex flex-col gap-6">
        {running && job?.jobId && <JobPoller jobId={job.jobId} label="Web sitesi analiz ediliyor…" />}

        {p?.aiSummary ? (
          <SummaryCard summary={p.aiSummary} status={p.aiSummaryStatus} />
        ) : (
          <Card>
            <EmptyState
              title="Henüz AI özeti yok"
              description="Web sitenizi analiz ettirin; AI sizi nasıl anladığını özetlesin, siz onaylayın."
              action={<LinkButton href="/onboarding?step=website&return=/company">Web sitemi analiz et</LinkButton>}
            />
          </Card>
        )}

        {pending.length > 0 && (
          <section>
            <div className="mb-3 flex items-center gap-2">
              <h2 className="text-base font-semibold">Onayınızı bekleyen bulgular</h2>
              <Badge tone="warning">{pending.length}</Badge>
            </div>
            <FactReview facts={pending} />
          </section>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          <Section title="Firma bilgileri" step="company">
            <Row label="Firma adı" value={company.name} />
            <Row label="Web sitesi" value={company.website} />
            <Row label="Sektör" value={p?.sector} />
            <Row label="Alt sektör" value={p?.subSector} />
            <Row label="Konum" value={[company.city, company.country].filter(Boolean).join(", ")} />
            <Row label="Hizmet bölgeleri" value={p?.serviceRegions} />
            <Row label="Büyüklük" value={p?.employeeCount ? `${p.employeeCount} çalışan` : p?.sizeBand} />
          </Section>
          <Section title="Üretim" step="products">
            <Row label="Minimum sipariş" value={p?.minOrder} />
            <Row label="Teslim süresi" value={p?.deliveryTime} />
            <Row label="Üretim kapasitesi" value={p?.productionCapacity} />
            <Row label="Özel üretim" value={p?.customManufacturing == null ? null : p.customManufacturing ? "Evet" : "Hayır"} />
            <Row label="Ort. sipariş tutarı" value={p?.avgOrderValue ? formatMoney(decimalToNumber(p.avgOrderValue), p.currency) : null} />
          </Section>
          <Section title="Hedef müşteri" step="target">
            <Row label="Model" value={target?.businessModel} />
            <Row label="Sektörler" value={target?.industries} />
            <Row label="Alt sektörler" value={target?.subIndustries} />
            <Row label="Bölge" value={[...(target?.cities ?? []), ...(target?.countries ?? [])]} />
            <Row label="Çalışan" value={target?.minEmployees ? `${target.minEmployees}+` : null} />
            <Row label="Karar vericiler" value={target?.decisionMakerRoles} />
          </Section>
          <Section title="Satış" step="sales">
            <Row label="Ortalama satış" value={p?.avgSaleValue ? formatMoney(decimalToNumber(p.avgSaleValue), p.currency) : null} />
            <Row label="Satış döngüsü" value={p?.salesCycleDays ? `${p.salesCycleDays} gün` : null} />
            <Row label="Aylık hedef" value={p?.monthlySalesTarget ? formatMoney(decimalToNumber(p.monthlySalesTarget), p.currency) : null} />
            <Row label="Mevcut müşteri tipleri" value={p?.existingCustomerTypes} />
          </Section>
          <Section title="İstenmeyen müşteriler" step="exclusions">
            <Row label="Sektörler" value={excluded?.industries} />
            <Row label="Şehirler" value={excluded?.cities} />
            <Row label="Müşteri tipleri" value={excluded?.customerTypes} />
            <Row label="Satış kuralları" value={overview.memories ? <Link href="/settings/memory" className="text-accent hover:underline">{overview.memories} aktif kural</Link> : null} />
          </Section>
        </div>

        <section>
          <h2 className="mb-3 text-base font-semibold">Onaylı bilgiler</h2>
          {verified.length === 0 && (
            <p className="mb-3 text-sm text-text-2">Henüz onaylı bilgi yok. AI bulgularını onayladıkça veya aşağıdan elle ekledikçe burada görünür.</p>
          )}
          {(
            <div className="grid gap-4 lg:grid-cols-2">
              {[...FACT_GROUP_ORDER, "Diğer"].filter((g) => verifiedByGroup.has(g) || ADDABLE_GROUPS.includes(g)).map((g) => (
                <Card key={g}>
                  <CardHeader title={g} action={<FactAddButton keys={keysOfGroup(g)} />} />
                  {!verifiedByGroup.has(g) && <p className="px-5 py-3 text-sm text-text-3">Henüz bilgi yok.</p>}
                  <ul className="divide-y divide-border">
                    {(verifiedByGroup.get(g) ?? []).map((f) => (
                      <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5">
                        <div className="min-w-0 flex-1">
                          <p className="text-xs text-text-3">{factLabel(f.key)} · {FACT_SOURCE_LABELS[f.source]}</p>
                          <p className="text-sm text-text">{f.value}</p>
                        </div>
                        <FactEditButton factId={f.id} value={f.value} />
                        <FactRemoveButton factId={f.id} value={f.value} />
                      </li>
                    ))}
                  </ul>
                </Card>
              ))}
            </div>
          )}
        </section>

        {analysis && (
          <p className="text-xs text-text-3">
            Son web sitesi analizi: {analysis.url} · {formatDateTime(analysis.createdAt)} ·{" "}
            {{ QUEUED: "sırada", RUNNING: "çalışıyor", COMPLETED: "tamamlandı", FAILED: "başarısız" }[analysis.status]}
          </p>
        )}
      </div>
    </>
  );
}

/** Boşken de gösterilen (elle bilgi eklenebilen) gruplar */
const ADDABLE_GROUPS: string[] = ["Genel", "Ürünler", "Üretim ve kalite", "Hedef pazar", "Satış argümanları"];

function keysOfGroup(group: string) {
  return Object.entries(FACT_KEYS)
    .filter(([, v]) => v.group === group)
    .map(([key, v]) => ({ key, label: v.label }));
}
