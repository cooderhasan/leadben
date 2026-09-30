import type { Metadata } from "next";
import { requireTenantPage } from "@/server/tenancy/context";
import { can } from "@/server/tenancy/permissions";
import { getUsageSummary } from "@/server/services/dashboard";
import { CREDIT_COSTS, OPERATION_LABELS } from "@/server/usage/credits";
import { Alert, Card, CardBody, CardHeader, EmptyState, Stat } from "@/components/ui";
import { cn, formatDateTime, formatNumber } from "@/lib/cn";

export const metadata: Metadata = { title: "Kullanım" };

export default async function UsagePage() {
  const ctx = await requireTenantPage();
  if (!can(ctx, "usage.read")) return <Alert>Kullanım bilgilerini yalnızca şirket yöneticileri görebilir.</Alert>;
  const u = await getUsageSummary(ctx);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardBody className="grid grid-cols-2 gap-6 py-5 sm:grid-cols-4">
          <Stat label="Kalan kredi" value={formatNumber(u.creditBalance)} />
          <Stat label="AI çağrısı (30 gün)" value={formatNumber(u.ai30d.calls)} />
          <Stat label="Token (30 gün)" value={formatNumber(u.ai30d.inputTokens + u.ai30d.outputTokens)} />
          <Stat label="Tahmini AI maliyeti (30 gün)" value={`$${u.ai30d.costUsd.toFixed(2)}`} sub="Platform maliyeti, faturanız değil" />
        </CardBody>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <Card>
          <CardHeader title="Kredi hareketleri" />
          {u.usage.length === 0 ? (
            <EmptyState title="Henüz hareket yok" />
          ) : (
            <ul className="divide-y divide-border">
              {u.usage.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                  <span className="min-w-0 truncate">{OPERATION_LABELS[r.operation] ?? r.operation}</span>
                  <span className="flex shrink-0 items-center gap-3">
                    <span className="text-xs text-text-3">{formatDateTime(r.createdAt)}</span>
                    <span className={cn("w-14 text-right font-medium tabular-nums", r.credits < 0 ? "text-text" : "text-success")}>
                      {r.credits > 0 ? "+" : ""}{r.credits}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Kredi tablosu" />
          <ul className="divide-y divide-border">
            {Object.entries(CREDIT_COSTS).map(([op, cost]) => (
              <li key={op} className="flex justify-between px-5 py-2.5 text-sm">
                <span className="text-text-2">{OPERATION_LABELS[op] ?? op}</span>
                <span className="font-medium">{cost} kredi</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
