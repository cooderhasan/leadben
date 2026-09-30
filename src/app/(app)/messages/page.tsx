import type { Metadata } from "next";
import Link from "next/link";
import { Inbox, Mail } from "lucide-react";
import type { MessageStatus } from "@prisma/client";
import { requireTenantPage } from "@/server/tenancy/context";
import { can } from "@/server/tenancy/permissions";
import { listCampaignMessages, MESSAGE_STATUS_LABELS } from "@/server/services/campaigns";
import { listConversations, POSITIVE_CATEGORIES, REPLY_CATEGORY_LABELS, stripQuotedReply } from "@/server/services/conversations";
import { Badge, Card, CardBody, EmptyState, PageHeader } from "@/components/ui";
import { cn } from "@/lib/cn";
import { MessageCard } from "../campaigns/campaign-forms";
import { toMessageCard } from "../campaigns/message-data";

export const metadata: Metadata = { title: "Mesajlar" };

const FILTERS: Array<{ key: string; label: string; status?: MessageStatus }> = [
  { key: "inbox", label: "Gelen yanıtlar" },
  { key: "pending", label: "Onay bekleyen", status: "PENDING_APPROVAL" },
  { key: "approved", label: "Onaylı", status: "APPROVED" },
  { key: "sent", label: "Gönderilen", status: "SENT" },
  { key: "bounced", label: "Geri dönen", status: "BOUNCED" },
  { key: "failed", label: "Başarısız", status: "FAILED" },
  { key: "all", label: "Tüm gidenler" },
];

const fmt = (d: Date | null) => (d ? new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium", timeStyle: "short" }).format(d) : "");

export default async function MessagesPage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const ctx = await requireTenantPage();
  const { f } = await searchParams;
  const active = FILTERS.find((x) => x.key === f) ?? FILTERS[1]!;
  const inbox = active.key === "inbox";
  const [messages, conversations] = await Promise.all([
    inbox ? Promise.resolve([]) : listCampaignMessages(ctx, { status: active.status, take: 200 }),
    inbox ? listConversations(ctx) : Promise.resolve([]),
  ]);
  const canEdit = can(ctx, "message.approve");

  return (
    <>
      <PageHeader title="Mesajlar" description="Giden iletiler ve gelen yanıtlar. AI yazar ve sınıflandırır; siz onaylarsınız." />
      <nav className="mb-4 flex flex-wrap gap-2" aria-label="Durum filtresi">
        {FILTERS.map((x) => (
          <Link
            key={x.key}
            href={`/messages?f=${x.key}`}
            aria-current={x.key === active.key ? "page" : undefined}
            className={cn(
              "rounded-full border px-3 py-1 text-sm",
              x.key === active.key ? "border-accent bg-accent-soft text-accent-text" : "border-border text-text-2 hover:text-text",
            )}
          >
            {x.label}
          </Link>
        ))}
      </nav>

      {inbox ? (
        <Card>
          {conversations.length === 0 ? (
            <EmptyState
              icon={<Inbox className="size-8" />}
              title="Henüz yanıt yok"
              description="Yanıtlar e-posta sağlayıcınızın gelen kutusu webhook'u ile otomatik gelir; lead sayfasından elle de ekleyebilirsiniz."
            />
          ) : (
            <ul className="divide-y divide-border">
              {conversations.map((c) => {
                const last = c.messages[0];
                return (
                  <li key={c.id}>
                    <Link href={`/messages/c/${c.id}`} className="flex flex-col gap-1 px-5 py-3 hover:bg-surface-2 sm:flex-row sm:items-center sm:gap-4">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-text">{c.lead.companyName}</p>
                        <p className="truncate text-xs text-text-2">{last?.aiSummary ?? (last ? stripQuotedReply(last.body).slice(0, 160) : "")}</p>
                      </div>
                      {c.category ? (
                        <Badge tone={POSITIVE_CATEGORIES.includes(c.category) ? "success" : c.category === "UNSUBSCRIBE" || c.category === "NOT_INTERESTED" ? "danger" : "neutral"}>
                          {REPLY_CATEGORY_LABELS[c.category]}
                        </Badge>
                      ) : (
                        <Badge>Sınıflandırılıyor</Badge>
                      )}
                      <span className="text-xs text-text-3">{fmt(c.lastMessageAt)}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      ) : (
        <Card>
          {messages.length === 0 ? (
            <EmptyState
              icon={<Mail className="size-8" />}
              title={`${active.status ? MESSAGE_STATUS_LABELS[active.status] : "Hiç"} mesaj yok`}
              description="Mesajlar kampanya ekranında, strateji onaylandıktan sonra üretilir."
            />
          ) : (
            <CardBody className="flex flex-col gap-3">
              {messages.map((m) => (
                <div key={m.id}>
                  {m.campaign ? (
                    <Link href={`/campaigns/${m.campaign.id}`} className="mb-1 inline-block text-xs text-text-3 hover:text-accent">
                      {m.campaign.name}
                    </Link>
                  ) : m.conversationId ? (
                    <Link href={`/messages/c/${m.conversationId}`} className="mb-1 inline-block text-xs text-text-3 hover:text-accent">
                      Yanıt · konuşmaya git
                    </Link>
                  ) : null}
                  <MessageCard m={toMessageCard(m, m.lead.companyName, canEdit)} />
                </div>
              ))}
            </CardBody>
          )}
        </Card>
      )}
    </>
  );
}
