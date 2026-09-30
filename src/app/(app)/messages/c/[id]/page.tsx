import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Send, Sparkles } from "lucide-react";
import { requireTenantPage } from "@/server/tenancy/context";
import { can } from "@/server/tenancy/permissions";
import { isAIConfigured } from "@/server/ai";
import { isEmailConfigured } from "@/server/providers/email";
import { getConversation, REPLY_CATEGORY_LABELS, stripQuotedReply } from "@/server/services/conversations";
import { draftReplyAction, sendReplyAction } from "@/app/actions/conversations";
import { ActionButton } from "@/components/action-button";
import { Alert, Badge, Card, CardBody, CardHeader, PageHeader } from "@/components/ui";
import { isAppError } from "@/lib/errors";
import { LEAD_STATUS_LABELS } from "@/server/services/leads";
import { MessageCard } from "../../../campaigns/campaign-forms";
import { toMessageCard } from "../../../campaigns/message-data";
import { SESSION_WINDOW_MS } from "@/server/services/whatsapp";
import { WhatsAppReplyForm } from "./whatsapp-forms";

export const metadata: Metadata = { title: "Konuşma" };

const fmt = (d: Date) => new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium", timeStyle: "short" }).format(d);

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireTenantPage();
  const { id } = await params;
  let conv;
  try {
    conv = await getConversation(ctx, id);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const canApprove = can(ctx, "message.approve");
  const canSend = can(ctx, "email.send");
  const unsubscribed = conv.messages.some((m) => m.category === "UNSUBSCRIBE");

  // Zaman sırasına göre birleşik akış: gönderilen iletiler + gelen yanıtlar
  const sent = conv.outbound.filter((m) => ["SENT", "DELIVERED", "BOUNCED"].includes(m.status));
  const timeline = [
    ...sent.map((m) => ({ kind: "out" as const, at: m.sentAt ?? m.createdAt, id: m.id, subject: m.subject, body: m.body, meta: null as string | null })),
    ...conv.messages.map((m) => ({
      kind: m.direction === "INBOUND" ? ("in" as const) : ("out" as const),
      at: m.receivedAt,
      id: m.id,
      subject: m.subject,
      body: m.direction === "INBOUND" ? stripQuotedReply(m.body) : m.body,
      meta: m.category ? `${REPLY_CATEGORY_LABELS[m.category]}${m.categoryConfidence != null ? ` · %${Math.round(m.categoryConfidence * 100)}` : ""}` : null,
      summary: m.aiSummary,
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  const drafts = conv.outbound.filter((m) => ["PENDING_APPROVAL", "APPROVED", "SCHEDULED", "FAILED"].includes(m.status) && !m.campaignStepId);
  const hasOpenDraft = drafts.some((d) => d.status === "PENDING_APPROVAL" || d.status === "APPROVED");
  // WhatsApp: müşterinin son mesajından beri geçen süreye göre kalan yanıt penceresi (saat)
  const lastInbound = [...conv.messages].reverse().find((m) => m.direction === "INBOUND");
  const waHoursLeft = lastInbound ? Math.floor((SESSION_WINDOW_MS - (Date.now() - lastInbound.receivedAt.getTime())) / 3600_000) : 0;

  return (
    <>
      <Link href="/messages?f=inbox" className="mb-3 inline-flex items-center gap-1 text-sm text-text-2 hover:text-text">
        <ArrowLeft className="size-4" aria-hidden /> Gelen yanıtlar
      </Link>
      <PageHeader
        title={conv.lead.companyName}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Link href={`/leads/${conv.lead.id}`} className="hover:text-accent">Lead sayfası</Link>
            <Badge>{LEAD_STATUS_LABELS[conv.lead.status]}</Badge>
            {conv.category && <Badge tone={conv.category === "UNSUBSCRIBE" || conv.category === "NOT_INTERESTED" ? "danger" : "accent"}>{REPLY_CATEGORY_LABELS[conv.category]}</Badge>}
          </span>
        }
      />

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader title="Yazışma" />
          <CardBody className="flex flex-col gap-3">
            {timeline.map((t) => (
              <div key={`${t.kind}-${t.id}`} className={`max-w-[85%] rounded-lg border p-3 ${t.kind === "in" ? "self-start border-border bg-surface-2" : "self-end border-accent/30 bg-accent-soft"}`}>
                <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-text-3">
                  <span className="font-medium text-text-2">{t.kind === "in" ? "Alıcı" : "Siz"}</span>
                  <span>{fmt(t.at)}</span>
                  {t.meta && <Badge tone="accent">{t.meta}</Badge>}
                </div>
                {t.subject && <p className="text-sm font-medium text-text">{t.subject}</p>}
                <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-text">{t.body.slice(0, 5000)}</p>
                {"summary" in t && t.summary && <p className="mt-2 text-xs italic text-text-3">AI özeti: {t.summary}</p>}
              </div>
            ))}
          </CardBody>
        </Card>

        {conv.channel === "WHATSAPP" ? (
          <Card>
            <CardHeader title="WhatsApp yanıtı" description="Müşterinin son mesajından sonraki 24 saat içinde serbest metin gönderilebilir (Meta kuralı)." />
            <CardBody className="flex flex-col gap-3">
              {unsubscribed ? (
                <Alert tone="danger">Alıcı ret bildirdi; bu numaraya mesaj gönderilmez.</Alert>
              ) : !can(ctx, "whatsapp.send") ? (
                <p className="text-sm text-text-2">Yanıt gönderme yetkiniz yok.</p>
              ) : waHoursLeft > 0 ? (
                <WhatsAppReplyForm conversationId={conv.id} hoursLeft={waHoursLeft} />
              ) : (
                <Alert tone="warning">
                  24 saatlik pencere kapandı. Yalnızca onaylı şablon gönderilebilir:{" "}
                  <Link href={`/leads/${conv.lead.id}/whatsapp${conv.contactId ? `?contactId=${conv.contactId}` : ""}`} className="font-medium underline">şablon gönder</Link>
                </Alert>
              )}
            </CardBody>
          </Card>
        ) : (
        <Card>
          <CardHeader
            title="Yanıtınız"
            description="AI, yalnızca doğrulanmış bilgilerinizle taslak yazar; cevaplayamadığı soruları işaretler. Fiyatı siz belirlersiniz."
            action={
              canApprove && isAIConfigured() && !unsubscribed && !hasOpenDraft ? (
                <ActionButton action={draftReplyAction} fields={{ conversationId: conv.id }} pendingText="Yazılıyor…">
                  <Sparkles className="size-4" aria-hidden /> AI yanıt taslağı (1 kredi)
                </ActionButton>
              ) : undefined
            }
          />
          <CardBody className="flex flex-col gap-3">
            {unsubscribed && <Alert tone="danger">Alıcı ret bildirdi; bu adrese yeni ileti gönderilmez.</Alert>}
            {drafts.length === 0 && !unsubscribed && <p className="text-sm text-text-2">Henüz yanıt taslağı yok.</p>}
            {drafts.map((d) => (
              <div key={d.id} className="flex flex-col gap-2">
                <MessageCard m={toMessageCard(d, conv.lead.companyName, canApprove)} />
                {d.status === "APPROVED" && canSend && (
                  isEmailConfigured() ? (
                    <ActionButton action={sendReplyAction} fields={{ messageId: d.id, conversationId: conv.id }} confirm="Bu yanıt şimdi gönderilsin mi?">
                      <Send className="size-4" aria-hidden /> Gönder
                    </ActionButton>
                  ) : (
                    <Alert tone="warning">E-posta sağlayıcısı yapılandırılmamış; yanıtı kendi posta kutunuzdan gönderebilirsiniz.</Alert>
                  )
                )}
              </div>
            ))}
          </CardBody>
        </Card>
        )}
      </div>
    </>
  );
}
