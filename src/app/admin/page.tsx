import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentUser } from "@/server/auth/session";
import { resolveTenant } from "@/server/tenancy/context";
import { getPlatformOverview } from "@/server/admin/stats";
import { logoutAction } from "@/app/actions/auth";
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, PageHeader, Stat } from "@/components/ui";
import { formatDate, formatDateTime, formatNumber } from "@/lib/cn";

export const metadata: Metadata = { title: "Platform yönetimi" };

export default async function AdminPage() {
  const user = await getCurrentUser();
  if (!user?.isPlatformAdmin) notFound();
  const [o, tenant] = await Promise.all([getPlatformOverview(), resolveTenant()]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <PageHeader
        title="Platform yönetimi"
        description="Tüm şirketler, AI maliyeti, başarısız işler ve audit log."
        actions={
          <div className="flex items-center gap-3">
            {/* Yöneticinin kendi şirketi yoksa uygulamaya dönüş /admin'e geri yönlenir; bağlantı gösterilmez */}
            {tenant && <Link href="/dashboard" className="text-sm text-accent">← Uygulamaya dön</Link>}
            <form action={logoutAction}>
              <Button type="submit" variant="ghost" size="sm">Çıkış yap</Button>
            </form>
          </div>
        }
      />

      <Card className="mb-6">
        <CardBody className="grid grid-cols-2 gap-6 py-5 sm:grid-cols-4">
          <Stat label="Şirket" value={formatNumber(o.companies.length)} />
          <Stat label="Kullanıcı" value={formatNumber(o.users)} />
          <Stat label="AI çağrısı (30 gün)" value={formatNumber(o.aiTotal.calls)} />
          <Stat label="AI maliyeti (30 gün)" value={`$${o.aiTotal.costUsd.toFixed(2)}`} />
        </CardBody>
      </Card>

      <Card className="mb-6">
        <CardHeader title="Şirketler" />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="border-b border-border text-left text-xs text-text-2">
              <tr>
                <th className="px-5 py-2.5 font-medium">Şirket</th>
                <th className="px-3 py-2.5 font-medium">Plan</th>
                <th className="px-3 py-2.5 text-right font-medium">Kredi</th>
                <th className="px-3 py-2.5 text-right font-medium">Üye / Ürün / Doküman / Lead</th>
                <th className="px-3 py-2.5 text-right font-medium">AI (30g)</th>
                <th className="px-5 py-2.5 font-medium">Kurulum</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {o.companies.map((c) => (
                <tr key={c.id}>
                  <td className="px-5 py-2.5"><p className="font-medium">{c.name}</p><p className="text-xs text-text-3">{formatDate(c.createdAt)}</p></td>
                  <td className="px-3 py-2.5">{c.subscription?.plan ?? "—"}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{formatNumber(c.creditBalance)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{c._count.members} / {c._count.products} / {c._count.documents} / {c._count.leads}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">${c.aiCostUsd30d.toFixed(2)} <span className="text-text-3">({c.aiCalls30d})</span></td>
                  <td className="px-5 py-2.5">{c.onboardingCompletedAt ? <Badge tone="success">Tamam</Badge> : <Badge>Devam ediyor</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Başarısız işler" />
          {o.failedJobs.length === 0 ? <EmptyState title="Başarısız iş yok" /> : (
            <ul className="divide-y divide-border">
              {o.failedJobs.map((j) => (
                <li key={j.id} className="px-5 py-2.5">
                  <p className="text-sm font-medium">{j.type} <span className="text-xs text-text-3">· {j.attempts} deneme · {formatDateTime(j.createdAt)}</span></p>
                  <p className="line-clamp-2 text-xs text-danger">{j.error}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Audit log" />
          <ul className="divide-y divide-border">
            {o.recentAudit.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 px-5 py-2 text-sm">
                <span className="truncate">{a.action}</span>
                <span className="flex shrink-0 items-center gap-2">
                  {a.actorType !== "USER" && <Badge tone="accent">{a.actorType}</Badge>}
                  <span className="text-xs text-text-3">{formatDateTime(a.createdAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </main>
  );
}
