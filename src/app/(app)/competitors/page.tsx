import type { Metadata } from "next";
import { Eye, EyeOff, Radar, ScanSearch, Swords } from "lucide-react";
import { requireTenantPage } from "@/server/tenancy/context";
import { can } from "@/server/tenancy/permissions";
import { isAIConfigured } from "@/server/ai";
import { listCompetitors } from "@/server/services/competitors";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { deleteCompetitorAction } from "@/app/actions/onboarding";
import { scanCompetitorAction, toggleMonitoringAction } from "@/app/actions/competitors";
import { CompetitorForm, DeleteIcon } from "@/app/onboarding/steps";
import { ActionButton } from "@/components/action-button";
import { JobPoller } from "@/components/job-poller";
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Rakipler" };

const SIGNAL_LABELS: Record<string, string> = {
  NEW_FACILITY: "Yeni tesis",
  NEW_PRODUCTION_LINE: "Yeni hat",
  CAPACITY_EXPANSION: "Kapasite",
  NEW_PRODUCT: "Yeni ürün",
  HIRING: "Personel alımı",
  INVESTMENT: "Yatırım",
  NEW_CUSTOMER: "Yeni müşteri",
  EXPORT_EXPANSION: "İhracat",
  MACHINE_INVESTMENT: "Makine",
  LINE_CHANGE: "Hat değişikliği",
  SUPPLIER_SEARCH: "Tedarikçi arayışı",
  TENDER: "İhale",
  SOCIAL_ANNOUNCEMENT: "Duyuru",
  WEBSITE_CHANGE: "Site değişikliği",
  OTHER: "Diğer",
};
const fmt = (d: Date) => new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium" }).format(d);

export default async function CompetitorsPage() {
  const ctx = await requireTenantPage();
  const [competitors, jobs] = await Promise.all([
    listCompetitors(ctx),
    tenantDb(ctx).job.findMany({ where: { type: "competitor.scan", status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true, payload: true } }),
  ]);
  const running = new Map(jobs.map((j) => [(j.payload as { competitorId?: string }).competitorId, j.id]));
  const canManage = can(ctx, "company.update");
  const canScan = can(ctx, "company.analyze") && isAIConfigured();

  return (
    <>
      <PageHeader
        title="Rakipler"
        description="İzlemesi açık rakiplerin sitesi haftada bir taranır; yalnızca son taramadan bu yana EKLENEN metinden, kanıtıyla gelişme çıkarılır. Tarama 2 kredi; değişiklik yoksa iade edilir."
      />
      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <div className="flex flex-col gap-4">
          {competitors.length === 0 ? (
            <Card>
              <EmptyState icon={<Swords className="size-8" />} title="Henüz rakip eklenmedi" />
            </Card>
          ) : (
            competitors.map((c) => {
              const profile = (c.lastScan?.result ?? null) as { products?: string[]; claims?: Array<{ statement: string; evidence: string }> } | null;
              const jobId = running.get(c.id);
              return (
                <Card key={c.id}>
                  <CardHeader
                    title={
                      <span className="inline-flex flex-wrap items-center gap-2">
                        {c.name}
                        {c.monitoring ? <Badge tone="success"><Eye className="size-3" aria-hidden /> İzleniyor</Badge> : <Badge>İzlenmiyor</Badge>}
                      </span>
                    }
                    description={[c.website, c.lastScan?.completedAt ? `son tarama ${fmt(c.lastScan.completedAt)}` : "henüz taranmadı"].filter(Boolean).join(" · ")}
                    action={
                      canManage ? (
                        <form action={deleteCompetitorAction}>
                          <input type="hidden" name="id" value={c.id} />
                          <Button type="submit" size="sm" variant="ghost" aria-label={`${c.name} sil`}><DeleteIcon /></Button>
                        </form>
                      ) : undefined
                    }
                  />
                  <CardBody className="flex flex-col gap-3 text-sm">
                    {jobId && <JobPoller jobId={jobId} label="Rakip sitesi taranıyor…" />}
                    {(c.strengths.length > 0 || c.weaknesses.length > 0) && (
                      <div className="grid gap-1 text-xs sm:grid-cols-2">
                        {c.strengths.length > 0 && <p><span className="text-success">Güçlü (sizin notunuz):</span> <span className="text-text-2">{c.strengths.join(", ")}</span></p>}
                        {c.weaknesses.length > 0 && <p><span className="text-danger">Zayıf (sizin notunuz):</span> <span className="text-text-2">{c.weaknesses.join(", ")}</span></p>}
                      </div>
                    )}
                    {c.lastScan?.summary && (
                      <div className="rounded-lg bg-surface-2 p-3">
                        <p className="mb-1 text-xs font-medium text-text-2">Kendi sitesinde yazanlar (AI özeti)</p>
                        <p className="text-text">{c.lastScan.summary}</p>
                        {profile?.claims && profile.claims.length > 0 && (
                          <ul className="mt-2 space-y-1 text-xs">
                            {profile.claims.slice(0, 6).map((cl, i) => (
                              <li key={i}>
                                <span className="text-text">{cl.statement}</span> <span className="italic text-text-3">&ldquo;{cl.evidence.slice(0, 140)}&rdquo;</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                    {c.signals.length > 0 && (
                      <div>
                        <p className="mb-1 flex items-center gap-1 text-xs font-medium text-text-2"><Radar className="size-3.5" aria-hidden /> Tespit edilen gelişmeler</p>
                        <ul className="space-y-1.5">
                          {c.signals.map((s) => (
                            <li key={s.id} className="flex flex-wrap items-start gap-2">
                              <Badge tone="accent">{SIGNAL_LABELS[s.type] ?? s.type}</Badge>
                              <span className="min-w-0 flex-1">
                                <span className="text-text">{s.title}</span>
                                {s.description && <span className="block whitespace-pre-wrap text-xs text-text-3">{s.description}</span>}
                              </span>
                              <span className="text-xs text-text-3">{fmt(s.detectedAt)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <div className="flex flex-wrap items-start gap-2">
                      {canManage && c.website && (
                        <form action={toggleMonitoringAction}>
                          <input type="hidden" name="id" value={c.id} />
                          <input type="hidden" name="monitoring" value={c.monitoring ? "false" : "true"} />
                          <Button type="submit" size="sm" variant="secondary">
                            {c.monitoring ? <><EyeOff className="size-4" aria-hidden /> İzlemeyi kapat</> : <><Eye className="size-4" aria-hidden /> Haftalık izle</>}
                          </Button>
                        </form>
                      )}
                      {canScan && c.website && !jobId && (
                        <ActionButton action={scanCompetitorAction} fields={{ id: c.id }} variant="secondary" pendingText="Başlatılıyor…">
                          <ScanSearch className="size-4" aria-hidden /> Şimdi tara (2 kredi)
                        </ActionButton>
                      )}
                      {!c.website && <p className="text-xs text-text-3">İzleme için web sitesi gerekli.</p>}
                    </div>
                  </CardBody>
                </Card>
              );
            })
          )}
        </div>
        {canManage && (
          <Card className="self-start">
            <CardHeader title="Rakip ekle" />
            <CardBody className="py-5"><CompetitorForm /></CardBody>
          </Card>
        )}
      </div>
    </>
  );
}
