import type { Metadata } from "next";
import Link from "next/link";
import { Phone, PhoneCall } from "lucide-react";
import { requireTenantPage } from "@/server/tenancy/context";
import { can } from "@/server/tenancy/permissions";
import { CALL_OUTCOME_LABELS, callQueueCounts, listCallQueue, type CallQueueView } from "@/server/services/calls";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { scoreTone } from "@/lib/lead-scoring";
import { cn } from "@/lib/cn";
import { CallResultForm } from "./call-forms";

export const metadata: Metadata = { title: "Arama listesi" };

const VIEWS: Array<[CallQueueView, string]> = [
  ["due", "Bugün aranacaklar"],
  ["later", "İleri tarihli"],
  ["all", "Tümü"],
];

const fmt = (d: Date) => d.toLocaleString("tr-TR", { timeZone: "Europe/Istanbul", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default async function CallsPage({ searchParams }: { searchParams: Promise<{ view?: string; noEmail?: string }> }) {
  const ctx = await requireTenantPage();
  const sp = await searchParams;
  const view = (VIEWS.find(([v]) => v === sp.view)?.[0] ?? "due") as CallQueueView;
  const onlyWithoutEmail = sp.noEmail === "1";
  const [rows, counts] = await Promise.all([listCallQueue(ctx, { view, onlyWithoutEmail }), callQueueCounts(ctx)]);
  const canWrite = can(ctx, "lead.write");
  const href = (v: CallQueueView, noEmail = onlyWithoutEmail) => `/calls?view=${v}${noEmail ? "&noEmail=1" : ""}`;
  const now = Date.now();

  return (
    <>
      <PageHeader
        title="Arama listesi"
        description="Telefonu olan firmalar; önce vakti gelen geri aramalar, sonra en yüksek puanlı aranmamışlar. Her görüşmenin sonucunu kaydedin — görev, fırsat ve izinler otomatik oluşur."
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {VIEWS.map(([v, label]) => (
          <Link
            key={v}
            href={href(v)}
            className={cn(
              "rounded-full border px-3 py-1.5 text-sm",
              v === view ? "border-accent bg-accent-soft text-accent-text" : "border-border text-text-2 hover:bg-surface-2",
            )}
          >
            {label}
            {v === "due" && counts.due > 0 ? ` (${counts.due})` : v === "later" && counts.later > 0 ? ` (${counts.later})` : ""}
          </Link>
        ))}
        <Link
          href={href(view, !onlyWithoutEmail)}
          className={cn("ml-auto rounded-full border px-3 py-1.5 text-sm", onlyWithoutEmail ? "border-accent bg-accent-soft text-accent-text" : "border-border text-text-2 hover:bg-surface-2")}
        >
          {onlyWithoutEmail ? "✓ " : ""}Yalnızca e-postası olmayanlar
        </Link>
      </div>

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<PhoneCall className="size-8" />}
            title={view === "due" ? "Bugün aranacak firma yok" : "Listede firma yok"}
            description={
              view === "due"
                ? "Yeni lead bulun veya ileri tarihli geri aramaları kontrol edin. Telefonu olmayan, engellenen ve kapanan firmalar listede görünmez."
                : "Telefonu olan, engellenmemiş firma bulunamadı."
            }
          />
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((r) => {
            const overdue = r.nextCallAt && r.nextCallAt.getTime() < now;
            return (
              <li key={r.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link href={`/leads/${r.id}`} className="truncate font-medium text-text hover:text-accent">{r.companyName}</Link>
                        {r.fitScore !== null && <Badge tone={scoreTone(r.fitScore)}>{r.fitScore}</Badge>}
                        {!r.genericEmail && <Badge>E-posta yok</Badge>}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-text-3">{[r.district, r.city, r.industry].filter(Boolean).join(" · ") || "—"}</p>
                      <p className="mt-1 text-xs text-text-2">
                        {r.lastCallOutcome ? (
                          <>
                            Son: {CALL_OUTCOME_LABELS[r.lastCallOutcome]}
                            {r.lastCallAt ? ` (${fmt(r.lastCallAt)})` : ""}
                            {r.callAttempts > 1 ? ` · ${r.callAttempts}. deneme` : ""}
                          </>
                        ) : (
                          "Henüz aranmadı"
                        )}
                        {r.nextCallAt && (
                          <span className={cn("ml-2", overdue ? "text-warning" : "text-text-3")}>· Aranacak: {fmt(r.nextCallAt)}</span>
                        )}
                      </p>
                      {r.calls[0]?.note && <p className="mt-1 line-clamp-2 text-xs text-text-3">“{r.calls[0].note}”</p>}
                    </div>
                    <a
                      href={`tel:${r.normalizedPhone ?? r.phone}`}
                      className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-white shadow-sm hover:bg-accent-hover"
                    >
                      <Phone className="size-4" aria-hidden /> {r.phone}
                    </a>
                  </div>
                  {canWrite && (
                    <details className="mt-3 border-t border-border pt-3">
                      <summary className="cursor-pointer text-sm font-medium text-accent-text">Görüşme sonucunu kaydet</summary>
                      <div className="mt-3 max-w-lg">
                        <CallResultForm leadId={r.id} />
                      </div>
                    </details>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
