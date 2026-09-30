import type { Metadata } from "next";
import { FileBarChart, Lightbulb, ShieldAlert, ThumbsUp } from "lucide-react";
import { requireTenantPage } from "@/server/tenancy/context";
import { can } from "@/server/tenancy/permissions";
import { isAIConfigured } from "@/server/ai";
import { listInsights, MIN_SENT_FOR_REPORT } from "@/server/services/insights";
import { dismissInsightAction, generateReportAction } from "@/app/actions/insights";
import { ActionButton } from "@/components/action-button";
import { Alert, Button, Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Raporlar" };

const fmt = (d: Date) => new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium", timeStyle: "short" }).format(d);
const ICONS = { report_positive: ThumbsUp, report_risk: ShieldAlert, report_action: Lightbulb, report_summary: FileBarChart } as const;

export default async function ReportsPage() {
  const ctx = await requireTenantPage();
  const insights = await listInsights(ctx);
  const canWrite = can(ctx, "campaign.write");

  return (
    <>
      <PageHeader
        title="Raporlar"
        description="AI, yalnızca Analitik ekranındaki gerçek metriklerle rapor yazar. Her içgörünün dayandığı veri saklanır; veride olmayan sayı içeren içgörü atılır."
        actions={
          canWrite && isAIConfigured() ? (
            <div className="flex gap-2">
              <ActionButton action={generateReportAction} fields={{ period: "7" }} variant="secondary" pendingText="Hazırlanıyor…">Haftalık rapor (3 kredi)</ActionButton>
              <ActionButton action={generateReportAction} fields={{ period: "30" }} pendingText="Hazırlanıyor…">Aylık rapor (3 kredi)</ActionButton>
            </div>
          ) : undefined
        }
      />
      {!isAIConfigured() && <Alert tone="neutral" className="mb-6">AI yapılandırılmadığı için rapor üretilemiyor.</Alert>}

      {insights.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FileBarChart className="size-8" />}
            title="Henüz rapor yok"
            description={`Rapor için dönemde en az ${MIN_SENT_FOR_REPORT} gönderilmiş ileti gerekir; veri azken AI yorumu yanıltıcı olur.`}
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {insights.map((i) => {
            const Icon = ICONS[i.type as keyof typeof ICONS] ?? Lightbulb;
            const basis = i.dataBasis as { evidence?: string[]; periodDays?: number };
            return (
              <Card key={i.id}>
                <CardHeader
                  title={
                    <span className="inline-flex items-center gap-2">
                      <Icon className="size-4 text-accent" aria-hidden /> {i.title}
                    </span>
                  }
                  description={`${fmt(i.createdAt)}${basis.periodDays ? ` · son ${basis.periodDays} gün` : ""}`}
                  action={
                    canWrite ? (
                      <form action={dismissInsightAction}>
                        <input type="hidden" name="id" value={i.id} />
                        <Button type="submit" variant="ghost" size="sm">Gizle</Button>
                      </form>
                    ) : undefined
                  }
                />
                <CardBody className="flex flex-col gap-2">
                  <p className="text-sm leading-relaxed text-text">{i.body}</p>
                  {basis.evidence?.length ? <p className="text-xs text-text-3">Dayandığı veri: {basis.evidence.join(", ")}</p> : null}
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
