import type { Metadata } from "next";
import Link from "next/link";
import { Building2, Globe, Mail, Phone, Plus, Send, Star, Target } from "lucide-react";
import { requireTenantPage } from "@/server/tenancy/context";
import { can } from "@/server/tenancy/permissions";
import { env } from "@/server/env";
import { isLeadSourceConfigured, LEAD_SOURCE_LABELS } from "@/server/providers/lead-source";
import { isAIConfigured } from "@/server/ai";
import { LEAD_SORTS, LEAD_SOURCE_FILTERS, LEAD_STATUS_LABELS, leadStats, listLeadLists, listLeads } from "@/server/services/leads";
import { listMembers } from "@/server/services/members";
import { getLastEmailDiscovery, getLastListImport, getLastPreparation, getLastWebsiteDiscovery, listRecentSearches } from "@/server/services/lead-intelligence";
import { listOpenCampaigns } from "@/server/services/campaigns";
import { LEAD_PAGE_SIZES, parseLeadFilter } from "@/lib/lead-filter";
import { BulkBar, SelectPageCheckbox } from "./bulk-bar";
import { JobPoller } from "@/components/job-poller";
import { Alert, Badge, Card, CardBody, CardHeader, EmptyState, Input, LinkButton, PageHeader, Select, StatCard, buttonClass } from "@/components/ui";
import { cn } from "@/lib/cn";
import { LEAD_STATUSES } from "@/lib/validation";
import { scoreTone } from "@/lib/lead-scoring";
import { CsvImportForm, FindEmailsButton, LeadSearchForm, ListImportForm, QuickDeleteButton, QuickEmailForm, ScoreLeadsButton } from "./lead-forms";

export const metadata: Metadata = { title: "Potansiyel müşteriler" };

const PAGE_SIZE = 50;

const SOURCE_LABELS: Record<string, string> = {
  apify: "Google Haritalar",
  "apify-web": "Web araması",
  directory: "Liste sayfası",
  csv: "CSV",
  manual: "Elle",
};

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    min?: string;
    page?: string;
    source?: string;
    email?: string;
    owner?: string;
    list?: string;
    campaign?: string;
    sort?: string;
    per?: string;
  }>;
}) {
  const ctx = await requireTenantPage();
  const sp = await searchParams;
  const parsed = parseLeadFilter((k) => sp[k as keyof typeof sp]);
  // "me" sekmesi oturumdaki kullanıcıya çevrilir
  const filter = { ...parsed, owner: parsed.owner === "me" ? ctx.userId : parsed.owner };
  const { status, minScore } = filter;
  const pageSize = parsed.per ?? PAGE_SIZE;
  const page = Math.max(1, Number(sp.page) || 1);

  const canWriteEarly = can(ctx, "lead.write");
  const [{ rows, total }, stats, searches, emailRun, listRun, prepRun, siteRun, lists, members, openCampaigns] = await Promise.all([
    listLeads(ctx, { ...filter, take: pageSize, skip: (page - 1) * pageSize }),
    leadStats(ctx),
    listRecentSearches(ctx, 5),
    getLastEmailDiscovery(ctx),
    getLastListImport(ctx),
    getLastPreparation(ctx),
    getLastWebsiteDiscovery(ctx),
    listLeadLists(ctx),
    can(ctx, "member.read") ? listMembers(ctx) : Promise.resolve([]),
    canWriteEarly && can(ctx, "campaign.write") ? listOpenCampaigns(ctx) : Promise.resolve([]),
  ]);
  const prepRunning = prepRun && (prepRun.status === "QUEUED" || prepRun.status === "RUNNING");
  const siteRunning = siteRun && (siteRun.status === "QUEUED" || siteRun.status === "RUNNING");
  const filterParams: Record<string, string | undefined> = {
    q: filter.q,
    status: filter.status,
    min: filter.minScore !== undefined ? String(filter.minScore) : undefined,
    source: filter.source,
    email: filter.email,
    owner: filter.owner,
    list: filter.listId,
    campaign: filter.campaign,
  };
  // Sorumlu adları (tabloda baş harf rozeti ve seçiciler için)
  const memberNames = new Map(members.map((m) => [m.user.id, m.user.name || m.user.email]));
  const ownerTab = parsed.owner === "me" ? "me" : parsed.owner === "none" ? "none" : parsed.owner ? "other" : "all";
  const tabHref = (owner: string | null) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filterParams, owner: undefined })) if (v) u.set(k === "listId" ? "list" : k, v);
    if (parsed.sort) u.set("sort", parsed.sort);
    if (parsed.per) u.set("per", String(parsed.per));
    if (owner) u.set("owner", owner);
    return `/leads?${u.toString()}`;
  };
  const listRunning = listRun && (listRun.status === "QUEUED" || listRun.status === "RUNNING");
  const emailRunning = emailRun && (emailRun.status === "QUEUED" || emailRun.status === "RUNNING");
  const canWrite = can(ctx, "lead.write");
  const sourceReady = isLeadSourceConfigured();
  const aiReady = isAIConfigured();
  const running = searches.find((s) => s.status === "QUEUED" || s.status === "RUNNING");
  const unscored = rows.filter((r) => r.fitScore === null).map((r) => r.id);
  const missingEmail = rows.filter((r) => r.website && !r.genericEmail).map((r) => r.id);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const qs = (p: number) => {
    const u = new URLSearchParams();
    if (sp.q) u.set("q", sp.q);
    if (status) u.set("status", status);
    if (minScore !== undefined) u.set("min", String(minScore));
    if (filter.source) u.set("source", filter.source);
    if (filter.email) u.set("email", filter.email);
    if (parsed.owner) u.set("owner", parsed.owner);
    if (filter.listId) u.set("list", filter.listId);
    if (filter.campaign) u.set("campaign", filter.campaign);
    if (parsed.sort) u.set("sort", parsed.sort);
    if (parsed.per) u.set("per", String(parsed.per));
    u.set("page", String(p));
    return `/leads?${u.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="Potansiyel müşteriler"
        description="Potansiyel müşterileri bulun, araştırın ve puanlayın. Puanlar yalnızca doğrulanmış şirket bilgilerinize dayanır."
        actions={
          canWrite ? (
            <LinkButton href="/leads/new" variant="secondary">
              <Plus className="size-4" aria-hidden /> Elle ekle
            </LinkButton>
          ) : undefined
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard label="Toplam lead" value={stats.total} icon={<Building2 />} tone="accent" />
        <StatCard label="Puanlanan" value={stats.scored} icon={<Target />} />
        <StatCard label="Yüksek uyum (70+)" value={stats.qualified} icon={<Star />} tone="success" />
        <StatCard label="İletişime hazır" value={stats.contactReady} icon={<Send />} tone="warning" />
      </div>

      {canWrite && (
        <div className="mb-6 grid gap-6 lg:grid-cols-[3fr_2fr]">
          <Card>
            <CardHeader title="AI ile lead bul" description="Doğal dille yazın; AI aramayı işletme dizinlerinde uygulanabilir sorguya çevirir." />
            <CardBody className="flex flex-col gap-4">
              {!sourceReady && (
                <Alert tone="warning">
                  Otomatik arama kapalı: sunucuda <code>APIFY_TOKEN</code> tanımlı değil. CSV ile içe aktarabilir veya elle ekleyebilirsiniz.
                </Alert>
              )}
              {sourceReady && !aiReady && (
                <Alert tone="neutral">AI kapalı — arama ifadeniz olduğu gibi kullanılır, puanlama yapılamaz.</Alert>
              )}
              {running ? (
                <JobPoller
                  jobId={running.id}
                  label={`Aranıyor: ${running.interpretation || running.prompt}`}
                  steps={[[0, "Arama başlatılıyor…"], [10, "Kaynak taranıyor (birkaç dakika sürebilir)…"], [80, "Tekrarlar ayıklanıyor ve kaydediliyor…"]]}
                />
              ) : (
                <LeadSearchForm enabled={sourceReady} maxLimit={env().LEAD_SEARCH_MAX} />
              )}
              {searches.filter((s) => s !== running).length > 0 && (
                <ul className="divide-y divide-border rounded-lg border border-border text-xs">
                  {searches
                    .filter((s) => s !== running)
                    .map((s) => (
                      <li key={s.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                        <span className="min-w-0 flex-1 truncate text-text-2" title={s.interpretation}>{s.prompt}</span>
                        <span className="shrink-0 text-text-3">{LEAD_SOURCE_LABELS[s.source]}</span>
                        {s.status === "SUCCEEDED" ? (
                          <Badge tone="success">{s.created ?? 0} yeni · {s.merged ?? 0} birleşti</Badge>
                        ) : s.status === "FAILED" ? (
                          <Badge tone="danger" title={s.error ?? undefined}>Başarısız · kredi iade</Badge>
                        ) : (
                          <Badge>{s.status}</Badge>
                        )}
                      </li>
                    ))}
                </ul>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Listeden içe aktar" description="Hazır firma listelerini ekleyin; tekrar eden firmalar otomatik birleştirilir." />
            <CardBody className="flex flex-col gap-4">
              {listRunning ? (
                <JobPoller
                  jobId={listRun.id}
                  label="Liste okunuyor ve firmalar çıkarılıyor…"
                  steps={[[0, "Sayfa okunuyor…"], [20, "AI firmaları çıkarıyor (1-2 dakika)…"], [80, "Doğrulanıp kaydediliyor…"]]}
                />
              ) : (
                <>
                  {listRun && <ListImportSummary run={listRun} />}
                  <ListImportForm enabled={aiReady} />
                </>
              )}
              <div className="border-t border-border pt-4">
                <p className="mb-3 text-sm font-medium text-text">CSV dosyası</p>
                <CsvImportForm />
              </div>
            </CardBody>
          </Card>
        </div>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
          {([["me", "Benim firmalarım"], ["none", "Atanmamış"], [null, "Tümü"]] as const).map(([v, label]) => (
            <Link
              key={label}
              href={tabHref(v)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-sm",
                (v ?? "all") === ownerTab || (v === null && ownerTab === "all")
                  ? "border-accent bg-accent-soft text-accent-text"
                  : "border-border text-text-2 hover:bg-surface-2",
              )}
            >
              {label}
            </Link>
          ))}
          {ownerTab === "other" && (
            <Badge tone="accent">{memberNames.get(parsed.owner ?? "") ?? "Kişi"} firmaları</Badge>
          )}
          {filter.listId && (
            <Badge tone="accent">
              Liste: {lists.find((l) => l.id === filter.listId)?.name ?? "seçili"}
            </Badge>
          )}
        </div>
        <form className="flex flex-wrap items-end gap-3 border-b border-border px-5 py-4" action="/leads">
          {parsed.owner && <input type="hidden" name="owner" value={parsed.owner} />}
          <Input name="q" defaultValue={sp.q ?? ""} placeholder="Firma, alan adı, şehir, sektör…" className="min-w-48 flex-1" aria-label="Ara" />
          <Select name="status" defaultValue={status ?? ""} className="w-44" aria-label="Durum">
            <option value="">Tüm durumlar</option>
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>{LEAD_STATUS_LABELS[s]}</option>
            ))}
          </Select>
          <Select name="min" defaultValue={minScore !== undefined ? String(minScore) : ""} className="w-36" aria-label="En az puan">
            <option value="">Tüm puanlar</option>
            <option value="70">70+</option>
            <option value="45">45+</option>
          </Select>
          <Select name="source" defaultValue={filter.source ?? ""} className="w-40" aria-label="Kaynak">
            <option value="">Tüm kaynaklar</option>
            {Object.entries(LEAD_SOURCE_FILTERS).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </Select>
          <Select name="email" defaultValue={filter.email ?? ""} className="w-40" aria-label="E-posta">
            <option value="">E-posta: hepsi</option>
            <option value="yes">E-postası olan</option>
            <option value="no">E-postası olmayan</option>
          </Select>
          <Select name="list" defaultValue={filter.listId ?? ""} className="w-52" aria-label="Liste">
            <option value="">Tüm listeler</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>{l.name} ({l.count})</option>
            ))}
          </Select>
          <Select name="campaign" defaultValue={filter.campaign ?? ""} className="w-48" aria-label="Kampanya">
            <option value="">Kampanya: hepsi</option>
            <option value="out">Kampanyada olmayanlar</option>
            <option value="in">Kampanyada olanlar</option>
          </Select>
          <Select name="sort" defaultValue={parsed.sort ?? "score"} className="w-44" aria-label="Sıralama">
            {Object.entries(LEAD_SORTS).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </Select>
          <Select name="per" defaultValue={String(pageSize)} className="w-32" aria-label="Sayfa boyutu">
            {LEAD_PAGE_SIZES.map((n) => (
              <option key={n} value={n}>{n} / sayfa</option>
            ))}
          </Select>
          <button type="submit" className={buttonClass("secondary")}>Filtrele</button>
        </form>
        {canWrite && (
          <BulkBar
            matching={total}
            filter={filterParams}
            campaigns={openCampaigns}
            members={members.map((m) => ({ id: m.user.id, name: m.user.name || m.user.email }))}
            lists={lists.map((l) => ({ id: l.id, name: l.name }))}
            statuses={LEAD_STATUSES.map((s) => [s, LEAD_STATUS_LABELS[s]] as [string, string])}
          />
        )}
        {prepRun && (
          <div className="border-b border-border px-5 py-3">
            {prepRunning ? (
              <JobPoller
                jobId={prepRun.id}
                label={`${prepRun.total} firma hazırlanıyor (e-posta → analiz → puan)…`}
                steps={[[0, "Firmalar sırayla işleniyor (firma başına 10-30 saniye)…"]]}
              />
            ) : (
              <PreparationSummary run={prepRun} />
            )}
          </div>
        )}
        {/* Filtre formunun DIŞINDA olmalı: iç içe <form> geçersizdir, tarayıcı butonu dış formu (filtre) gönderir */}
        {siteRun && (
          <div className="border-b border-border px-5 py-3">
            {siteRunning ? (
              <JobPoller
                jobId={siteRun.id}
                label={`${siteRun.total || ""} firmanın web sitesi aranıyor…`}
                steps={[[0, "Arama başlatılıyor…"], [15, "Google sonuçları bekleniyor (1-3 dakika)…"], [75, "Firma adıyla eşleştiriliyor…"]]}
              />
            ) : (
              <WebsiteDiscoverySummary run={siteRun} />
            )}
          </div>
        )}
        {emailRun && (
          <div className="border-b border-border px-5 py-3">
            {emailRunning ? (
              <JobPoller
                jobId={emailRun.id}
                label={`${emailRun.total} firmanın web sitesinde kurumsal e-posta aranıyor…`}
                steps={[[0, "Siteler sırayla taranıyor (firma başına birkaç saniye)…"]]}
              />
            ) : (
              <EmailDiscoverySummary run={emailRun} canWrite={canWrite} />
            )}
          </div>
        )}
        {canWrite && ((aiReady && unscored.length > 0) || (missingEmail.length > 0 && !emailRunning)) && (
          <div className="flex flex-wrap justify-end gap-3 border-b border-border px-5 py-3">
            {missingEmail.length > 0 && !emailRunning && <FindEmailsButton leadIds={missingEmail} />}
            {aiReady && unscored.length > 0 && (
              <ScoreLeadsButton leadIds={unscored} label={`Bu sayfadaki ${unscored.length} lead'i puanla (${unscored.length} kredi)`} />
            )}
          </div>
        )}

        {rows.length === 0 ? (
          <EmptyState
            icon={<Building2 className="size-8" />}
            title={total === 0 && !sp.q && !status ? "Henüz lead yok" : "Filtreye uyan lead yok"}
            description="AI ile arama yapın, CSV yükleyin veya elle ekleyin."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-border bg-surface-2/50 text-left text-[11px] font-semibold uppercase tracking-wider text-text-3">
                <tr>
                  {canWrite && <th className="w-10 py-2.5 pl-5"><SelectPageCheckbox /></th>}
                  <th className={cn("py-2.5", canWrite ? "px-3" : "px-5")}>Firma</th>
                  <th className="px-3 py-2.5 text-center">Puan</th>
                  <th className="px-3 py-2.5">Konum</th>
                  <th className="hidden px-3 py-2.5 lg:table-cell">Sektör</th>
                  <th className="px-3 py-2.5">Durum</th>
                  <th className="hidden px-3 py-2.5 lg:table-cell">Sorumlu</th>
                  <th className="hidden px-5 py-2.5 xl:table-cell">Kaynak</th>
                  {canWrite && <th className="w-12 px-3 py-2.5"><span className="sr-only">İşlemler</span></th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((l) => (
                  <tr key={l.id} className="group transition-colors hover:bg-surface-2/60 has-[input[data-bulk]:checked]:bg-accent-soft/40">
                    {canWrite && (
                      <td className="w-10 py-3 pl-5 align-top">
                        <input
                          type="checkbox"
                          name="leadId"
                          value={l.id}
                          form="bulk-form"
                          data-bulk
                          aria-label={`${l.companyName} seç`}
                          className="mt-1 size-4 cursor-pointer accent-[var(--accent)]"
                        />
                      </td>
                    )}
                    <td className={cn("max-w-80 py-3", canWrite ? "px-3" : "px-5")}>
                      <Link href={`/leads/${l.id}`} className="line-clamp-2 font-medium text-text group-hover:text-accent-text">{l.companyName}</Link>
                      <div className="mt-1 flex items-center gap-2.5 text-text-3">
                        <ContactIcon on={Boolean(l.phone)} label={l.phone ?? "Telefon yok"}><Phone /></ContactIcon>
                        <ContactIcon on={Boolean(l.genericEmail)} label={l.genericEmail ?? "E-posta yok"}><Mail /></ContactIcon>
                        <ContactIcon on={Boolean(l.website)} label={l.domain ?? "Web sitesi yok"}><Globe /></ContactIcon>
                        {l.domain && <span className="truncate text-xs">{l.domain}</span>}
                      </div>
                      {canWrite && !l.genericEmail && (
                        <details className="mt-1.5">
                          <summary className="cursor-pointer text-xs font-medium text-accent-text">+ e-posta ekle</summary>
                          <div className="mt-2">
                            <QuickEmailForm leadId={l.id} />
                          </div>
                        </details>
                      )}
                    </td>
                    <td className="px-3 py-3 text-center">
                      {l.fitScore === null ? <span className="text-xs text-text-3">—</span> : <ScorePill score={l.fitScore} />}
                    </td>
                    <td className="px-3 py-3 text-text-2">{[l.district, l.city].filter(Boolean).join(", ") || "—"}</td>
                    <td className="hidden max-w-52 truncate px-3 py-3 text-text-2 lg:table-cell">{l.industry ?? "—"}</td>
                    <td className="px-3 py-3">
                      <div className="flex flex-col items-start gap-1">
                        <Badge>{LEAD_STATUS_LABELS[l.status]}</Badge>
                        {l.campaignLeads.length > 0 && (
                          <Link href={`/campaigns/${l.campaignLeads[0]!.campaign.id}`} className="max-w-40 truncate text-[11px] text-accent-text hover:underline">
                            Kampanya: {l.campaignLeads[0]!.campaign.name}
                          </Link>
                        )}
                      </div>
                    </td>
                    <td className="hidden px-3 py-3 lg:table-cell">
                      {l.ownerId ? (
                        <span
                          title={memberNames.get(l.ownerId) ?? "Ekip üyesi"}
                          className="inline-grid size-7 place-items-center rounded-full bg-surface-2 text-[11px] font-semibold text-text-2 ring-1 ring-border"
                        >
                          {initials(memberNames.get(l.ownerId) ?? "?")}
                        </span>
                      ) : (
                        <span className="text-xs text-text-3">—</span>
                      )}
                    </td>
                    <td className="hidden px-5 py-3 xl:table-cell">
                      <div className="flex flex-wrap gap-1">
                        {[...new Set(l.sources.map((s) => s.provider))].map((p) => (
                          <span key={p} className="text-xs text-text-3">{SOURCE_LABELS[p] ?? p}</span>
                        ))}
                      </div>
                    </td>
                    {canWrite && (
                      <td className="px-3 py-3">
                        <div className="opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                          <QuickDeleteButton leadId={l.id} name={l.companyName} />
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <div className="flex items-center justify-between border-t border-border px-5 py-3 text-sm text-text-2">
            <span>{total} lead · sayfa {page}/{pages}</span>
            <div className="flex gap-2">
              {page > 1 && <LinkButton href={qs(page - 1)} variant="secondary" size="sm">Önceki</LinkButton>}
              {page < pages && <LinkButton href={qs(page + 1)} variant="secondary" size="sm">Sonraki</LinkButton>}
            </div>
          </div>
        )}
      </Card>
    </>
  );
}

function ContactIcon({ on, label, children }: { on: boolean; label: string; children: React.ReactNode }) {
  return (
    <span title={label} aria-label={label} className={cn("[&>svg]:size-3.5", on ? "text-success" : "text-text-3/50")}>
      {children}
    </span>
  );
}

/** Puan: renkli halka + sayı (70+ yeşil, 45+ turuncu, altı kırmızı) */
function ScorePill({ score }: { score: number }) {
  const tone = scoreTone(score);
  const color = tone === "success" ? "var(--success)" : tone === "warning" ? "var(--warning)" : "var(--danger)";
  return (
    <span
      className="inline-grid size-9 place-items-center rounded-full text-xs font-semibold tabular-nums text-text"
      style={{ background: `conic-gradient(${color} ${score * 3.6}deg, var(--surface-3) 0deg)` }}
      title={`Uygunluk puanı: ${score}/100`}
    >
      <span className="grid size-7 place-items-center rounded-full bg-surface">{score}</span>
    </span>
  );
}

function EmailDiscoverySummary({ run, canWrite }: { run: NonNullable<Awaited<ReturnType<typeof getLastEmailDiscovery>>>; canWrite: boolean }) {
  const when = run.finishedAt?.toLocaleString("tr-TR", { timeZone: "Europe/Istanbul", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  if (run.status !== "SUCCEEDED") {
    return <Alert tone="danger">E-posta araması tamamlanamadı{run.error ? `: ${run.error}` : "."} Tekrar deneyebilirsiniz.</Alert>;
  }
  const missing = run.notFound + run.blocked + run.failed;
  // E-postası çıkmayanların bir kısmında iletişim formu var: tek kanal o olabilir
  const withForm = run.items.filter((it) => !it.currentEmail && it.contactFormUrl).length;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text">
            Son e-posta araması{when ? <span className="font-normal text-text-3"> · {when}</span> : null}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <Badge tone="success">{run.found} firmada bulundu</Badge>
            {run.notFound > 0 && <Badge>{run.notFound} sitede kurumsal adres yok</Badge>}
            {run.blocked > 0 && <Badge title="Site robots.txt ile otomatik taramayı yasaklıyor; buna uyuyoruz">{run.blocked} site taramaya izin vermiyor</Badge>}
            {run.failed > 0 && <Badge tone="warning" title="Alan adı yok, site kapalı veya bağlantıyı reddediyor">{run.failed} site açılmıyor</Badge>}
            {withForm > 0 && <Badge tone="accent" title="Adres yok ama sitede mesaj formu var; mesajı siz gönderirsiniz">{withForm} firmada iletişim formu var</Badge>}
            <span className="text-xs text-text-3 self-center">toplam {run.total} firma</span>
          </div>
          {run.blocked > 0 && (
            <p className="mt-2 text-xs text-text-3">
              Taramaya izin vermeyen sitelerdeki adresi kendiniz görüp firmanın sayfasında &quot;İletişim bilgilerini düzenle&quot; ile girebilirsiniz.
            </p>
          )}
        </div>
        {missing > 0 && (
          <LinkButton href="/calls?view=all&noEmail=1" variant="secondary" size="sm">
            <Phone className="size-4" aria-hidden /> Bulunamayanları telefonla ara
          </LinkButton>
        )}
      </div>
      {run.items.length > 0 && (
        <details className="group rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-accent-text">Firma firma sonuçları göster ({run.items.length})</summary>
          <ul className="divide-y divide-border border-t border-border">
            {[...run.items]
              .sort((a, b) => OUTCOME_ORDER.indexOf(a.outcome) - OUTCOME_ORDER.indexOf(b.outcome))
              .map((it) => (
                <li key={it.leadId} className="flex flex-col gap-2 px-3 py-2.5 lg:flex-row lg:items-center lg:gap-3">
                  <span className="shrink-0 lg:w-36"><Badge tone={OUTCOME_META[it.outcome].tone}>{OUTCOME_META[it.outcome].label}</Badge></span>
                  <div className="min-w-0 flex-1">
                    <Link href={`/leads/${it.leadId}`} className="block truncate text-sm font-medium text-text hover:text-accent-text">{it.name}</Link>
                    <p className="text-xs text-text-2">
                      {it.currentEmail ? <span className="font-medium text-success">{it.currentEmail}</span> : it.reason}
                    </p>
                    {!it.currentEmail && it.contactFormUrl && (
                      <a
                        href={it.contactFormUrl}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="mt-0.5 inline-block truncate text-xs font-medium text-accent-text"
                      >
                        İletişim formunu aç →
                      </a>
                    )}
                  </div>
                  {canWrite && (
                    <div className="flex shrink-0 items-start gap-1.5">
                      {!it.currentEmail && <QuickEmailForm leadId={it.leadId} />}
                      <QuickDeleteButton leadId={it.leadId} name={it.name} />
                    </div>
                  )}
                </li>
              ))}
          </ul>
        </details>
      )}
    </div>
  );
}

const OUTCOME_ORDER = ["found", "blocked", "notFound", "failed"] as const;
const OUTCOME_META: Record<(typeof OUTCOME_ORDER)[number], { label: string; tone: "success" | "neutral" | "warning" }> = {
  found: { label: "Bulundu", tone: "success" },
  blocked: { label: "Taramaya izin yok", tone: "neutral" },
  notFound: { label: "Kurumsal adres yok", tone: "neutral" },
  failed: { label: "Site açılmıyor", tone: "warning" },
};

function ListImportSummary({ run }: { run: NonNullable<Awaited<ReturnType<typeof getLastListImport>>> }) {
  if (run.status !== "SUCCEEDED") {
    return <Alert tone="danger">Son liste içe aktarılamadı{run.error ? `: ${run.error}` : "."} Kredi iade edildi.</Alert>;
  }
  const added = (run.created ?? 0) + (run.merged ?? 0);
  return (
    <Alert tone={added > 0 ? "success" : "neutral"}>
      <p className="font-medium">
        Son liste: {run.created ?? 0} yeni firma eklendi{run.merged ? `, ${run.merged} mevcut kayıtla birleşti` : ""}.
      </p>
      <p className="mt-0.5 text-xs opacity-80">
        {run.structured ? "Sayfanın veri tablosundan AI kullanılmadan okundu (ücretsiz) · " : ""}
        {run.extracted ?? 0} firma okundu
        {run.dropped ? (run.structured ? ` · ${run.dropped} tekrar / adsız satır atlandı` : ` · ${run.dropped} tanesi kaynakta doğrulanamadığı için alınmadı`) : ""}
        {run.filteredOut ? ` · ${run.filteredOut} firma filtreye uymadığı için alınmadı` : ""}
        {run.truncated ? (run.structured ? " · tek seferde en fazla 1000 firma alınır" : " · liste uzundu, ilk kısmı işlendi (kalanı için sonraki sayfanın adresini girin)") : ""}
        {added === 0 && !run.structured ? " · firma çıkmadığı için kredi iade edildi" : ""}
      </p>
    </Alert>
  );
}

function PreparationSummary({ run }: { run: NonNullable<Awaited<ReturnType<typeof getLastPreparation>>> }) {
  if (run.status !== "SUCCEEDED") {
    return <Alert tone="danger">Son hazırlık tamamlanamadı{run.error ? `: ${run.error}` : "."} Ayrılan kredi iade edildi.</Alert>;
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-text">
        Son hazırlık: {run.total} firma
        <span className="ml-2 font-normal text-text-3">
          Adımlar: {[run.steps.email && "e-posta bul", run.steps.research && "analiz et", run.steps.score && "puanla"].filter(Boolean).join(" · ") || "yok"}
        </span>
      </p>
      <div className="flex flex-wrap gap-2">
        {run.steps.research && <Badge tone="accent">{run.researched ?? 0} analiz edildi</Badge>}
        {(run.steps.research || run.steps.score) && <Badge>{run.scored ?? 0} puanlandı</Badge>}
        {(run.steps.research || run.steps.score) && <Badge tone="success">{run.high ?? 0} firma 70+ puan</Badge>}
        {run.steps.email && <Badge>{run.emailsFound ?? 0} firmada e-posta bulundu</Badge>}
        <Badge>{run.withEmail ?? 0} firmanın e-postası var</Badge>
        {run.failed ? <Badge tone="warning">{run.failed} firmada hata</Badge> : null}
        {run.refunded ? <span className="self-center text-xs text-text-3">{run.refunded} kredi iade edildi</span> : null}
      </div>
      {!run.steps.research && !run.steps.score && (
        <p className="text-xs text-text-3">
          Bu çalıştırmada yalnızca e-posta arandı. Analiz ve puanlama için işlem çubuğunda &quot;Analiz et&quot; ve &quot;Puanla&quot; seçeneklerini işaretleyin
          (analiz için firmanın web sitesi gerekir).
        </p>
      )}
      {run.top && run.top.length > 0 && (
        <p className="text-xs text-text-2">
          En yüksek puanlılar:{" "}
          {run.top.map((t, i) => (
            <span key={t.id}>
              {i > 0 && " · "}
              <Link href={`/leads/${t.id}`} className="font-medium text-accent-text hover:underline">{t.companyName}</Link> ({t.fitScore})
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

function WebsiteDiscoverySummary({ run }: { run: NonNullable<Awaited<ReturnType<typeof getLastWebsiteDiscovery>>> }) {
  if (run.status !== "SUCCEEDED") {
    return <Alert tone="danger">Son site araması tamamlanamadı{run.error ? `: ${run.error}` : "."} Kredi iade edildi.</Alert>;
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-text">Son site araması: {run.total} firma</p>
      <div className="flex flex-wrap gap-2">
        <Badge tone="success">{run.found} firmada site bulundu</Badge>
        {run.notFound > 0 && <Badge>{run.notFound} firmada bulunamadı (kredi iade edildi)</Badge>}
      </div>
      {run.items.length > 0 && (
        <details className="rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-accent-text">Firma firma sonuçları göster ({run.items.length})</summary>
          <ul className="divide-y divide-border border-t border-border">
            {run.items.map((it) => (
              <li key={it.leadId} className="flex flex-col gap-1 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3">
                <Link href={`/leads/${it.leadId}`} className="min-w-0 truncate text-sm font-medium text-text hover:text-accent-text sm:w-72">{it.name}</Link>
                <span className="min-w-0 flex-1 text-xs text-text-2">
                  {it.website ? <span className="font-medium text-success">{it.website}</span> : it.reason}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Ad → baş harfler (sorumlu rozeti) */
function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toLocaleUpperCase("tr"))
      .join("") || "?"
  );
}
