import type { Message } from "@prisma/client";
import { COMPLIANCE_LABELS } from "@/lib/compliance";
import { MESSAGE_STATUS_LABELS, type MessageQualityNotes } from "@/server/services/campaigns";
import type { MessageCardData } from "./campaign-forms";

/** Sunucu Message kaydını istemci kart verisine çevirir (yalnızca gösterilecek alanlar). */
export function toMessageCard(
  m: Pick<Message, "id" | "campaignId" | "subject" | "body" | "status" | "toAddress" | "leadId" | "qualityScore" | "complianceStatus" | "qualityNotes" | "error">,
  leadName: string,
  canEdit: boolean,
): MessageCardData {
  const notes = (m.qualityNotes ?? {}) as Partial<MessageQualityNotes>;
  return {
    id: m.id,
    campaignId: m.campaignId,
    subject: m.subject,
    body: m.body,
    status: m.status,
    statusLabel: MESSAGE_STATUS_LABELS[m.status],
    toAddress: m.toAddress,
    leadName,
    leadId: m.leadId,
    qualityScore: m.qualityScore,
    complianceStatus: m.complianceStatus,
    complianceLabel: m.complianceStatus ? COMPLIANCE_LABELS[m.complianceStatus] : null,
    issues: (notes.issues ?? []).map((i) => ({ severity: i.severity, text: i.text })),
    personalization: notes.personalization ?? [],
    error: m.error,
    canEdit,
  };
}
