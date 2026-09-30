import type { Metadata } from "next";
import { requireTenantPage } from "@/server/tenancy/context";
import { can } from "@/server/tenancy/permissions";
import { env } from "@/server/env";
import { getWhatsAppSettings } from "@/server/services/whatsapp";
import { Alert, Badge, Card, CardBody, CardHeader } from "@/components/ui";
import { WhatsAppSettingsForm } from "./form";

export const metadata: Metadata = { title: "WhatsApp" };

export default async function WhatsAppSettingsPage() {
  const ctx = await requireTenantPage();
  const canManage = can(ctx, "whatsapp.settings");
  const s = await getWhatsAppSettings(ctx);
  const webhookUrl = s ? `${env().APP_URL.replace(/\/$/, "")}/api/webhooks/whatsapp/${s.id}` : null;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader
          title="WhatsApp Business (resmi Cloud API)"
          description="Yalnızca Meta'nın resmi WhatsApp Business Platform'u kullanılır. WhatsApp şifreniz veya telefonunuz hiçbir zaman istenmez."
          action={s ? <Badge tone={s.status === "ACTIVE" ? "success" : "danger"}>{s.status === "ACTIVE" ? "Bağlı" : "Hata"}</Badge> : <Badge>Bağlı değil</Badge>}
        />
        <CardBody className="flex flex-col gap-4">
          <Alert tone="neutral">
            <ul className="list-disc space-y-1 pl-4 text-sm">
              <li>Müşteri size yazdıysa, son mesajından sonraki <strong>24 saat</strong> içinde serbest metinle cevap verebilirsiniz.</li>
              <li>İlk mesajı siz atacaksanız yalnızca <strong>Meta onaylı şablon</strong> gönderilebilir ve yalnızca izin veren / sizinle ilişkisi olan kişiye.</li>
              <li>&quot;DUR&quot;, &quot;STOP&quot; yazan numara engel listesine girer; bir daha mesaj gönderilmez.</li>
              <li>Toplu WhatsApp gönderimi yapılmaz; her mesaj bir kullanıcı tarafından gönderilir.</li>
            </ul>
          </Alert>
          {s?.lastError && <Alert tone="danger">{s.lastError}</Alert>}
          {s?.displayPhone && (
            <p className="text-sm text-text-2">
              Numara: <strong className="text-text">{s.displayPhone}</strong> {s.verifiedName && `· ${s.verifiedName}`}
            </p>
          )}
          {canManage ? (
            <WhatsAppSettingsForm phoneNumberId={s?.phoneNumberId ?? ""} wabaId={s?.wabaId ?? ""} tokenMask={s?.tokenMask ?? null} />
          ) : (
            <Alert tone="neutral">Bu ayarları yalnızca yöneticiler değiştirebilir.</Alert>
          )}
        </CardBody>
      </Card>

      {s && canManage && webhookUrl && (
        <Card>
          <CardHeader title="Webhook kurulumu" description="Meta for Developers → uygulamanız → WhatsApp → Configuration → Webhook bölümüne girin ve 'messages' alanına abone olun." />
          <CardBody className="flex flex-col gap-3 text-sm">
            <div>
              <p className="text-xs text-text-2">Callback URL</p>
              <code className="block break-all rounded-lg bg-surface-2 px-3 py-2 text-text">{webhookUrl}</code>
            </div>
            <div>
              <p className="text-xs text-text-2">Verify token</p>
              <code className="block break-all rounded-lg bg-surface-2 px-3 py-2 text-text">{s.verifyToken}</code>
            </div>
            {!env().APP_URL.startsWith("https://") && <Alert tone="warning">Meta yalnızca https adresleri kabul eder; APP_URL https ile başlamalı.</Alert>}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
