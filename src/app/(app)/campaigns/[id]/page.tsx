import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Archive, CheckCircle2, Pause, Send, Sparkles, Wand2 } from "lucide-react";
import { requireTenantPage } from "@/server/tenancy/context";
import { can } from "@/server/tenancy/permissions";
import { isAIConfigured } from "@/server/ai";
import {
  CAMPAIGN_STATUS_LABELS,
  campaignPreview,
  getActiveCampaignJob,
  getCampaign,
  getLastCampaignJob,
  listCampaignMessages,
} from "@/server/services/campaigns";
import { campaignStrategySchema } from "@/server/ai/prompts/campaign";
import {
  approveCampaignAction,
  approveMessagesAction,
  archiveCampaignAction,
  generateMessagesAction,
  generateStrategyAction,
  pauseCampaignAction,
  removeCampaignLeadAction,
  startSendingAction,
} from "@/app/actions/campaigns";
import { JobPoller } from "@/components/job-poller";
import { ActionButton } from "@/components/action-button";
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, PageHeader, Stat } from "@/components/ui";
import { isAppError } from "@/lib/errors";
import { COMPLIANCE_LABELS } from "@/lib/compliance";
import { scoreTone } from "@/lib/lead-scoring";
import { MessageCard, StrategyApproveForm } from "../campaign-forms";
import { toMessageCard } from "../message-data";

export const metadata: Metadata = { title: "Kampanya" };

const JOB_LABELS: Record<string, string> = {
  "campaign.strategy": "AI kampanya stratejisini hazırlıyor…",
  "campaign.generate_messages": "AI kişiselleştirilmiş mesajları yazıyor…",
  "campaign.send": "Onaylı mesajlar gönderiliyor…",
};

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireTenantPage();
  const { id } = await params;
  let campaign;
  try {
    campaign = await getCampaign(ctx, id);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const [preview, messages, activeJob, lastJob] = await Promise.all([
    campaignPreview(ctx, id),
    listCampaignMessages(ctx, { campaignId: id, take: 300 }),
    getActiveCampaignJob(ctx, id),
    getLastCampaignJob(ctx, id),
  ]);

  const canWrite = can(ctx, "campaign.write");
  const canApproveMsg = can(ctx, "message.approve");
  const canApproveCampaign = can(ctx, "campaign.approve");
  const canSend = can(ctx, "email.send");
  const aiReady = isAIConfigured();
  const strategyParsed = campaignStrategySchema.safeParse(campaign.strategy);
  const strategy = strategyParsed.success ? strategyParsed.data : null;
  const verified = campaign.strategyStatus === "VERIFIED";
  const editableStage = ["DRAFT", "STRATEGY_REVIEW", "READY", "PAUSED"].includes(campaign.status);
  const pendingIds = messages
    .filter((m) => m.status === "PENDING_APPROVAL" && !((m.qualityNotes ?? {}) as { blocked?: boolean }).blocked && m.complianceStatus !== "DO_NOT_SEND")
    .map((m) => m.id);
  const lastSend = lastJob?.type === "campaign.send" && lastJob.status === "SUCCEEDED" ? (lastJob.result as { sent?: number; quotaReached?: boolean; remainingApproved?: number; skipped?: number } | null) : null;

  return (
    <>
      <Link href="/campaigns" className="mb-3 inline-flex items-center gap-1 text-sm text-text-2 hover:text-text">
        <ArrowLeft className="size-4" aria-hidden /> Kampanyalar
      </Link>
      <PageHeader
        title={campaign.name}
        description={campaign.targetDescription}
        actions={
          <>
            <Badge tone={campaign.status === "RUNNING" ? "accent" : campaign.status === "COMPLETED" ? "success" : "neutral"} className="self-center">
              {CAMPAIGN_STATUS_LABELS[campaign.status]}
            </Badge>
            {canWrite && campaign.status !== "RUNNING" && (
              <form action={archiveCampaignAction}>
                <input type="hidden" name="id" value={campaign.id} />
                <Button type="submit" variant="ghost" size="sm"><Archive className="size-4" aria-hidden /> Arşivle</Button>
              </form>
            )}
          </>
        }
      />

      {activeJob && (
        <div className="mb-6">
          <JobPoller jobId={activeJob.id} label={JOB_LABELS[activeJob.type] ?? "İşleniyor…"} />
        </div>
      )}
      {!activeJob && lastJob?.status === "FAILED" && (
        <Alert tone="warning" className="mb-6">Son işlem tamamlanamadı: {lastJob.error} {lastJob.type !== "campaign.send" && "Kredi iade edildi."}</Alert>
      )}
      {lastSend && (
        <Alert tone={lastSend.quotaReached ? "warning" : "success"} className="mb-6">
          Son gönderim: {lastSend.sent ?? 0} ileti gönderildi{lastSend.skipped ? `, ${lastSend.skipped} atlandı (engel / uyum)` : ""}.
          {lastSend.quotaReached && ` Günlük gönderim sınırına ulaşıldı; kalan ${lastSend.remainingApproved} ileti için yarın "Gönderimi sürdür"e basın.`}
        </Alert>
      )}

      <div className="flex flex-col gap-6">
        {/* 1) Strateji */}
        <Card>
          <CardHeader
            title="1. Strateji"
            description={verified ? "Onaylandı — mesajlar bu stratejiyle yazılır." : strategy ? "AI önerisi — kontrol edip onaylayın." : "AI, doğrulanmış şirket bilgileriniz ve hedef lead'lerle strateji önerir (3 kredi)."}
            action={verified ? <Badge tone="success"><CheckCircle2 className="size-3.5" aria-hidden /> Onaylı</Badge> : undefined}
          />
          <CardBody className="flex flex-col gap-4">
            {strategy && (
              <div className="grid gap-4 text-sm md:grid-cols-2">
                <div>
                  <p className="text-xs font-medium text-text-2">Değer önerisi</p>
                  <p className="mt-1 text-text">{strategy.valueProposition}</p>
                  <p className="mt-3 text-xs font-medium text-text-2">Ulaşılacak roller</p>
                  <p className="mt-1 text-text">{strategy.targetRoles.join(", ")}</p>
                  <p className="mt-3 text-xs font-medium text-text-2">Ana mesajlar</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-text">{strategy.keyMessages.map((k, i) => <li key={i}>{k}</li>)}</ul>
                </div>
                <div>
                  <p className="text-xs font-medium text-text-2">Çağrı · Üslup</p>
                  <p className="mt-1 text-text">{strategy.callToAction} · {strategy.tone}</p>
                  {strategy.objections.length > 0 && (
                    <>
                      <p className="mt-3 text-xs font-medium text-text-2">Olası itirazlar</p>
                      <ul className="mt-1 space-y-1 text-text">
                        {strategy.objections.map((o, i) => <li key={i}><span className="text-text-2">{o.objection}</span> → {o.answer}</li>)}
                      </ul>
                    </>
                  )}
                  <p className="mt-3 text-xs font-medium text-text-2">Adımlar</p>
                  <ol className="mt-1 space-y-0.5 text-text">
                    {strategy.sequence.map((s, i) => (
                      <li key={i}>
                        Gün {s.dayOffset}: {s.name}
                        {i > 0 && <span className="text-xs text-text-3"> (yanıt gelmezse AI hatırlatma taslağı hazırlar, siz onaylarsınız)</span>}
                      </li>
                    ))}
                  </ol>
                  {strategy.risks.length > 0 && (
                    <Alert tone="warning" className="mt-3">
                      <ul className="list-disc space-y-0.5 pl-4 text-xs">{strategy.risks.map((r, i) => <li key={i}>{r}</li>)}</ul>
                    </Alert>
                  )}
                </div>
              </div>
            )}
            {canWrite && !verified && strategy && (
              <StrategyApproveForm campaignId={campaign.id} valueProposition={strategy.valueProposition} callToAction={strategy.callToAction} tone={strategy.tone} />
            )}
            {canWrite && !verified && aiReady && !activeJob && editableStage && (
              <ActionButton action={generateStrategyAction} fields={{ id: campaign.id }} variant={strategy ? "secondary" : "primary"} pendingText="Başlatılıyor…">
                <Sparkles className="size-4" aria-hidden /> {strategy ? "Yeniden üret (3 kredi)" : "AI strateji öner (3 kredi)"}
              </ActionButton>
            )}
            {!aiReady && !strategy && <Alert tone="neutral">AI yapılandırılmadığı için strateji üretilemiyor.</Alert>}
          </CardBody>
        </Card>

        {/* 2) Lead'ler ve uyum */}
        <Card>
          <CardHeader
            title={`2. Lead'ler (${campaign.leads.length})`}
            description="Her adres gönderimden hemen önce tekrar kontrol edilir. &quot;İnceleme gerekli&quot; adresler, lead sayfasında dayanak seçilmeden gönderilmez."
          />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] text-sm">
              <thead className="border-b border-border text-left text-xs text-text-2">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Firma</th>
                  <th className="px-3 py-2.5 font-medium">Puan</th>
                  <th className="px-3 py-2.5 font-medium">Gönderim uygunluğu</th>
                  <th className="px-5 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {campaign.leads.map((cl) => (
                  <tr key={cl.id}>
                    <td className="px-5 py-2.5">
                      <Link href={`/leads/${cl.lead.id}#uyum`} className="font-medium text-text hover:text-accent">{cl.lead.companyName}</Link>
                      <span className="ml-2 text-xs text-text-3">{cl.lead.city}</span>
                    </td>
                    <td className="px-3 py-2.5">{cl.score !== null ? <Badge tone={scoreTone(cl.score)}>{cl.score}</Badge> : "—"}</td>
                    <td className="px-3 py-2.5">
                      {cl.complianceStatus ? (
                        <Badge tone={cl.complianceStatus === "SENDABLE" ? "success" : cl.complianceStatus === "DO_NOT_SEND" ? "danger" : "warning"}>
                          {COMPLIANCE_LABELS[cl.complianceStatus]}
                        </Badge>
                      ) : (
                        <Badge tone="danger">E-posta yok</Badge>
                      )}
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      {canWrite && editableStage && (
                        <form action={removeCampaignLeadAction}>
                          <input type="hidden" name="id" value={campaign.id} />
                          <input type="hidden" name="leadId" value={cl.lead.id} />
                          <Button type="submit" variant="ghost" size="sm">Çıkar</Button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* 3) Mesajlar */}
        <Card>
          <CardHeader
            title={`3. Mesajlar (${messages.length})`}
            description="Her mesaj ayrı onay ister. Doğrulanmamış iddia (fiyat, sertifika, rakam) içeren mesaj düzeltilmeden onaylanamaz."
            action={
              <div className="flex flex-wrap gap-2">
                {canApproveMsg && pendingIds.length > 1 && (
                  <ActionButton action={approveMessagesAction} fields={{ messageId: pendingIds, campaignId: campaign.id }} variant="secondary" confirm={`${pendingIds.length} mesajı okuduğunuzu ve onayladığınızı doğruluyor musunuz?`}>
                    <CheckCircle2 className="size-4" aria-hidden /> Sorunsuz {pendingIds.length} mesajı onayla
                  </ActionButton>
                )}
                {canWrite && verified && aiReady && !activeJob && editableStage && (
                  <ActionButton action={generateMessagesAction} fields={{ id: campaign.id }} pendingText="Başlatılıyor…">
                    <Wand2 className="size-4" aria-hidden /> {messages.length ? "Eksik mesajları üret" : "Mesajları üret"}
                  </ActionButton>
                )}
              </div>
            }
          />
          <CardBody className="flex flex-col gap-3">
            {!verified && <p className="text-sm text-text-2">Mesajlar strateji onaylandıktan sonra üretilir (lead başına 1 kredi).</p>}
            {verified && messages.length === 0 && (
              <EmptyState title="Henüz mesaj yok" description="&quot;Mesajları üret&quot; ile gönderilebilir veya incelenebilir her lead için kişiselleştirilmiş ilk temas e-postası yazılır." />
            )}
            {messages.map((m) => (
              <MessageCard key={m.id} m={toMessageCard(m, m.lead.companyName, canApproveMsg)} />
            ))}
          </CardBody>
        </Card>

        {/* 4) Önizleme, onay, gönderim */}
        <Card>
          <CardHeader title="4. Önizleme ve gönderim" description="Kampanya yönetici onayı olmadan gönderilemez. Onaydan sonra da her ileti tek tek kontrol edilir." />
          <CardBody className="flex flex-col gap-5">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Lead" value={preview.totalLeads} />
              <Stat label="Gönderilebilir" value={preview.sendable} />
              <Stat label="İnceleme gerekli" value={preview.review} />
              <Stat label="Gönderilmez" value={preview.doNotSend} sub={preview.suppressed ? `${preview.suppressed} engelli` : undefined} />
              <Stat label="Yüksek puan (70+)" value={preview.highScore} />
              <Stat label="Onaylı mesaj" value={preview.messages.APPROVED ?? 0} sub={`${preview.messages.SENT ?? 0} gönderildi`} />
            </div>

            {!preview.emailConfigured && (
              <Alert tone="warning">E-posta sağlayıcısı yapılandırılmamış (EMAIL_PROVIDER). Mesajları üretip onaylayabilirsiniz ama gönderim yapılamaz.</Alert>
            )}
            {preview.senderIssues.length > 0 && (
              <Alert tone="warning">
                <ul className="list-disc space-y-0.5 pl-4">{preview.senderIssues.map((s, i) => <li key={i}>{s}</li>)}</ul>
                <Link href="/settings/email" className="mt-1 inline-block font-medium underline">E-posta ayarlarına git</Link>
              </Alert>
            )}

            <div className="flex flex-wrap gap-3">
              {canApproveCampaign && ["DRAFT", "PAUSED"].includes(campaign.status) && !campaign.approvedAt && (
                <ActionButton
                  action={approveCampaignAction}
                  fields={{ id: campaign.id }}
                  confirm={`Kampanyayı onaylıyor musunuz? ${preview.messages.APPROVED ?? 0} onaylı mesaj gönderime hazır olacak.`}
                >
                  <CheckCircle2 className="size-4" aria-hidden /> Kampanyayı onayla
                </ActionButton>
              )}
              {canSend && campaign.approvedAt && ["READY", "PAUSED"].includes(campaign.status) && preview.emailConfigured && (preview.messages.APPROVED ?? 0) > 0 && (
                <ActionButton
                  action={startSendingAction}
                  fields={{ id: campaign.id }}
                  confirm={`${preview.messages.APPROVED} onaylı ileti gönderilecek (günlük sınır dahilinde). Devam edilsin mi?`}
                >
                  <Send className="size-4" aria-hidden /> {campaign.status === "PAUSED" || campaign.startedAt ? "Gönderimi sürdür" : "Gönderimi başlat"}
                </ActionButton>
              )}
              {canSend && campaign.status === "RUNNING" && (
                <form action={pauseCampaignAction}>
                  <input type="hidden" name="id" value={campaign.id} />
                  <Button type="submit" variant="secondary" size="sm"><Pause className="size-4" aria-hidden /> Duraklat</Button>
                </form>
              )}
            </div>
            {campaign.approvedAt && (
              <p className="text-xs text-text-3">
                Onay: {new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium", timeStyle: "short" }).format(campaign.approvedAt)}
              </p>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
