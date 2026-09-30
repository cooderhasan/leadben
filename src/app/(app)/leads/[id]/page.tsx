import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CheckCircle2, ExternalLink, HelpCircle, Radar, Trash2 } from "lucide-react";
import { requireTenantPage } from "@/server/tenancy/context";
import { can } from "@/server/tenancy/permissions";
import { isAIConfigured } from "@/server/ai";
import { getLead, LEAD_STATUS_LABELS } from "@/server/services/leads";
import { getActiveLeadJob, getLastLeadJobError, type LeadEnrichment } from "@/server/services/lead-intelligence";
import { deleteLeadAction, updateLeadStatusAction } from "@/app/actions/leads";
import { JobPoller } from "@/components/job-poller";
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, PageHeader, Select } from "@/components/ui";
import { isAppError } from "@/lib/errors";
import { LEAD_STATUSES } from "@/lib/validation";
import { SCORE_LABELS, SCORE_MAX, scoreTone, type ScoreKey } from "@/lib/lead-scoring";
import { listLeadCompliance, refreshLeadCompliance } from "@/server/services/compliance";
import { BASIS_LABELS, COMPLIANCE_LABELS } from "@/lib/compliance";
import { listConversations, REPLY_CATEGORY_LABELS } from "@/server/services/conversations";
import { FOLLOWUP_STATUS_LABELS, listFollowUps } from "@/server/services/followups";
import { cancelFollowUpAction } from "@/app/actions/conversations";
import { createOpportunityAction } from "@/app/actions/crm";
import { startProposalAction } from "@/app/actions/proposals";
import { getLeadCrm, STAGE_LABELS } from "@/server/services/crm";
import { isWhatsAppActive } from "@/server/services/whatsapp";
import { ActionButton } from "@/components/action-button";
import { formatMoney } from "@/lib/cn";
import { ComplianceReviewForm, LeadContactForm, ManualReplyForm, ResearchLeadButton, ScoreLeadsButton } from "../lead-forms";
import { CALL_OUTCOME_LABELS, listLeadCalls } from "@/server/services/calls";
import { CallResultForm } from "../../calls/call-forms";

export const metadata: Metadata = { title: "Lead" };

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

const SOURCE_TYPE_LABELS: Record<string, string> = {
  GOOGLE_MAPS: "Google Haritalar",
  COMPANY_WEBSITE: "Firma sitesi",
  CSV_IMPORT: "CSV",
  MANUAL: "Elle",
  WEB_SEARCH: "Web araması",
  DIRECTORY: "Dizin",
  PUBLIC_REGISTRY: "Resmi kayıt",
  INSTAGRAM: "Instagram",
  THIRD_PARTY_DATA: "3. taraf veri",
};

const fmtDate = (d: Date | null | undefined) => (d ? new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium" }).format(d) : "—");

function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  const u = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireTenantPage();
  const { id } = await params;
  let lead;
  try {
    lead = await getLead(ctx, id);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  // Uyum kayıtlarını güncel tut (adres / engel listesi değişmiş olabilir); ucuz, AI kullanmaz
  if (can(ctx, "lead.write")) await refreshLeadCompliance(ctx.companyId, id);
  const [activeJob, lastError, compliance, conversations, followUps, crm, calls] = await Promise.all([
    getActiveLeadJob(ctx, id),
    getLastLeadJobError(ctx, id),
    listLeadCompliance(ctx, id),
    listConversations(ctx, { leadId: id }),
    listFollowUps(ctx, { leadId: id }),
    getLeadCrm(ctx, id),
    listLeadCalls(ctx, id),
  ]);
  const waActive = await isWhatsAppActive(ctx.companyId);
  const canReview = can(ctx, "compliance.review");
  const canWrite = can(ctx, "lead.write");
  const aiReady = isAIConfigured();
  const score = lead.scores[0];
  const enrichment = (lead.enrichment ?? null) as LeadEnrichment | null;
  const scoreFacts = (score?.verifiedFacts ?? null) as { facts?: string[]; matchedProducts?: string[] } | null;
  const scoreAssumptions = (Array.isArray(score?.assumptions) ? score.assumptions : []) as string[];
  const website = safeHref(lead.website);

  return (
    <>
      <Link href="/leads" className="mb-3 inline-flex items-center gap-1 text-sm text-text-2 hover:text-text">
        <ArrowLeft className="size-4" aria-hidden /> Leads
      </Link>
      <PageHeader
        title={lead.companyName}
        description={
          <span className="flex flex-wrap items-center gap-2">
            {website && (
              <a href={website} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 hover:text-accent">
                {lead.domain ?? lead.website} <ExternalLink className="size-3" aria-hidden />
              </a>
            )}
            {[lead.district, lead.city, lead.country].filter(Boolean).join(", ")}
            {lead.industry && <Badge>{lead.industry}</Badge>}
          </span>
        }
        actions={
          canWrite ? (
            <form action={updateLeadStatusAction} className="flex gap-2">
              <input type="hidden" name="id" value={lead.id} />
              <Select name="status" defaultValue={lead.status} className="w-44" aria-label="Durum">
                {LEAD_STATUSES.map((s) => (
                  <option key={s} value={s}>{LEAD_STATUS_LABELS[s]}</option>
                ))}
              </Select>
              <Button type="submit" variant="secondary">Kaydet</Button>
            </form>
          ) : (
            <Badge>{LEAD_STATUS_LABELS[lead.status]}</Badge>
          )
        }
      />

      {activeJob && (
        <div className="mb-6">
          <JobPoller
            jobId={activeJob.id}
            label={activeJob.type === "lead.enrich" ? "AI firmayı araştırıyor…" : "Puanlanıyor…"}
            steps={[[0, "Web sitesi okunuyor…"], [35, "Bilgiler çıkarılıyor…"], [65, "Kanıtlar kaynakla karşılaştırılıyor…"], [75, "Puanlanıyor…"]]}
          />
        </div>
      )}
      {!activeJob && lastError && !enrichment && (
        <Alert tone="warning" className="mb-6">Son analiz tamamlanamadı: {lastError.error} Kredi iade edildi.</Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="flex min-w-0 flex-col gap-6">
          {/* Skor kartı */}
          <Card>
            <CardHeader
              title="Uygunluk puanı"
              description={score ? `${fmtDate(score.createdAt)} · ${score.model ?? "AI"}` : "Henüz puanlanmadı"}
              action={
                score ? (
                  <span className="text-3xl font-semibold tracking-tight">
                    <Badge tone={scoreTone(score.total)} className="px-3 py-1 text-lg">{score.total}</Badge>
                    <span className="ml-1 text-sm text-text-3">/100</span>
                  </span>
                ) : undefined
              }
            />
            <CardBody className="flex flex-col gap-4">
              {score ? (
                <>
                  <ul className="grid gap-3 sm:grid-cols-2">
                    {(Object.keys(SCORE_MAX) as ScoreKey[]).map((k) => {
                      const value = score[k];
                      const max = SCORE_MAX[k];
                      return (
                        <li key={k}>
                          <div className="flex justify-between text-xs">
                            <span className="text-text-2">{SCORE_LABELS[k]}</span>
                            <span className="font-medium text-text">{value}/{max}</span>
                          </div>
                          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-border">
                            <div className="h-full rounded-full bg-accent" style={{ width: `${(value / max) * 100}%` }} />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="text-sm leading-relaxed text-text">{score.explanation}</p>
                  {scoreFacts?.matchedProducts && scoreFacts.matchedProducts.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="text-text-2">Uygun ürünleriniz:</span>
                      {scoreFacts.matchedProducts.map((p) => (
                        <Badge key={p} tone="accent">{p}</Badge>
                      ))}
                    </div>
                  )}
                  {scoreAssumptions.length > 0 && (
                    <details className="text-xs text-text-2">
                      <summary className="cursor-pointer">Puandaki varsayımlar ({scoreAssumptions.length})</summary>
                      <ul className="mt-2 list-disc space-y-1 pl-5">
                        {scoreAssumptions.map((a, i) => <li key={i}>{a}</li>)}
                      </ul>
                    </details>
                  )}
                </>
              ) : (
                <p className="text-sm text-text-2">
                  Puan; ürün uyumu, sektör, ölçek, satın alma sinyali ve ulaşılabilirliğe göre hesaplanır. Kanıt olmayan alt skorlar sınırlandırılır.
                </p>
              )}
              {canWrite && aiReady && !activeJob && (
                <div className="flex flex-wrap gap-3">
                  {lead.website && <ResearchLeadButton leadId={lead.id} hasWebsite />}
                  <ScoreLeadsButton leadIds={[lead.id]} label={score ? "Yeniden puanla (1 kredi)" : "Yalnızca puanla (1 kredi)"} />
                </div>
              )}
              {canWrite && !aiReady && <Alert tone="neutral">AI yapılandırılmadığı için araştırma ve puanlama kapalı.</Alert>}
            </CardBody>
          </Card>

          {/* Doğrulanmış vs varsayım */}
          <Card>
            <CardHeader
              title="Firma hakkında"
              description={
                enrichment
                  ? `Kaynak: ${enrichment.pages.length} sayfa · ${fmtDate(new Date(enrichment.researchedAt))}`
                  : "Henüz araştırılmadı. \"AI ile Analiz Et\" firmanın web sitesini okur."
              }
            />
            <CardBody className="flex flex-col gap-4">
              {lead.aiSummary && <p className="text-sm leading-relaxed text-text">{lead.aiSummary}</p>}
              {enrichment && (
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-success">
                      <CheckCircle2 className="size-4" aria-hidden /> Doğrulanmış ({enrichment.verified.length})
                    </h3>
                    {enrichment.verified.length === 0 ? (
                      <p className="text-xs text-text-3">Sayfada kanıtı bulunan bilgi yok.</p>
                    ) : (
                      <ul className="space-y-2 text-sm">
                        {enrichment.verified.map((v, i) => (
                          <li key={i} className="rounded-lg border border-border p-2.5">
                            <p className="text-text">{v.statement}</p>
                            {v.evidence && <p className="mt-1 text-xs italic text-text-3">&ldquo;{v.evidence}&rdquo;</p>}
                            {safeHref(v.sourceUrl) && (
                              <a href={safeHref(v.sourceUrl)!} target="_blank" rel="noopener noreferrer nofollow" className="mt-1 inline-block truncate text-xs text-accent-text">
                                Kaynak
                              </a>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div>
                    <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium text-warning">
                      <HelpCircle className="size-4" aria-hidden /> AI varsayımı ({enrichment.assumptions.length})
                    </h3>
                    {enrichment.assumptions.length === 0 ? (
                      <p className="text-xs text-text-3">Varsayım yok.</p>
                    ) : (
                      <ul className="space-y-2 text-sm">
                        {enrichment.assumptions.map((a, i) => (
                          <li key={i} className="rounded-lg border border-dashed border-border p-2.5">
                            <p className="text-text">{a.statement}</p>
                            <p className="mt-1 text-xs text-text-3">{a.reason}</p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
              {enrichment && enrichment.products.length > 0 && (
                <div className="flex flex-wrap gap-1.5 text-xs">
                  <span className="text-text-2">Ürünleri:</span>
                  {enrichment.products.map((p) => <Badge key={p}>{p}</Badge>)}
                </div>
              )}
            </CardBody>
          </Card>

          {/* Sinyaller */}
          <Card>
            <CardHeader title="Satış sinyalleri" description="Yalnızca kaynağında kanıtı bulunan gelişmeler gösterilir." />
            {lead.signals.length === 0 ? (
              <EmptyState icon={<Radar className="size-7" />} title="Sinyal yok" description="Araştırma sırasında yatırım, yeni tesis, personel alımı gibi gelişmeler bulunursa burada görünür." />
            ) : (
              <ol className="divide-y divide-border">
                {lead.signals.map((s) => (
                  <li key={s.id} className="px-5 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="accent">{SIGNAL_LABELS[s.type] ?? s.type}</Badge>
                      <span className="text-sm font-medium text-text">{s.title}</span>
                      <span className="ml-auto text-xs text-text-3">{fmtDate(s.publishedAt ?? s.detectedAt)}</span>
                    </div>
                    {s.description && <p className="mt-1 text-sm text-text-2">{s.description}</p>}
                    {s.aiInterpretation && <p className="mt-1 text-xs italic text-text-3">{s.aiInterpretation}</p>}
                  </li>
                ))}
              </ol>
            )}
          </Card>

          {/* Yanıtlar ve hatırlatmalar */}
          <Card>
            <CardHeader title="Yanıtlar" description="Gelen yanıtlar AI ile sınıflandırılır; ilgi, teklif veya görüşme talebinde görev ve fırsat açılır." />
            {conversations.length > 0 && (
              <ul className="divide-y divide-border">
                {conversations.map((c) => (
                  <li key={c.id}>
                    <Link href={`/messages/c/${c.id}`} className="flex items-center gap-3 px-5 py-3 text-sm hover:bg-surface-2">
                      <span className="min-w-0 flex-1 truncate text-text-2">{c.messages[0]?.aiSummary ?? c.messages[0]?.body.slice(0, 140)}</span>
                      {c.category ? <Badge tone="accent">{REPLY_CATEGORY_LABELS[c.category]}</Badge> : <Badge>Sınıflandırılıyor</Badge>}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {canWrite && (
              <CardBody className="border-t border-border">
                <details>
                  <summary className="cursor-pointer text-sm font-medium text-text">Posta kutunuza gelen bir yanıtı elle ekleyin</summary>
                  <div className="mt-3">
                    <ManualReplyForm leadId={lead.id} defaultFrom={compliance[0]?.address ?? lead.genericEmail ?? ""} />
                  </div>
                </details>
              </CardBody>
            )}
            {followUps.length > 0 && (
              <CardBody className="border-t border-border">
                <p className="mb-2 text-xs font-medium text-text-2">Hatırlatmalar</p>
                <ul className="space-y-1.5 text-sm">
                  {followUps.map((f) => (
                    <li key={f.id} className="flex flex-wrap items-center gap-2">
                      <span className="text-text">{f.campaignStep?.name ?? "Hatırlatma"}</span>
                      <span className="text-xs text-text-3">{fmtDate(f.scheduledAt)}</span>
                      <Badge tone={f.status === "SCHEDULED" ? "accent" : f.status === "SENT" ? "success" : "neutral"}>{FOLLOWUP_STATUS_LABELS[f.status]}</Badge>
                      {f.skipReason && <span className="text-xs text-text-3">{f.skipReason}</span>}
                      {canWrite && f.status === "SCHEDULED" && (
                        <form action={cancelFollowUpAction} className="ml-auto">
                          <input type="hidden" name="id" value={f.id} />
                          <input type="hidden" name="leadId" value={lead.id} />
                          <Button type="submit" variant="ghost" size="sm">İptal</Button>
                        </form>
                      )}
                    </li>
                  ))}
                </ul>
              </CardBody>
            )}
          </Card>
        </div>

        {/* Yan panel */}
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader title="Kurumsal iletişim" />
            <CardBody>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
                <dt className="text-text-2">Telefon</dt>
                <dd className="truncate text-text">{lead.phone ?? "—"}</dd>
                <dt className="text-text-2">E-posta</dt>
                <dd className="truncate text-text">{lead.genericEmail ?? "—"}</dd>
                {!lead.genericEmail && safeHref(lead.contactFormUrl) && (
                  <>
                    <dt className="text-text-2">İletişim formu</dt>
                    <dd className="min-w-0">
                      <a href={safeHref(lead.contactFormUrl)!} target="_blank" rel="noopener noreferrer nofollow" className="block truncate text-accent-text">
                        Formu aç
                      </a>
                      <span className="text-xs text-text-3">Mesajı siz gönderirsiniz; sistem form doldurmaz.</span>
                    </dd>
                  </>
                )}
                <dt className="text-text-2">Adres</dt>
                <dd className="text-text">{lead.address ?? "—"}</dd>
                <dt className="text-text-2">Çalışan</dt>
                <dd className="text-text">
                  {lead.employeeCountMin || lead.employeeCountMax
                    ? [lead.employeeCountMin, lead.employeeCountMax].filter(Boolean).join("–")
                    : "Bilinmiyor"}
                </dd>
                {(lead.linkedin || lead.instagram) && (
                  <>
                    <dt className="text-text-2">Sosyal</dt>
                    <dd className="flex flex-wrap gap-2">
                      {safeHref(lead.linkedin) && <a href={safeHref(lead.linkedin)!} target="_blank" rel="noopener noreferrer nofollow" className="text-accent-text">LinkedIn</a>}
                      {safeHref(lead.instagram) && <a href={safeHref(lead.instagram)!} target="_blank" rel="noopener noreferrer nofollow" className="text-accent-text">Instagram</a>}
                    </dd>
                  </>
                )}
              </dl>
              {canWrite && (
                <details className="mt-4 border-t border-border pt-3">
                  <summary className="cursor-pointer text-sm font-medium text-accent-text">İletişim bilgilerini düzenle</summary>
                  <div className="mt-3">
                    <LeadContactForm lead={lead} />
                  </div>
                </details>
              )}
            </CardBody>
          </Card>

          {(lead.phone || calls.length > 0) && (
            <Card>
              <CardHeader title={`Telefon görüşmeleri (${calls.length})`} description="Sözlü izinler (WhatsApp / e-posta) kim ve ne zaman bilgisiyle burada kayıtlıdır." />
              {calls.length > 0 && (
                <ul className="divide-y divide-border border-t border-border text-sm">
                  {calls.map((c) => (
                    <li key={c.id} className="px-5 py-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">{CALL_OUTCOME_LABELS[c.outcome]}</span>
                        <span className="text-xs text-text-3">{c.createdAt.toLocaleString("tr-TR", { timeZone: "Europe/Istanbul", dateStyle: "short", timeStyle: "short" })}</span>
                      </div>
                      {c.note && <p className="mt-0.5 text-xs text-text-2">{c.note}</p>}
                    </li>
                  ))}
                </ul>
              )}
              {canWrite && lead.phone && (
                <CardBody className="border-t border-border">
                  <details>
                    <summary className="cursor-pointer text-sm font-medium text-accent-text">Görüşme sonucu ekle</summary>
                    <div className="mt-3">
                      <CallResultForm leadId={lead.id} />
                    </div>
                  </details>
                </CardBody>
              )}
            </Card>
          )}

          <Card>
            <CardHeader
              title="Fırsat ve görevler"
              action={crm.opportunity ? <Link href="/pipeline" className="text-xs text-accent">Pipeline</Link> : undefined}
            />
            <CardBody className="flex flex-col gap-3 text-sm">
              {crm.opportunity ? (
                <p>
                  <Badge tone={crm.opportunity.stage === "WON" ? "success" : crm.opportunity.stage === "LOST" ? "danger" : "accent"}>
                    {STAGE_LABELS[crm.opportunity.stage]}
                  </Badge>
                  <span className="ml-2 text-text-2">{crm.opportunity.value ? formatMoney(Number(crm.opportunity.value)) : "Tutar girilmedi"}</span>
                </p>
              ) : null}
              {(() => {
                const open = crm.opportunity && !["WON", "LOST"].includes(crm.opportunity.stage) ? crm.opportunity : null;
                if (open && canWrite) {
                  return (
                    <ActionButton action={startProposalAction} fields={{ opportunityId: open.id }} variant="secondary" pendingText="Açılıyor…">
                      Teklif hazırla (5 kredi)
                    </ActionButton>
                  );
                }
                // Açık fırsat yoksa (hiç yok veya kapanmış) yeni fırsat açılabilir
                if (!open && canWrite) {
                  return (
                    <ActionButton action={createOpportunityAction} fields={{ leadId: lead.id }} variant="secondary">
                      Fırsat oluştur
                    </ActionButton>
                  );
                }
                return crm.opportunity ? null : <p className="text-text-3">Fırsat yok.</p>;
              })()}
              {crm.tasks.length > 0 && (
                <ul className="space-y-1">
                  {crm.tasks.map((t) => (
                    <li key={t.id} className="flex items-start gap-2">
                      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                      <span className="text-text">{t.title}</span>
                      {t.dueAt && <span className="ml-auto shrink-0 text-xs text-text-3">{fmtDate(t.dueAt)}</span>}
                    </li>
                  ))}
                </ul>
              )}
              <Link href="/tasks" className="text-xs text-accent">Tüm görevler</Link>
            </CardBody>
          </Card>

          <Card id="uyum">
            <CardHeader title="Gönderim uygunluğu" description="E-posta adresleri gönderimden önce bu kurallarla kontrol edilir." />
            {compliance.length === 0 ? (
              <CardBody><p className="text-sm text-text-3">E-posta adresi yok — bu lead&apos;e e-posta kampanyası gönderilemez.</p></CardBody>
            ) : (
              <ul className="divide-y divide-border">
                {compliance.map((r) => (
                  <li key={r.id} className="flex flex-col gap-1.5 px-5 py-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium text-text">{r.address}</span>
                      <Badge tone={r.status === "SENDABLE" ? "success" : r.status === "DO_NOT_SEND" ? "danger" : "warning"}>
                        {COMPLIANCE_LABELS[r.status]}
                      </Badge>
                    </div>
                    <p className="text-xs text-text-2">
                      {r.contactType === "PERSONAL" ? "Kişisel" : "Kurumsal"} · {BASIS_LABELS[r.communicationBasis]}
                      {r.reviewedAt && " · insan incelemesi yapıldı"}
                    </p>
                    {r.reasons.map((reason, i) => <p key={i} className="text-xs text-text-3">{reason}</p>)}
                    {canReview && r.status === "REVIEW_REQUIRED" && !r.optOut && !r.suppressed && (
                      <ComplianceReviewForm recordId={r.id} leadId={lead.id} />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title={`Kişiler (${lead.contacts.length})`} description="Kişisel veriler ayrı tutulur; iletişim dayanağı olmadan gönderim yapılmaz." />
            {lead.contacts.length === 0 ? (
              <CardBody><p className="text-sm text-text-3">Kayıtlı kişi yok.</p></CardBody>
            ) : (
              <ul className="divide-y divide-border">
                {lead.contacts.map((c) => (
                  <li key={c.id} className="px-5 py-3 text-sm">
                    <p className="font-medium text-text">{c.fullName ?? c.email ?? c.phone}</p>
                    <p className="text-xs text-text-2">{[c.title, c.email, c.phone].filter(Boolean).join(" · ")}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge>{c.type === "PERSONAL" ? "Kişisel" : "Kurumsal"}</Badge>
                      {c.communicationBasis === "NONE" && <Badge tone="warning">Dayanak yok</Badge>}
                      {c.optOut && <Badge tone="danger">İletişim istemiyor</Badge>}
                      {waActive && c.phone && !c.optOut && can(ctx, "whatsapp.template") && (
                        <Link href={`/leads/${lead.id}/whatsapp?contactId=${c.id}`} className="text-xs text-accent-text">WhatsApp şablonu</Link>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Kaynaklar" />
            <ul className="divide-y divide-border">
              {lead.sources.map((s) => (
                <li key={s.id} className="flex items-center gap-2 px-5 py-2.5 text-sm">
                  <Badge>{SOURCE_TYPE_LABELS[s.type] ?? s.type}</Badge>
                  <span className="flex-1 text-xs text-text-3">{fmtDate(s.fetchedAt)}</span>
                  {safeHref(s.sourceUrl) && (
                    <a href={safeHref(s.sourceUrl)!} target="_blank" rel="noopener noreferrer nofollow" className="text-accent-text" aria-label="Kaynağı aç">
                      <ExternalLink className="size-3.5" aria-hidden />
                    </a>
                  )}
                </li>
              ))}
            </ul>
            <CardBody className="border-t border-border text-xs text-text-3">
              Bulunma: {fmtDate(lead.discoveredAt)} · Son doğrulama: {fmtDate(lead.lastVerifiedAt)}
              {lead.nextRefreshAt && <> · Yenileme: {fmtDate(lead.nextRefreshAt)}</>}
            </CardBody>
          </Card>

          {canWrite && (
            <form action={deleteLeadAction}>
              <input type="hidden" name="id" value={lead.id} />
              <Button type="submit" variant="danger" size="sm">
                <Trash2 className="size-4" aria-hidden /> Lead&apos;i sil
              </Button>
            </form>
          )}
        </div>
      </div>
    </>
  );
}
