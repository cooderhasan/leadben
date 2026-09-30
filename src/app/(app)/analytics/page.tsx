import type { Metadata } from "next";
import Link from "next/link";
import { requireTenantPage } from "@/server/tenancy/context";
import { getAnalytics } from "@/server/services/analytics";
import { REPLY_CATEGORY_LABELS } from "@/server/services/conversations";
import { CAMPAIGN_STATUS_LABELS } from "@/server/services/campaigns";
import { LOST_REASON_LABELS } from "@/server/services/crm";
import { Card, CardBody, CardHeader, EmptyState, PageHeader, Stat } from "@/components/ui";
import { cn, formatNumber } from "@/lib/cn";
import { MAILBOX_BUCKET_LABELS } from "@/lib/lead-normalize";
import type { LostReason } from "@prisma/client";

export const metadata: Metadata = { title: "Analitik" };

const PERIODS = [7, 30, 90];
const rate = (v: number | null) => (v === null ? "—" : `%${v.toLocaleString("tr-TR")}`);

function Bar({ label, value, max }: { label: string; value: number; max: number }) {
  return (
    <li className="grid grid-cols-[minmax(0,10rem)_1fr_3rem] items-center gap-3 text-sm">
      <span className="truncate text-text-2">{label}</span>
      <span className="h-2 overflow-hidden rounded-full bg-surface-2">
        <span className="block h-full rounded-full bg-accent" style={{ width: `${max > 0 ? Math.max(2, (value / max) * 100) : 0}%` }} />
      </span>
      <span className="text-right font-medium tabular-nums text-text">{formatNumber(value)}</span>
    </li>
  );
}

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ d?: string }> }) {
  const ctx = await requireTenantPage();
  const { d } = await searchParams;
  const days = PERIODS.includes(Number(d)) ? Number(d) : 30;
  const a = await getAnalytics(ctx, days);
  const f = a.funnel;
  const funnel = [
    { label: "Bulunan lead", value: f.leadsDiscovered },
    { label: "Yüksek puanlı (70+)", value: f.highScoreLeads },
    { label: "İletişim kurulan lead", value: f.leadsContacted },
    { label: "Yanıt", value: f.replies },
    { label: "Olumlu yanıt", value: f.positiveReplies },
    { label: "Açılan fırsat", value: f.opportunitiesCreated },
    { label: "Kazanılan", value: f.won },
  ];
  const funnelMax = Math.max(...funnel.map((x) => x.value), 1);
  const catMax = Math.max(...a.replyCategories.map((c) => c.count), 1);
  const empty = f.leadsDiscovered + f.emailsSent + f.replies === 0;
  const addressSent = a.addressTypes.reduce((s, r) => s + r.sent, 0);

  return (
    <>
      <PageHeader
        title="Analitik"
        description="Tüm sayılar kayıtlarınızdan hesaplanır; örnek veya tahmini değer gösterilmez."
        actions={
          <nav className="flex gap-1" aria-label="Dönem">
            {PERIODS.map((p) => (
              <Link
                key={p}
                href={`/analytics?d=${p}`}
                aria-current={p === days ? "page" : undefined}
                className={cn("rounded-full border px-3 py-1 text-sm", p === days ? "border-accent bg-accent-soft text-accent-text" : "border-border text-text-2")}
              >
                {p} gün
              </Link>
            ))}
          </nav>
        }
      />

      {empty ? (
        <Card>
          <EmptyState title={`Son ${days} günde veri yok`} description="Lead bulup kampanya gönderdikçe bu ekran dolar." />
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          <Card>
            <CardBody className="grid grid-cols-2 gap-4 sm:grid-cols-5">
              <Stat label="Gönderilen e-posta" value={formatNumber(f.emailsSent)} />
              <Stat label="Yanıt oranı" value={rate(a.rates.replyRatePct)} sub={`${f.replies} yanıt`} />
              <Stat label="Olumlu yanıt oranı" value={rate(a.rates.positiveReplyRatePct)} />
              <Stat label="Geri dönme" value={rate(a.rates.bounceRatePct)} sub={a.rates.bounceRatePct !== null && a.rates.bounceRatePct > 5 ? "Yüksek — adres kalitesini kontrol edin" : undefined} />
              <Stat label="Ret / şikâyet" value={rate(a.rates.unsubscribeRatePct)} sub={`${f.unsubscribes} adres`} />
            </CardBody>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title="Satış hunisi" description={`Son ${days} gün`} />
              <CardBody>
                <ul className="flex flex-col gap-2.5">{funnel.map((x) => <Bar key={x.label} label={x.label} value={x.value} max={funnelMax} />)}</ul>
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Yanıt türleri" description="AI sınıflandırması" />
              <CardBody>
                {a.replyCategories.length === 0 ? (
                  <p className="text-sm text-text-3">Bu dönemde sınıflandırılmış yanıt yok.</p>
                ) : (
                  <ul className="flex flex-col gap-2.5">
                    {a.replyCategories.map((c) => <Bar key={c.category} label={REPLY_CATEGORY_LABELS[c.category]} value={c.count} max={catMax} />)}
                  </ul>
                )}
              </CardBody>
            </Card>
          </div>

          <Card>
            <CardHeader
              title="Adres tipine göre yanıt"
              description="Hangi kutuya yazmak işe yarıyor: genel kutu mu, satınalma mı, kişiye özel adres mi."
            />
            {a.addressTypes.length === 0 ? (
              <CardBody><p className="text-sm text-text-3">Bu dönemde gönderilen ileti yok.</p></CardBody>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[520px] text-sm">
                    <thead className="border-b border-border text-left text-xs text-text-2">
                      <tr>
                        <th className="px-5 py-2.5 font-medium">Adres tipi</th>
                        <th className="px-3 py-2.5 text-right font-medium">Gönderilen</th>
                        <th className="px-3 py-2.5 text-right font-medium">Yanıt</th>
                        <th className="px-3 py-2.5 text-right font-medium">Olumlu</th>
                        <th className="px-3 py-2.5 text-right font-medium">Geri dönen</th>
                        <th className="px-5 py-2.5 text-right font-medium">Yanıt oranı</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {a.addressTypes.map((r) => (
                        <tr key={r.bucket}>
                          <td className="px-5 py-2.5 font-medium text-text">{MAILBOX_BUCKET_LABELS[r.bucket]}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{formatNumber(r.sent)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{formatNumber(r.replies)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{formatNumber(r.positive)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{formatNumber(r.bounced)}</td>
                          <td className="px-5 py-2.5 text-right tabular-nums">{rate(r.replyRatePct)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {addressSent < 30 && (
                  <CardBody className="border-t border-border pt-4">
                    <p className="text-sm text-text-3">
                      Bu dönemde {formatNumber(addressSent)} ileti gönderildi. Oranları karşılaştırmak için kırılım başına en az 30 gönderim gerekir; şimdilik yön gösterici sayın.
                    </p>
                  </CardBody>
                )}
              </>
            )}
          </Card>

          <Card>
            <CardHeader title="Kampanyalar" />
            {a.campaigns.length === 0 ? (
              <CardBody><p className="text-sm text-text-3">Bu dönemde kampanya yok.</p></CardBody>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="border-b border-border text-left text-xs text-text-2">
                    <tr>
                      <th className="px-5 py-2.5 font-medium">Kampanya</th>
                      <th className="px-3 py-2.5 font-medium">Durum</th>
                      <th className="px-3 py-2.5 text-right font-medium">Lead</th>
                      <th className="px-3 py-2.5 text-right font-medium">Gönderilen</th>
                      <th className="px-3 py-2.5 text-right font-medium">Yanıt</th>
                      <th className="px-3 py-2.5 text-right font-medium">Olumlu</th>
                      <th className="px-5 py-2.5 text-right font-medium">Yanıt oranı</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {a.campaigns.map((c) => (
                      <tr key={c.id}>
                        <td className="px-5 py-2.5"><Link href={`/campaigns/${c.id}`} className="font-medium text-text hover:text-accent">{c.name}</Link></td>
                        <td className="px-3 py-2.5 text-text-2">{CAMPAIGN_STATUS_LABELS[c.status as keyof typeof CAMPAIGN_STATUS_LABELS]}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{c.leads}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{c.sent}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{c.replies}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{c.positive}</td>
                        <td className="px-5 py-2.5 text-right tabular-nums">{rate(c.replyRatePct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader title="Kaybedilme nedenleri" description={`Kazanma oranı: ${rate(a.rates.winRatePct)}`} />
              <CardBody>
                {a.lostReasons.length === 0 ? (
                  <p className="text-sm text-text-3">Bu dönemde kaybedilen fırsat yok.</p>
                ) : (
                  <ul className="flex flex-col gap-2.5">
                    {a.lostReasons.map((r) => (
                      <Bar key={r.reason} label={LOST_REASON_LABELS[r.reason as LostReason]} value={r.count} max={Math.max(...a.lostReasons.map((x) => x.count))} />
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="AI kullanımı" />
              <CardBody className="grid grid-cols-3 gap-4">
                <Stat label="AI çağrısı" value={formatNumber(a.ai.calls)} />
                <Stat label="Harcanan kredi" value={formatNumber(a.ai.creditsUsed)} />
                <Stat label="Tahmini maliyet" value={`$${a.ai.costUsd.toFixed(2)}`} />
              </CardBody>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
