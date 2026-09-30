import type { Metadata } from "next";
import Link from "next/link";
import { Activity, ArrowRight, Building2, Check, Factory, Megaphone, Package, Sparkles, TrendingUp } from "lucide-react";
import { requireTenantPage } from "@/server/tenancy/context";
import { getCompanyOverview, profileCompleteness } from "@/server/services/company";
import { getFunnelThisMonth, getRecentActivity } from "@/server/services/dashboard";
import { getTodayAgenda } from "@/server/services/crm";
import { Alert, Badge, Card, CardBody, CardHeader, LinkButton, PageHeader, Stat } from "@/components/ui";
import { cn, formatDateTime, formatNumber } from "@/lib/cn";

export const metadata: Metadata = { title: "Genel bakış" };

const ACTION_LABELS: Record<string, string> = {
  "user.registered": "Hesap oluşturuldu",
  "auth.login": "Giriş yapıldı",
  "company.website_analysis.started": "Web sitesi analizi başlatıldı",
  "company.website_analysis.completed": "Web sitesi analizi tamamlandı",
  "company.summary.verified": "Firma özeti onaylandı",
  "company.summary.corrected": "Firma özeti düzeltildi",
  "company.profile.updated": "Şirket profili güncellendi",
  "company.target_market.saved": "Hedef pazar kaydedildi",
  "company.exclusions.saved": "İstenmeyen müşteriler kaydedildi",
  "company.onboarding.completed": "Kurulum tamamlandı",
  "fact.verified": "Bilgiler onaylandı",
  "fact.corrected": "Bilgi düzeltildi",
  "fact.rejected": "Bilgiler reddedildi",
  "fact.added": "Şirket bilgisi eklendi",
  "product.created": "Ürün eklendi",
  "product.updated": "Ürün güncellendi",
  "product.verified": "Ürünler onaylandı",
  "product.verified_with_edits": "Ürün düzeltilip onaylandı",
  "product.created_from_fact": "Bulgudan ürün oluşturuldu",
  "product.deleted": "Ürün silindi",
  "knowledge.document.uploaded": "Doküman yüklendi",
  "knowledge.document.ingested": "Doküman işlendi",
  "knowledge.document.verified": "Doküman satışta kullanım için onaylandı",
  "knowledge.document.deleted": "Doküman silindi",
  "memory.created": "Şirket hafızasına kural eklendi",
  "competitor.created": "Rakip eklendi",
  "member.added": "Ekibe kullanıcı eklendi",
  "member.removed": "Ekipten kullanıcı çıkarıldı",
  "seed.demo_company_created": "Demo şirket oluşturuldu",
  "competitor.deleted": "Rakip silindi",
  "memory.archived": "Kural arşivlendi",
  "memory.activated": "Kural etkinleştirildi",
  "knowledge.document.unverified": "Doküman satış kullanımından çıkarıldı",
  // Faz 2 — lead
  "lead.discovered": "Lead'ler kaydedildi",
  "lead.search.started": "Lead araması başlatıldı",
  "lead.search.completed": "Lead araması tamamlandı",
  "lead.csv_imported": "CSV'den lead aktarıldı",
  "lead.created_manual": "Lead eklendi",
  "lead.research.started": "Lead araştırması başlatıldı",
  "lead.research.completed": "Lead araştırıldı ve puanlandı",
  "lead.scoring.started": "Lead puanlaması başlatıldı",
  "lead.scoring.completed": "Lead'ler puanlandı",
  "lead.status_changed": "Lead durumu değişti",
  "lead.deleted": "Lead silindi",
  // Faz 3 — kampanya ve gönderim
  "campaign.created": "Kampanya oluşturuldu",
  "campaign.strategy_generated": "AI kampanya stratejisi hazırladı",
  "campaign.strategy_approved": "Kampanya stratejisi onaylandı",
  "campaign.messages_generated": "AI kampanya mesajlarını yazdı",
  "campaign.approved": "Kampanya onaylandı",
  "campaign.sending_started": "Gönderim başlatıldı",
  "campaign.send_batch": "İletiler gönderildi",
  "campaign.paused": "Kampanya duraklatıldı",
  "campaign.send_failed": "Gönderim durdu",
  "message.approved": "Mesajlar onaylandı",
  "message.edited": "Mesaj düzenlendi",
  "suppression.added": "Engel listesine eklendi",
  "email.bounced": "E-posta geri döndü",
  "email.complaint": "Spam şikâyeti alındı",
  "compliance.reviewed": "Gönderim uygunluğu incelendi",
  // Faz 4 — yanıtlar ve CRM
  "conversation.reply_received": "Yanıt geldi",
  "conversation.reply_drafted": "AI yanıt taslağı hazırladı",
  "followup.processed": "Hatırlatma taslakları hazırlandı",
  "opportunity.created": "Fırsat oluşturuldu",
  "opportunity.stage_changed": "Fırsat aşaması değişti",
  "task.completed": "Görev tamamlandı",
  "call.logged": "Telefon görüşmesi kaydedildi",
  "email.test_sent": "Test e-postası gönderildi",
  "lead.list_import.started": "Listeden içe aktarma başlatıldı",
  "lead.list_import.completed": "Listeden firmalar içe aktarıldı",
  "lead.email_discovery.started": "Web sitelerinde e-posta araması başlatıldı",
  "lead.email_discovery.completed": "E-posta araması tamamlandı",
};

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const ctx = await requireTenantPage();
  const [{ welcome }, overview, funnel, activity, agenda] = await Promise.all([
    searchParams,
    getCompanyOverview(ctx),
    getFunnelThisMonth(ctx),
    getRecentActivity(ctx),
    getTodayAgenda(ctx),
  ]);
  const completeness = profileCompleteness(overview);
  const hasPipelineData = funnel.some((f) => f.value > 0);

  // "AI önerisi" — yalnızca gerçek duruma dayalı, veri yoksa uydurmaz
  const suggestions: Array<{ text: string; href: string; tone?: "danger" | "warning" | "accent" }> = agenda.map((a) => ({ text: a.text, href: a.href, tone: a.tone }));
  if (overview.pendingFacts > 0) suggestions.push({ text: `${overview.pendingFacts} AI bulgusu onayınızı bekliyor. Onaylanmayan bilgiler satış mesajlarında kullanılmaz.`, href: "/company" });
  if (overview.company.profile?.aiSummaryStatus !== "VERIFIED" && overview.company.profile?.aiSummary) suggestions.push({ text: "\"Firmayı böyle anladım\" özetini onaylayın.", href: "/company" });
  if (overview.products === 0) suggestions.push({ text: "En az bir ürün ekleyin — AI hangi lead'e hangi ürünü önereceğini buna göre belirler.", href: "/products/new" });
  if (overview.documents === 0) suggestions.push({ text: "Katalog veya teknik doküman yükleyin; AI ürün özelliklerini buradan öğrenir.", href: "/knowledge" });
  if (!overview.targetMarkets.some((t) => !t.isExcluded)) suggestions.push({ text: "Hedef müşteri tanımınızı yapın.", href: "/onboarding?step=target" });

  const today = new Intl.DateTimeFormat("tr-TR", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Istanbul" }).format(new Date());
  const funnelMax = Math.max(1, ...funnel.map((f) => f.value));

  return (
    <>
      {welcome && (
        <Alert tone="success" className="mb-6">
          Kurulum tamamlandı. AI artık şirketinizi tanıyor — bilgiler kalıcı olarak kaydedildi, tekrar anlatmanız gerekmez.
        </Alert>
      )}

      <PageHeader
        title="Bu hafta yeni satış fırsatları oluşturalım."
        description={<span className="capitalize">{today}</span>}
        actions={
          <>
            <LinkButton href="/leads" variant="secondary" size="lg">
              <Building2 className="size-4" aria-hidden /> Lead bul
            </LinkButton>
            <LinkButton href="/campaigns" size="lg">
              <Megaphone className="size-4" aria-hidden /> Yeni kampanya
            </LinkButton>
          </>
        }
      />

      {/* Bu ay — satış hunisi */}
      <Card className="mb-6">
        <CardHeader
          icon={<TrendingUp />}
          title="Bu ayın satış hunisi"
          description={hasPipelineData ? "Her adımın bir önceki adıma göre dönüşümü" : "Lead bulup kampanya gönderdikçe bu sayılar dolmaya başlar."}
        />
        <CardBody className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {funnel.map((f, i) => {
            const prev = i > 0 ? funnel[i - 1]!.value : 0;
            return (
              <div key={f.label} className="rounded-lg border border-border bg-surface-2/40 p-3">
                <p className="truncate text-xs font-medium text-text-2">{f.label}</p>
                <p className={cn("mt-1 text-2xl font-semibold tracking-tight tabular-nums", f.value === 0 ? "text-text-3" : "text-text")}>{formatNumber(f.value)}</p>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
                  <div className="h-full rounded-full bg-linear-to-r from-accent to-accent-2" style={{ width: `${(f.value / funnelMax) * 100}%` }} />
                </div>
                <p className="mt-1.5 h-4 text-[11px] text-text-3">{i > 0 && prev > 0 ? `%${Math.round((f.value / prev) * 100)} dönüşüm` : ""}</p>
              </div>
            );
          })}
        </CardBody>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* AI önerisi */}
        <Card className="lg:col-span-2">
          <CardHeader icon={<Sparkles />} title="Bugün ne yapmalıyım?" description="Gerçek kayıtlarınıza göre öncelik sırasıyla" />
          <CardBody>
            {suggestions.length === 0 ? (
              <div className="flex items-center gap-3 rounded-lg bg-success-soft px-4 py-3 text-sm text-success ring-1 ring-inset ring-success/20">
                <Check className="size-4 shrink-0" aria-hidden />
                Bekleyen iş yok. Yeni müşteri bulmak için lead araması yapın veya yüksek puanlı lead&apos;lerle kampanya oluşturun.
              </div>
            ) : (
              <ol className="flex flex-col gap-1.5">
                {suggestions.map((s, i) => (
                  <li key={s.text}>
                    <Link
                      href={s.href}
                      className="group flex items-start gap-3 rounded-lg border border-transparent p-2.5 transition-colors hover:border-border hover:bg-surface-2"
                    >
                      <span
                        className={cn(
                          "grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold ring-1 ring-inset",
                          s.tone === "danger"
                            ? "bg-danger-soft text-danger ring-danger/20"
                            : s.tone === "warning"
                              ? "bg-warning-soft text-warning ring-warning/20"
                              : "bg-accent-soft text-accent-text ring-accent/20",
                        )}
                      >
                        {i + 1}
                      </span>
                      <span className="flex-1 text-sm leading-relaxed text-text">{s.text}</span>
                      <ArrowRight className="mt-0.5 size-4 text-text-3 transition-transform group-hover:translate-x-0.5 group-hover:text-accent" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ol>
            )}
          </CardBody>
        </Card>

        {/* Profil tamamlanma */}
        <Card>
          <CardHeader icon={<Factory />} title="Şirket profili" description={`%${completeness.percent} tamamlandı`} />
          <CardBody>
            <div className="mb-4 h-2 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full bg-linear-to-r from-accent to-accent-2" style={{ width: `${completeness.percent}%` }} />
            </div>
            <ul className="flex flex-col gap-2.5">
              {completeness.checks.map((c) => (
                <li key={c.label} className="flex items-center gap-2.5 text-sm">
                  <span className={cn("grid size-5 place-items-center rounded-full", c.done ? "bg-success text-white" : "border border-border-strong")}>
                    {c.done && <Check className="size-3" aria-hidden />}
                  </span>
                  <span className={c.done ? "text-text-2" : "font-medium text-text"}>{c.label}</span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader icon={<Activity />} title="Son etkinlik" description="Sistemde yapılan son işlemler" />
          {activity.length === 0 ? (
            <CardBody><p className="text-sm text-text-2">Henüz etkinlik yok.</p></CardBody>
          ) : (
            <ul className="px-5 py-4">
              {activity.map((a, i) => (
                <li key={a.id} className="relative flex items-start gap-3 pb-3.5 last:pb-0">
                  {i < activity.length - 1 && <span className="absolute top-4 left-[5px] h-full w-px bg-border" aria-hidden />}
                  <span className={cn("relative mt-1.5 size-[11px] shrink-0 rounded-full ring-4 ring-surface", a.actorType === "AI" ? "bg-accent" : "bg-border-strong")} />
                  <span className="min-w-0 flex-1 text-sm text-text">{ACTION_LABELS[a.action] ?? a.action}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    {a.actorType === "AI" && <Badge tone="accent">AI</Badge>}
                    <span className="text-xs text-text-3 tabular-nums">{formatDateTime(a.createdAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader icon={<Package />} title="Satışta kullanılan bilgi" description="Yalnızca onaylı bilgiler mesajlara girer" />
          <CardBody className="grid grid-cols-2 gap-4">
            <Stat label="Onaylı ürün" value={overview.products} />
            <Stat label="Onaylı bilgi" value={overview.verifiedFacts} />
            <Stat label="Doküman" value={overview.documents} />
            <Stat label="Satış kuralı" value={overview.memories} />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
