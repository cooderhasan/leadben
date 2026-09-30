import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireTenantPage } from "@/server/tenancy/context";
import { assertCan } from "@/server/tenancy/permissions";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { listWhatsAppTemplates } from "@/server/services/whatsapp";
import { BASIS_LABELS } from "@/lib/compliance";
import { Alert, Card, CardBody, CardHeader, PageHeader } from "@/components/ui";
import { TemplateSendForm } from "../../../messages/c/[id]/whatsapp-forms";

export const metadata: Metadata = { title: "WhatsApp şablonu" };

/** İşletmenin başlattığı WhatsApp mesajı: yalnızca onaylı şablon, yalnızca izni / dayanağı olan kişiye. */
export default async function WhatsAppTemplatePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ contactId?: string }> }) {
  const ctx = await requireTenantPage();
  assertCan(ctx, "whatsapp.template");
  const { id } = await params;
  const { contactId } = await searchParams;
  const db = tenantDb(ctx);
  const lead = await db.lead.findUnique({ where: { id }, select: { id: true, companyName: true } });
  if (!lead) notFound();
  const contacts = await db.leadContact.findMany({ where: { leadId: id, phone: { not: null } }, orderBy: { createdAt: "asc" } });
  const contact = contacts.find((c) => c.id === contactId) ?? contacts[0] ?? null;

  let templates: Awaited<ReturnType<typeof listWhatsAppTemplates>> = [];
  let error: string | null = null;
  try {
    templates = await listWhatsAppTemplates(ctx);
  } catch (err) {
    error = (err as Error).message;
  }
  const allowed =
    contact &&
    !contact.optOut &&
    (contact.consentStatus === "GRANTED" || ["EXPLICIT_CONSENT", "EXISTING_RELATIONSHIP", "INBOUND_REQUEST"].includes(contact.communicationBasis));

  return (
    <>
      <Link href={`/leads/${id}`} className="mb-3 inline-flex items-center gap-1 text-sm text-text-2 hover:text-text">
        <ArrowLeft className="size-4" aria-hidden /> {lead.companyName}
      </Link>
      <PageHeader title="WhatsApp şablonu gönder" description="Meta onaylı şablonlar. Her gönderim tek tek, sizin onayınızla yapılır." />
      <Card className="max-w-2xl">
        <CardHeader
          title={contact ? `${contact.fullName ?? "Kişi"} · ${contact.phone}` : "Telefon numarası olan kişi yok"}
          description={contact ? `İletişim dayanağı: ${BASIS_LABELS[contact.communicationBasis]}${contact.consentStatus === "GRANTED" ? " · onay verdi" : ""}` : undefined}
        />
        <CardBody className="flex flex-col gap-4">
          {error && <Alert tone="danger">{error}</Alert>}
          {!contact ? (
            <p className="text-sm text-text-2">Lead&apos;e telefonlu bir kişi ekleyin.</p>
          ) : !allowed ? (
            <Alert tone="warning">
              Bu kişinin WhatsApp iletişimine izni veya sizinle ilişkisi kayıtlı değil. İzin almadan ticari WhatsApp mesajı gönderilmez
              (Meta politikası). Kişi size WhatsApp&apos;tan yazarsa dayanak otomatik &quot;Firmadan gelen talep&quot; olur.
            </Alert>
          ) : templates.length === 0 && !error ? (
            <Alert tone="neutral">Onaylı şablonunuz yok. Şablonları Meta Business Manager&apos;da oluşturup onaya gönderin.</Alert>
          ) : (
            <TemplateSendForm
              leadId={lead.id}
              contactId={contact.id}
              templates={templates.map((t) => ({ key: `${t.name}|${t.language}`, label: `${t.name} (${t.language})`, bodyText: t.bodyText, bodyParams: t.bodyParams }))}
            />
          )}
        </CardBody>
      </Card>
    </>
  );
}
