import type { Metadata } from "next";
import Link from "next/link";
import { Check, Sparkles } from "lucide-react";
import { requireTenantPage } from "@/server/tenancy/context";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { ONBOARDING_STEPS, decimalToNumber, type OnboardingStepKey } from "@/server/services/company";
import { getLatestOwnAnalysis } from "@/server/services/website-analysis";
import { isAIConfigured } from "@/server/ai";
import { completeOnboardingAction, deleteCompetitorAction, finishCompetitorsAction, skipWebsiteAction } from "@/app/actions/onboarding";
import { FactReview, SummaryCard } from "@/components/fact-review";
import { JobPoller } from "@/components/job-poller";
import { Alert, Badge, Button, Card, CardBody, buttonClass } from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  CompanyStep,
  CompetitorForm,
  DeleteIcon,
  ExclusionsStep,
  ProductionStep,
  SalesStep,
  TargetStep,
  WebsiteStep,
} from "./steps";

export const metadata: Metadata = { title: "Önce şirketini tanıyalım" };

const STEP_INTRO: Record<OnboardingStepKey, string> = {
  website: "Web sitenizi analiz ederek sizi tanıyayım. Bulduklarımı onayınıza sunacağım — onaylamadıklarınızı satış mesajlarında kullanmam.",
  company: "Firmanızın temel bilgileri. AI'ın önerileri varsa doldurdum, kontrol edin.",
  products: "Ne satıyorsunuz? Ürünleri ve üretim koşullarınızı girin. Detaylı ürün kartlarını sonra da ekleyebilirsiniz.",
  target: "Kime satmak istiyorsunuz? AI potansiyel müşterileri bu tanıma göre arayacak.",
  sales: "Satış süreciniz. Hedef ve dönüşüm tahminleri bu bilgilere dayanacak.",
  competitors: "Rakiplerinizi ekleyin. Yalnızca kamuya açık bilgiler izlenir.",
  exclusions: "Hangi müşterilerle çalışmak istemiyorsunuz? AI bu kurallara uyar.",
  summary: "Hazırsınız. Eksikleri her zaman Şirketim sayfasından tamamlayabilirsiniz.",
};

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ step?: string; return?: string }> }) {
  const ctx = await requireTenantPage();
  const db = tenantDb(ctx);
  const sp = await searchParams;

  const [company, pendingFacts, analysis, products, target, exclusion, competitors, rules, certs] = await Promise.all([
    db.company.findUniqueOrThrow({ where: { id: ctx.companyId }, include: { profile: true } }),
    db.companyFact.findMany({ where: { status: "PENDING" }, orderBy: [{ key: "asc" }, { confidence: "desc" }] }),
    getLatestOwnAnalysis(ctx),
    db.product.findMany({ where: { status: "VERIFIED" }, select: { name: true }, orderBy: { createdAt: "asc" } }),
    db.targetMarket.findFirst({ where: { isExcluded: false }, orderBy: [{ priority: "desc" }, { createdAt: "asc" }] }),
    db.targetMarket.findFirst({ where: { isExcluded: true } }),
    db.competitor.findMany({ orderBy: { createdAt: "asc" } }),
    db.companyMemory.findMany({ where: { type: "RULE", status: "ACTIVE" }, select: { content: true } }),
    db.companyFact.findMany({ where: { key: "certification", status: "VERIFIED" }, select: { value: true } }),
  ]);

  const stepKeys = ONBOARDING_STEPS.map((s) => s.key) as readonly string[];
  const defaultStep = ONBOARDING_STEPS[Math.min(company.onboardingStep, ONBOARDING_STEPS.length - 1)]!.key;
  const step = (stepKeys.includes(sp.step ?? "") ? sp.step : defaultStep) as OnboardingStepKey;
  const stepIndex = stepKeys.indexOf(step);
  const returnTo = sp.return?.startsWith("/") && !sp.return.startsWith("//") ? sp.return : undefined;
  const p = company.profile;

  // AI önerileri (onay bekleyen fact'lerden)
  const firstPending = (key: string) => pendingFacts.find((f) => f.key === key)?.value;
  const analysisRunning = analysis && (analysis.status === "QUEUED" || analysis.status === "RUNNING");
  const analysisJob = analysisRunning ? await db.websiteAnalysis.findUnique({ where: { id: analysis.id }, select: { jobId: true } }) : null;

  return (
    <div className="min-h-dvh bg-bg">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex h-14 max-w-4xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className="grid size-7 place-items-center rounded-lg bg-accent text-white">
              <Sparkles className="size-4" aria-hidden />
            </span>
            AI Sales OS
          </div>
          {company.onboardingCompletedAt && (
            <Link href="/dashboard" className="text-sm text-text-2 hover:text-text">Dashboard&apos;a dön</Link>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-10">
        <p className="text-sm font-medium text-accent">{company.name}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Önce şirketini tanıyalım.</h1>

        {/* İlerleme */}
        <ol className="mt-6 flex gap-1.5 overflow-x-auto pb-1" aria-label="Kurulum adımları">
          {ONBOARDING_STEPS.map((s, i) => {
            const done = i < company.onboardingStep;
            const current = s.key === step;
            return (
              <li key={s.key} className="min-w-0 flex-1">
                <Link
                  href={`/onboarding?step=${s.key}`}
                  aria-current={current ? "step" : undefined}
                  className="group block min-w-16"
                >
                  <span className={cn("block h-1.5 rounded-full", current ? "bg-accent" : done ? "bg-accent/50" : "bg-border")} />
                  <span className={cn("mt-1.5 hidden truncate text-xs sm:block", current ? "font-medium text-text" : "text-text-3 group-hover:text-text-2")}>
                    {s.title}
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>

        <div className="mt-8">
          <p className="text-xs font-medium uppercase tracking-wide text-text-3">
            Adım {stepIndex + 1} / {ONBOARDING_STEPS.length}
          </p>
          <h2 className="mt-1 text-lg font-semibold">{ONBOARDING_STEPS[stepIndex]!.title}</h2>
          <p className="mt-1 max-w-2xl text-sm text-text-2">{STEP_INTRO[step]}</p>
        </div>

        <div className="mt-6 flex flex-col gap-6">
          {step === "website" && (
            <>
              <Card>
                <CardBody className="py-5">
                  <WebsiteStep defaultUrl={analysis?.url ?? company.website} aiReady={isAIConfigured()} />
                </CardBody>
              </Card>

              {analysisRunning && analysisJob?.jobId && (
                <JobPoller
                  jobId={analysisJob.jobId}
                  label="Sizi tanımam için web sitenizi analiz ediyorum…"
                  steps={[
                    [0, "Sayfalar okunuyor"],
                    [40, "Ürünler, sektörler ve güçlü yönler çıkarılıyor"],
                    [80, "Bulgular kaynaklarla karşılaştırılıyor"],
                  ]}
                />
              )}
              {analysis?.status === "FAILED" && (
                <Alert tone="danger">
                  Analiz tamamlanamadı: {analysis.error ?? "bilinmeyen hata"}. Krediniz iade edildi. Tekrar deneyebilir veya bu adımı atlayabilirsiniz.
                </Alert>
              )}
              {analysis?.status === "COMPLETED" && (
                <>
                  <SummaryCard summary={p?.aiSummary ?? null} status={p?.aiSummaryStatus ?? "PENDING"} />
                  <FactReview facts={pendingFacts} emptyText="Tüm bulguları incelediniz." />
                </>
              )}

              <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-between">
                <form action={skipWebsiteAction}>
                  <Button type="submit" variant="ghost">{analysis?.status === "COMPLETED" ? "Sonra incelerim" : "Bu adımı atla"}</Button>
                </form>
                {analysis?.status === "COMPLETED" && (
                  <form action={skipWebsiteAction}>
                    <Button type="submit">Devam et</Button>
                  </form>
                )}
              </div>
            </>
          )}

          {step === "company" && (
            <Card>
              <CardBody className="py-5">
                <CompanyStep
                  returnTo={returnTo}
                  d={{
                    name: company.name,
                    website: company.website,
                    country: company.country,
                    city: company.city,
                    sector: p?.sector,
                    subSector: p?.subSector,
                    serviceRegions: p?.serviceRegions,
                    sizeBand: p?.sizeBand,
                    employeeCount: p?.employeeCount,
                    description: p?.description,
                  }}
                  suggestions={{ sector: firstPending("sector"), subSector: firstPending("sub_sector"), description: firstPending("description") }}
                />
              </CardBody>
            </Card>
          )}

          {step === "products" && (
            <Card>
              <CardBody className="py-5">
                <ProductionStep
                  returnTo={returnTo}
                  d={{
                    minOrder: p?.minOrder,
                    priceRangeNote: p?.priceRangeNote,
                    avgOrderValue: decimalToNumber(p?.avgOrderValue),
                    productionCapacity: p?.productionCapacity,
                    deliveryTime: p?.deliveryTime,
                    customManufacturing: p?.customManufacturing,
                    certifications: certs.map((c) => c.value),
                    productNames: products.map((x) => x.name),
                  }}
                />
              </CardBody>
            </Card>
          )}

          {step === "target" && (
            <Card>
              <CardBody className="py-5">
                <TargetStep
                  returnTo={returnTo}
                  d={{
                    name: target?.name,
                    businessModel: target?.businessModel,
                    industries: target?.industries ?? pendingFacts.filter((f) => f.key === "industry_served").map((f) => f.value).slice(0, 8),
                    subIndustries: target?.subIndustries ?? [],
                    countries: target?.countries ?? (company.country ? [company.country] : ["Türkiye"]),
                    cities: target?.cities ?? [],
                    minEmployees: target?.minEmployees,
                    maxEmployees: target?.maxEmployees,
                    minRevenue: decimalToNumber(target?.minRevenue),
                    customerTypes: target?.customerTypes ?? [],
                    decisionMakerRoles: target?.decisionMakerRoles ?? [],
                    notes: target?.notes,
                  }}
                />
              </CardBody>
            </Card>
          )}

          {step === "sales" && (
            <Card>
              <CardBody className="py-5">
                <SalesStep
                  returnTo={returnTo}
                  d={{
                    currency: p?.currency ?? "TRY",
                    avgSaleValue: decimalToNumber(p?.avgSaleValue),
                    salesCycleDays: p?.salesCycleDays,
                    monthlySalesTarget: decimalToNumber(p?.monthlySalesTarget),
                    existingCustomerTypes: p?.existingCustomerTypes ?? [],
                    existingCustomerExamples: p?.existingCustomerExamples ?? [],
                  }}
                />
              </CardBody>
            </Card>
          )}

          {step === "competitors" && (
            <>
              {competitors.length > 0 && (
                <Card>
                  <ul className="divide-y divide-border">
                    {competitors.map((c) => (
                      <li key={c.id} className="flex items-center justify-between gap-3 px-5 py-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{c.name}</p>
                          <p className="truncate text-xs text-text-3">{c.website ?? "Web sitesi yok"}</p>
                        </div>
                        <form action={deleteCompetitorAction}>
                          <input type="hidden" name="id" value={c.id} />
                          <Button type="submit" variant="ghost" size="sm" aria-label={`${c.name} sil`}>
                            <DeleteIcon />
                          </Button>
                        </form>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              <Card>
                <CardBody className="py-5">
                  <CompetitorForm />
                </CardBody>
              </Card>
              <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-between">
                <Link href="/onboarding?step=sales" className={buttonClass("ghost")}>Geri</Link>
                <form action={finishCompetitorsAction}>
                  <Button type="submit" className="w-full sm:w-auto">{competitors.length ? "Devam et" : "Rakip eklemeden devam et"}</Button>
                </form>
              </div>
            </>
          )}

          {step === "exclusions" && (
            <Card>
              <CardBody className="py-5">
                <ExclusionsStep
                  returnTo={returnTo}
                  d={{
                    industries: exclusion?.industries ?? [],
                    cities: exclusion?.cities ?? [],
                    customerTypes: exclusion?.customerTypes ?? [],
                    notes: exclusion?.notes,
                    rules: rules.map((r) => r.content),
                  }}
                />
              </CardBody>
            </Card>
          )}

          {step === "summary" && (
            <>
              <Card>
                <CardBody className="grid gap-3 py-5 sm:grid-cols-2">
                  {[
                    { label: "Web sitesi analizi", done: analysis?.status === "COMPLETED", href: "website" },
                    { label: "Firma bilgileri", done: Boolean(p?.sector), href: "company" },
                    { label: `Ürünler (${products.length})`, done: products.length > 0, href: "products" },
                    { label: "Hedef müşteri", done: Boolean(target), href: "target" },
                    { label: "Satış bilgileri", done: Boolean(p?.avgSaleValue || p?.salesCycleDays), href: "sales" },
                    { label: `Rakipler (${competitors.length})`, done: competitors.length > 0, href: "competitors" },
                    { label: "İstenmeyen müşteriler", done: Boolean(exclusion) || rules.length > 0, href: "exclusions" },
                  ].map((i) => (
                    <Link key={i.href} href={`/onboarding?step=${i.href}`} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 hover:bg-surface-2">
                      <span className={cn("grid size-5 place-items-center rounded-full", i.done ? "bg-success text-white" : "border border-border")}>
                        {i.done && <Check className="size-3" aria-hidden />}
                      </span>
                      <span className="text-sm">{i.label}</span>
                      {!i.done && <Badge className="ml-auto">Eksik</Badge>}
                    </Link>
                  ))}
                </CardBody>
              </Card>
              {pendingFacts.length > 0 && (
                <Alert tone="warning">
                  {pendingFacts.length} AI bulgusu hâlâ onayınızı bekliyor. Onaylanmayan bilgiler satış mesajlarında kullanılmaz —{" "}
                  <Link href="/company" className="font-medium underline">Şirketim</Link> sayfasından inceleyebilirsiniz.
                </Alert>
              )}
              <form action={completeOnboardingAction} className="flex justify-end">
                <Button type="submit" size="lg">Kurulumu tamamla</Button>
              </form>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
