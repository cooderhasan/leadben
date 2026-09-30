import type { Metadata } from "next";
import { requireTenantPage, requireUserPage } from "@/server/tenancy/context";
import { can } from "@/server/tenancy/permissions";
import { env } from "@/server/env";
import { emailProviderLabel, isEmailConfigured } from "@/server/providers/email";
import { getSenderSettings } from "@/server/services/email-settings";
import { listSuppressions } from "@/server/services/compliance";
import { removeSuppressionAction } from "@/app/actions/email";
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState } from "@/components/ui";
import { DomainCheckButton, SenderForm, SuppressionAddForm, TestEmailForm } from "./email-forms";

export const metadata: Metadata = { title: "E-posta ve uyum" };

const SOURCE_LABELS: Record<string, string> = {
  UNSUBSCRIBE_LINK: "Ret bağlantısı",
  REPLY: "Yanıtla ret",
  MANUAL: "Elle",
  BOUNCE: "Geri döndü",
  COMPLAINT: "Spam şikâyeti",
};
const TYPE_LABELS: Record<string, string> = { EMAIL: "E-posta", DOMAIN: "Alan adı", PHONE: "Telefon", LEAD: "Firma" };
const DNS_TONE = { pass: "success", fail: "danger", missing: "warning", unknown: "neutral" } as const;
const DNS_LABEL = { pass: "Var", fail: "Hatalı", missing: "Yok", unknown: "Kontrol edilemedi" } as const;

export default async function EmailSettingsPage() {
  const ctx = await requireTenantPage();
  const user = await requireUserPage();
  const canManage = can(ctx, "email.settings");
  const canSuppress = can(ctx, "suppression.manage");
  const [{ settings, dns, checkedAt }, suppressions] = await Promise.all([getSenderSettings(ctx.companyId), listSuppressions(ctx)]);
  const provider = emailProviderLabel();

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader
          title="Gönderici kimliği"
          description="Ticari iletilerde gönderici kimliği ve ret bağlantısı zorunludur; sistem bunları her iletiye otomatik ekler."
        />
        <CardBody className="flex flex-col gap-4">
          {!canManage && <Alert tone="neutral">Bu ayarları yalnızca yöneticiler değiştirebilir.</Alert>}
          <SenderForm values={settings ?? {}} disabled={!canManage} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Teslim edilebilirlik" description={`Sağlayıcı: ${provider ?? "yapılandırılmamış"} · Günlük sınır: ${env().EMAIL_DAILY_LIMIT} ileti`} />
        <CardBody className="flex flex-col gap-4">
          {!isEmailConfigured() && (
            <Alert tone="warning">
              Sunucuda e-posta sağlayıcısı tanımlı değil (<code>EMAIL_PROVIDER</code> = smtp / resend / brevo). Kampanya hazırlayıp onaylayabilirsiniz ama gönderim yapılamaz.
            </Alert>
          )}
          {settings && (
            <>
              <div className="flex flex-wrap gap-4 text-sm">
                {(["spf", "dkim", "dmarc"] as const).map((k) => (
                  <div key={k} className="flex items-center gap-2">
                    <span className="uppercase text-text-2">{k}</span>
                    {dns ? <Badge tone={DNS_TONE[dns[k]]}>{DNS_LABEL[dns[k]]}</Badge> : <Badge>Kontrol edilmedi</Badge>}
                  </div>
                ))}
                {checkedAt && <span className="text-xs text-text-3">Son kontrol: {new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium", timeStyle: "short" }).format(checkedAt)}</span>}
              </div>
              {dns && dns.notes.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-xs text-text-2">{dns.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
              )}
              {canManage && <DomainCheckButton />}
            </>
          )}
          {canManage && (
            <div className="border-t border-border pt-4">
              <p className="mb-1 text-sm font-medium text-text">Test e-postası</p>
              <p className="mb-3 text-xs leading-relaxed text-text-3">
                Gerçek kampanyadan önce kendinize örnek bir ileti gönderin: SMTP ayarları çalışıyor mu, ileti spam&apos;e düşüyor mu, alt bilgi doğru mu?
                Müşteri iletisi sayılmaz, kredi harcamaz. Gmail ve Outlook adreslerine birer tane göndermeniz önerilir.
              </p>
              {!isEmailConfigured() ? (
                <p className="text-xs text-text-3">Önce sunucuda e-posta sağlayıcısını tanımlayın.</p>
              ) : !settings ? (
                <p className="text-xs text-text-3">Önce yukarıdaki gönderici kimliğini kaydedin.</p>
              ) : (
                <TestEmailForm defaultTo={user.email} />
              )}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={`Engel listesi (${suppressions.length})`}
          description="Bu adreslere, alan adlarına ve firmalara ileti gönderilmez. Alıcının kendi ret talepleri kaldırılamaz."
        />
        {canSuppress && (
          <CardBody className="border-b border-border">
            <SuppressionAddForm />
          </CardBody>
        )}
        {suppressions.length === 0 ? (
          <EmptyState title="Engel listesi boş" description="Ret bağlantısını kullanan, geri dönen veya spam şikâyeti yapan adresler buraya otomatik eklenir." />
        ) : (
          <ul className="divide-y divide-border">
            {suppressions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 px-5 py-2.5 text-sm">
                <Badge>{TYPE_LABELS[s.type] ?? s.type}</Badge>
                <span className="min-w-0 flex-1 truncate font-medium text-text">{s.type === "LEAD" ? "Firma kaydı" : s.value}</span>
                <Badge tone={s.source === "MANUAL" ? "neutral" : "warning"}>{SOURCE_LABELS[s.source] ?? s.source}</Badge>
                <span className="text-xs text-text-3">{new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium" }).format(s.createdAt)}</span>
                {canSuppress && s.source === "MANUAL" && (
                  <form action={removeSuppressionAction}>
                    <input type="hidden" name="id" value={s.id} />
                    <Button type="submit" variant="ghost" size="sm">Kaldır</Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
