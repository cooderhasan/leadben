import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CheckCircle2, Mail, Printer, Send, ThumbsDown, ThumbsUp } from "lucide-react";
import { requireTenantPage } from "@/server/tenancy/context";
import { can } from "@/server/tenancy/permissions";
import { getProposal, parseItems, PROPOSAL_STATUS_LABELS, proposalBlockers } from "@/server/services/proposals";
import { getActiveJob } from "@/server/services/jobs-view";
import { listProducts } from "@/server/services/products";
import { approveProposalAction, emailProposalAction, proposalOutcomeAction, submitProposalAction } from "@/app/actions/proposals";
import { ActionButton } from "@/components/action-button";
import { JobPoller } from "@/components/job-poller";
import { Alert, Badge, Card, CardBody, CardHeader, LinkButton, PageHeader } from "@/components/ui";
import { isAppError } from "@/lib/errors";
import { ProposalEditor } from "../proposal-editor";

export const metadata: Metadata = { title: "Teklif" };

export default async function ProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireTenantPage();
  const { id } = await params;
  let p;
  try {
    p = await getProposal(ctx, id);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const [products, job] = await Promise.all([listProducts(ctx, { status: "VERIFIED" }), getActiveJob(ctx, "proposal.draft", "proposalId", id)]);
  const items = parseItems(p.items);
  const canWrite = can(ctx, "lead.write");
  const canApprove = can(ctx, "proposal.approve");
  const editable = canWrite && (p.status === "DRAFT" || p.status === "PENDING_APPROVAL") && !job;
  const blockers = proposalBlockers(items, p.validUntil);

  return (
    <>
      <Link href="/proposals" className="mb-3 inline-flex items-center gap-1 text-sm text-text-2 hover:text-text">
        <ArrowLeft className="size-4" aria-hidden /> Teklifler
      </Link>
      <PageHeader
        title={`${p.number} — ${p.lead.companyName}`}
        description={<Badge tone={p.status === "ACCEPTED" ? "success" : p.status === "REJECTED" ? "danger" : "accent"}>{PROPOSAL_STATUS_LABELS[p.status]}</Badge>}
        actions={
          ["APPROVED", "SENT", "ACCEPTED"].includes(p.status) ? (
            <LinkButton href={`/print/proposals/${p.id}`} variant="secondary" target="_blank">
              <Printer className="size-4" aria-hidden /> Yazdır / PDF
            </LinkButton>
          ) : undefined
        }
      />

      {job && (
        <div className="mb-6">
          <JobPoller jobId={job.id} label="AI müşteri talebini onaylı ürünlerinizle eşleştiriyor…" />
        </div>
      )}

      <div className="flex flex-col gap-6">
        {p.missingInfo.length > 0 && (p.status === "DRAFT" || p.status === "PENDING_APPROVAL") && (
          <Alert tone="warning">
            <p className="mb-1 font-medium">Teklifi tamamlamak için:</p>
            <ul className="list-disc space-y-0.5 pl-5">{p.missingInfo.map((m, i) => <li key={i}>{m}</li>)}</ul>
          </Alert>
        )}

        <Card>
          <CardHeader title="Kalemler" description="Birim fiyatları siz girersiniz — AI fiyat üretmez. Düzenlenen teklif yeniden onaya gider." />
          <CardBody>
            <ProposalEditor
              key={p.updatedAt.toISOString()}
              id={p.id}
              items={items}
              products={products.filter((x) => x.active).map((x) => ({ id: x.id, name: x.name }))}
              currency={p.currency}
              validUntil={p.validUntil ? p.validUntil.toISOString().slice(0, 10) : null}
              deliveryTerms={p.deliveryTerms}
              terms={p.terms}
              editable={editable}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Onay ve gönderim" />
          <CardBody className="flex flex-col gap-3">
            {p.status === "DRAFT" && blockers.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-5 text-sm text-text-2">{blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
            )}
            <div className="flex flex-wrap gap-3">
              {canWrite && p.status === "DRAFT" && blockers.length === 0 && (
                <ActionButton action={submitProposalAction} fields={{ id: p.id }}>
                  <Send className="size-4" aria-hidden /> Onaya gönder
                </ActionButton>
              )}
              {canApprove && p.status === "PENDING_APPROVAL" && (
                <ActionButton action={approveProposalAction} fields={{ id: p.id }} confirm="Fiyatları ve koşulları kontrol ettiniz mi? Teklif onaylanacak.">
                  <CheckCircle2 className="size-4" aria-hidden /> Teklifi onayla
                </ActionButton>
              )}
              {p.status === "PENDING_APPROVAL" && !canApprove && <p className="text-sm text-text-2">Yönetici onayı bekleniyor.</p>}
              {can(ctx, "message.approve") && (p.status === "APPROVED" || p.status === "SENT") && (
                <ActionButton action={emailProposalAction} fields={{ id: p.id }} variant="secondary">
                  <Mail className="size-4" aria-hidden /> E-posta taslağı oluştur
                </ActionButton>
              )}
              {canWrite && p.status === "APPROVED" && (
                <ActionButton action={proposalOutcomeAction} fields={{ id: p.id, status: "SENT" }} variant="secondary">
                  Gönderildi olarak işaretle
                </ActionButton>
              )}
              {canWrite && (p.status === "APPROVED" || p.status === "SENT") && (
                <>
                  <ActionButton action={proposalOutcomeAction} fields={{ id: p.id, status: "ACCEPTED" }} variant="secondary" confirm="Teklif kabul edildi mi? Fırsat kazanıldı olarak kapanacak.">
                    <ThumbsUp className="size-4" aria-hidden /> Kabul edildi
                  </ActionButton>
                  <ActionButton action={proposalOutcomeAction} fields={{ id: p.id, status: "REJECTED" }} variant="ghost">
                    <ThumbsDown className="size-4" aria-hidden /> Reddedildi
                  </ActionButton>
                </>
              )}
            </div>
            {p.status === "REJECTED" && p.opportunity && (
              <p className="text-sm text-text-2">
                Fırsatı kapatmak ve nedenini kaydetmek için <Link href="/pipeline" className="text-accent">Pipeline</Link>&apos;a gidin.
              </p>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
