import type { Metadata } from "next";
import Link from "next/link";
import { KanbanSquare } from "lucide-react";
import { requireTenantPage } from "@/server/tenancy/context";
import { can } from "@/server/tenancy/permissions";
import { listOpportunities, LOST_REASON_LABELS, OPEN_STAGES, pipelineSummary, STAGE_LABELS } from "@/server/services/crm";
import { decimalToNumber } from "@/server/services/company";
import { Badge, Card, EmptyState, PageHeader, Stat, CardBody } from "@/components/ui";
import { formatMoney } from "@/lib/cn";
import { OpportunityForm } from "./crm-forms";
import { ActionButton } from "@/components/action-button";
import { startProposalAction } from "@/app/actions/proposals";

export const metadata: Metadata = { title: "Satış hunisi" };

const toDateInput = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export default async function PipelinePage() {
  const ctx = await requireTenantPage();
  const [opps, summary] = await Promise.all([listOpportunities(ctx), pipelineSummary(ctx)]);
  const canWrite = can(ctx, "lead.write");
  const openValue = summary.filter((s) => OPEN_STAGES.includes(s.stage)).reduce((a, s) => a + s.value, 0);
  const won = summary.find((s) => s.stage === "WON");
  const lost = summary.find((s) => s.stage === "LOST");
  const closed = (won?.count ?? 0) + (lost?.count ?? 0);

  return (
    <>
      <PageHeader
        title="Satış hunisi"
        description="Olumlu yanıtlar otomatik fırsata dönüşür. Tutarı ve aşamayı siz güncellersiniz — AI tutar tahmin etmez."
      />
      <Card className="mb-6">
        <CardBody className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Açık fırsat" value={summary.filter((s) => OPEN_STAGES.includes(s.stage)).reduce((a, s) => a + s.count, 0)} />
          <Stat label="Açık tutar (girilen)" value={formatMoney(openValue)} />
          <Stat label="Kazanılan" value={won?.count ?? 0} sub={won?.value ? formatMoney(won.value) : undefined} />
          <Stat label="Kazanma oranı" value={closed ? `%${Math.round(((won?.count ?? 0) / closed) * 100)}` : "—"} sub={closed ? `${closed} kapanan fırsat` : "Henüz kapanan yok"} />
        </CardBody>
      </Card>

      {opps.length === 0 ? (
        <Card>
          <EmptyState
            icon={<KanbanSquare className="size-8" />}
            title="Henüz fırsat yok"
            description="Kampanyalara ilgi, teklif veya görüşme talebiyle yanıt geldiğinde fırsatlar burada oluşur. Lead sayfasından elle de ekleyebilirsiniz."
          />
        </Card>
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
          <div className="grid min-w-[1100px] grid-cols-8 gap-3">
            {(Object.keys(STAGE_LABELS) as Array<keyof typeof STAGE_LABELS>).map((stage) => {
              const col = opps.filter((o) => o.stage === stage);
              return (
                <section key={stage} className="flex min-w-0 flex-col gap-2" aria-label={STAGE_LABELS[stage]}>
                  <header className="flex items-center justify-between px-1">
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-text-2">{STAGE_LABELS[stage]}</h2>
                    <Badge>{col.length}</Badge>
                  </header>
                  {col.map((o) => (
                    <Card key={o.id} className="p-3">
                      <Link href={`/leads/${o.lead.id}`} className="block truncate text-sm font-medium text-text hover:text-accent">{o.lead.companyName}</Link>
                      <p className="truncate text-xs text-text-3">
                        {[o.lead.city, o.value ? formatMoney(decimalToNumber(o.value)) : null].filter(Boolean).join(" · ") || "Tutar girilmedi"}
                      </p>
                      {o._count.tasks > 0 && <p className="mt-1 text-xs text-warning">{o._count.tasks} açık görev</p>}
                      {o.stage === "LOST" && o.lostReason && <p className="mt-1 text-xs text-text-3">{LOST_REASON_LABELS[o.lostReason]}</p>}
                      {canWrite && (o.stage === "INTERESTED" || o.stage === "QUOTE" || o.stage === "NEGOTIATION") && (
                        <div className="mt-2">
                          <ActionButton action={startProposalAction} fields={{ opportunityId: o.id }} variant="secondary" pendingText="Açılıyor…">
                            Teklif hazırla
                          </ActionButton>
                        </div>
                      )}
                      {canWrite && (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-xs text-accent-text">Düzenle</summary>
                          <div className="mt-2">
                            <OpportunityForm
                              id={o.id}
                              stage={o.stage}
                              value={decimalToNumber(o.value)}
                              probability={o.probability}
                              expectedCloseAt={toDateInput(o.expectedCloseAt)}
                              lostReason={o.lostReason}
                            />
                          </div>
                        </details>
                      )}
                    </Card>
                  ))}
                </section>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
