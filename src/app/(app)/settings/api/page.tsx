import type { Metadata } from "next";
import { requireTenantPage } from "@/server/tenancy/context";
import { can } from "@/server/tenancy/permissions";
import { env } from "@/server/env";
import { listApiKeys, listWebhooks, WEBHOOK_EVENTS } from "@/server/services/integrations";
import { deleteWebhookAction, revokeApiKeyAction, testWebhookAction } from "@/app/actions/integrations";
import { ActionButton } from "@/components/action-button";
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState } from "@/components/ui";
import { ApiKeyForm, WebhookForm } from "./forms";

export const metadata: Metadata = { title: "API ve webhook" };

const fmt = (d: Date | null) => (d ? new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium", timeStyle: "short" }).format(d) : "—");

export default async function ApiSettingsPage() {
  const ctx = await requireTenantPage();
  if (!can(ctx, "integrations.manage")) {
    return <Alert tone="neutral">API anahtarlarını ve webhook&apos;ları yalnızca yöneticiler yönetebilir.</Alert>;
  }
  const [keys, hooks] = await Promise.all([listApiKeys(ctx), listWebhooks(ctx)]);
  const base = `${env().APP_URL.replace(/\/$/, "")}/api/v1`;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader title="REST API" description="CRM, ERP veya kendi yazılımınızdan lead, fırsat ve görevlere erişin." />
        <CardBody className="flex flex-col gap-4">
          <div className="rounded-lg bg-surface-2 p-3 text-xs leading-relaxed text-text-2">
            <p>
              Adres: <code className="text-text">{base}</code> · Başlık: <code className="text-text">Authorization: Bearer sos_live_…</code> · Dakikada 120 istek
            </p>
            <p className="mt-1">
              <code>GET /leads</code> · <code>GET /leads/:id</code> · <code>POST /leads</code> (tekrar eden firma birleştirilir) · <code>GET /opportunities</code> ·{" "}
              <code>GET /tasks</code> · <code>POST /tasks</code>
            </p>
          </div>
          <ApiKeyForm />
          {keys.length > 0 && (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {keys.map((k) => (
                <li key={k.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                  <span className="font-medium text-text">{k.name}</span>
                  <code className="text-xs text-text-3">{k.prefix}…</code>
                  <Badge>{k.scopes.includes("write") ? "Okuma + yazma" : "Okuma"}</Badge>
                  {k.revokedAt ? <Badge tone="danger">Geri çekildi</Badge> : null}
                  <span className="ml-auto text-xs text-text-3">Son kullanım: {fmt(k.lastUsedAt)}</span>
                  {!k.revokedAt && (
                    <form action={revokeApiKeyAction}>
                      <input type="hidden" name="id" value={k.id} />
                      <Button type="submit" variant="ghost" size="sm">Geri çek</Button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Webhook'lar"
          description="Olay olduğunda adresinize imzalı POST gönderilir (Zapier, Make, n8n…). Başarısız teslim 4 kez denenir; üst üste 20 başarısızlıkta webhook kapanır."
        />
        <CardBody className="flex flex-col gap-4">
          <p className="rounded-lg bg-surface-2 p-3 text-xs text-text-2">
            Doğrulama: <code className="text-text">X-SOS-Signature = sha256=HMAC_SHA256(sır, X-SOS-Timestamp + &quot;.&quot; + gövde)</code>. 5 dakikadan eski zaman damgalarını reddedin.
          </p>
          <WebhookForm events={Object.entries(WEBHOOK_EVENTS)} />
          {hooks.length === 0 ? (
            <EmptyState title="Webhook yok" />
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {hooks.map((h) => (
                <li key={h.id} className="flex flex-col gap-2 px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium text-text">{h.url}</span>
                    {h.active ? <Badge tone="success">Aktif</Badge> : <Badge tone="danger">Kapalı</Badge>}
                    {h.lastStatus != null && <Badge tone={h.lastStatus < 300 ? "success" : "danger"}>HTTP {h.lastStatus}</Badge>}
                  </div>
                  <p className="text-xs text-text-3">{h.events.join(", ")} · son teslim {fmt(h.lastDeliveredAt)}</p>
                  {h.lastError && <p className="text-xs text-danger">Son hata: {h.lastError}</p>}
                  <div className="flex gap-2">
                    <ActionButton action={testWebhookAction} fields={{ id: h.id }} variant="secondary">Test gönder</ActionButton>
                    <form action={deleteWebhookAction}>
                      <input type="hidden" name="id" value={h.id} />
                      <Button type="submit" variant="ghost" size="sm">Sil</Button>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
