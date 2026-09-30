"use client";

import { useState } from "react";
import { AlertTriangle, Check, Pencil, X } from "lucide-react";
import {
  approveMessagesAction,
  approveStrategyAction,
  createCampaignAction,
  saveMessageAction,
} from "@/app/actions/campaigns";
import { ActionForm, FormMessage, SubmitButton } from "@/components/forms";
import { Badge, Button, Field, Input, Select, Textarea } from "@/components/ui";

export function CampaignCreateForm({ products }: { products: Array<{ id: string; name: string }> }) {
  return (
    <ActionForm action={createCampaignAction}>
      {(state) => (
        <>
          <FormMessage state={state} />
          <Field label="Kampanya adı" htmlFor="name" error={state.fieldErrors?.name}>
            <Input id="name" name="name" required maxLength={120} placeholder="ör. Bursa otomotiv yan sanayi — basma yay" />
          </Field>
          <Field
            label="Hedef ve amaç"
            htmlFor="targetDescription"
            hint="Kime, hangi ürünle, ne amaçla ulaşmak istiyorsunuz? AI stratejiyi buna göre hazırlar."
            error={state.fieldErrors?.targetDescription}
          >
            <Textarea
              id="targetDescription"
              name="targetDescription"
              rows={3}
              required
              maxLength={1500}
              placeholder="ör. Pres ve kalıp kullanan otomotiv yan sanayi firmalarına basma yaylarımızı tanıtıp katalog talebi almak"
            />
          </Field>
          {products.length > 0 && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium text-text">Kampanya ürünleri (onaylı)</legend>
              <div className="flex flex-wrap gap-2">
                {products.map((p) => (
                  <label key={p.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                    <input type="checkbox" name="productIds" value={p.id} className="accent-[var(--accent)]" />
                    {p.name}
                  </label>
                ))}
              </div>
              <p className="text-xs text-text-3">Seçmezseniz tüm onaylı ve aktif ürünler kullanılır.</p>
            </fieldset>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="En az uygunluk puanı" htmlFor="minScore" hint="Bu puanın altındaki lead'ler kampanyaya alınmaz." error={state.fieldErrors?.minScore}>
              <Input id="minScore" name="minScore" type="number" min={0} max={100} defaultValue={45} />
            </Field>
            <Field label="En fazla lead" htmlFor="maxLeads" error={state.fieldErrors?.maxLeads}>
              <Input id="maxLeads" name="maxLeads" type="number" min={1} max={500} defaultValue={50} />
            </Field>
            <Field label="Mesaj dili" htmlFor="language" hint="Yurt dışı firmalara yazarken İngilizce seçin." error={state.fieldErrors?.language}>
              <Select id="language" name="language" defaultValue="tr">
                <option value="tr">Türkçe</option>
                <option value="en">İngilizce</option>
              </Select>
            </Field>
          </div>
          <SubmitButton pendingText="Lead'ler ve uyum kontrol ediliyor…" className="self-start">Kampanya oluştur</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}

export function StrategyApproveForm({
  campaignId,
  valueProposition,
  callToAction,
  tone,
}: {
  campaignId: string;
  valueProposition: string;
  callToAction: string;
  tone: string;
}) {
  return (
    <ActionForm action={approveStrategyAction}>
      {(state) => (
        <>
          <input type="hidden" name="id" value={campaignId} />
          <Field label="Değer önerisi" htmlFor="valueProposition" hint="Gerekirse düzeltin; mesajlar buna göre yazılır.">
            <Textarea id="valueProposition" name="valueProposition" rows={2} defaultValue={valueProposition} maxLength={600} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Çağrı (CTA)" htmlFor="callToAction">
              <Input id="callToAction" name="callToAction" defaultValue={callToAction} maxLength={300} />
            </Field>
            <Field label="Üslup" htmlFor="tone">
              <Input id="tone" name="tone" defaultValue={tone} maxLength={200} />
            </Field>
          </div>
          <SubmitButton pendingText="Onaylanıyor…" className="self-start">
            <Check className="size-4" aria-hidden /> Stratejiyi onayla
          </SubmitButton>
          <FormMessage state={state} />
        </>
      )}
    </ActionForm>
  );
}

export interface MessageCardData {
  id: string;
  campaignId: string | null;
  subject: string | null;
  body: string;
  status: string;
  statusLabel: string;
  toAddress: string | null;
  leadName: string;
  leadId: string;
  qualityScore: number | null;
  complianceStatus: string | null;
  complianceLabel: string | null;
  issues: Array<{ severity: "block" | "warn"; text: string }>;
  personalization: string[];
  error: string | null;
  canEdit: boolean;
}

export function MessageCard({ m }: { m: MessageCardData }) {
  const [editing, setEditing] = useState(false);
  const editable = m.canEdit && ["DRAFT", "PENDING_APPROVAL", "APPROVED"].includes(m.status);
  const blocked = m.issues.some((i) => i.severity === "block");

  return (
    <article className="rounded-lg border border-border p-4">
      <header className="mb-2 flex flex-wrap items-center gap-2">
        <a href={`/leads/${m.leadId}`} className="text-sm font-medium text-text hover:text-accent">{m.leadName}</a>
        <span className="text-xs text-text-3">{m.toAddress ?? "adres yok"}</span>
        <span className="ml-auto flex flex-wrap gap-1">
          {m.complianceLabel && (
            <Badge tone={m.complianceStatus === "SENDABLE" ? "success" : m.complianceStatus === "DO_NOT_SEND" ? "danger" : "warning"}>{m.complianceLabel}</Badge>
          )}
          {m.qualityScore !== null && <Badge tone={blocked ? "danger" : m.qualityScore >= 80 ? "success" : "warning"}>Kalite {m.qualityScore}</Badge>}
          <Badge>{m.statusLabel}</Badge>
        </span>
      </header>

      {editing ? (
        <ActionForm action={saveMessageAction} onSuccess={() => setEditing(false)}>
          {(state) => (
            <>
              <input type="hidden" name="id" value={m.id} />
              {m.campaignId && <input type="hidden" name="campaignId" value={m.campaignId} />}
              <Field label="Konu" htmlFor={`s-${m.id}`} error={state.fieldErrors?.subject}>
                <Input id={`s-${m.id}`} name="subject" defaultValue={m.subject ?? ""} maxLength={150} required />
              </Field>
              <Field label="Mesaj" htmlFor={`b-${m.id}`} error={state.fieldErrors?.body} hint="İmza, adres ve ret bağlantısı gönderimde otomatik eklenir.">
                <Textarea id={`b-${m.id}`} name="body" rows={9} defaultValue={m.body} maxLength={5000} required />
              </Field>
              <FormMessage state={state} />
              <div className="flex gap-2">
                <SubmitButton size="sm" pendingText="Kontrol ediliyor…">Kaydet</SubmitButton>
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  <X className="size-4" aria-hidden /> Vazgeç
                </Button>
              </div>
            </>
          )}
        </ActionForm>
      ) : (
        <>
          <p className="text-sm font-medium text-text">{m.subject}</p>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-text-2">{m.body}</p>
        </>
      )}

      {m.issues.length > 0 && (
        <ul className="mt-3 space-y-1">
          {m.issues.map((i, idx) => (
            <li key={idx} className={`flex gap-1.5 text-xs ${i.severity === "block" ? "text-danger" : "text-warning"}`}>
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {i.text}
            </li>
          ))}
        </ul>
      )}
      {m.personalization.length > 0 && (
        <p className="mt-2 text-xs text-text-3">Kişiselleştirme: {m.personalization.join(" · ")}</p>
      )}
      {m.error && <p className="mt-2 text-xs text-warning">{m.error}</p>}

      {editable && !editing && (
        <div className="mt-3 flex flex-wrap items-start gap-2">
          {m.status === "PENDING_APPROVAL" && !blocked && (
            <ActionForm action={approveMessagesAction} className="gap-2">
              {(state) => (
                <>
                  <input type="hidden" name="messageId" value={m.id} />
                  {m.campaignId && <input type="hidden" name="campaignId" value={m.campaignId} />}
                  <SubmitButton size="sm" pendingText="Onaylanıyor…">
                    <Check className="size-4" aria-hidden /> Onayla
                  </SubmitButton>
                  <FormMessage state={state} />
                </>
              )}
            </ActionForm>
          )}
          <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(true)}>
            <Pencil className="size-4" aria-hidden /> Düzenle
          </Button>
        </div>
      )}
    </article>
  );
}
