"use client";

import { useState } from "react";
import { createTaskAction, updateOpportunityAction } from "@/app/actions/crm";
import { ActionForm, FormMessage, SubmitButton } from "@/components/forms";
import { Field, Input, Select, Textarea } from "@/components/ui";

const STAGES: Array<[string, string]> = [
  ["NEW", "Yeni"],
  ["QUALIFIED", "Nitelikli"],
  ["CONTACTED", "İletişimde"],
  ["INTERESTED", "İlgileniyor"],
  ["QUOTE", "Teklif"],
  ["NEGOTIATION", "Pazarlık"],
  ["WON", "Kazanıldı"],
  ["LOST", "Kaybedildi"],
];
const REASONS: Array<[string, string]> = [
  ["PRICE", "Fiyat"],
  ["DELIVERY", "Teslimat"],
  ["PRODUCT_MISMATCH", "Ürün uyumsuz"],
  ["COMPETITOR", "Rakip tercih edildi"],
  ["TIMING", "Zamanlama"],
  ["NO_RESPONSE", "Yanıt yok"],
  ["WRONG_CONTACT", "Yanlış kişi"],
  ["OTHER", "Diğer"],
];

export function OpportunityForm({
  id,
  stage,
  value,
  probability,
  expectedCloseAt,
  lostReason,
}: {
  id: string;
  stage: string;
  value: number | null;
  probability: number | null;
  expectedCloseAt: string | null;
  lostReason: string | null;
}) {
  const [current, setCurrent] = useState(stage);
  return (
    <ActionForm action={updateOpportunityAction} className="gap-2">
      {(state) => (
        <>
          <input type="hidden" name="id" value={id} />
          <div className="grid grid-cols-2 gap-2">
            <Select name="stage" value={current} onChange={(e) => setCurrent(e.target.value)} aria-label="Aşama" className="h-8 text-xs">
              {STAGES.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </Select>
            <Input name="value" defaultValue={value ?? ""} inputMode="decimal" placeholder="Tutar (₺)" aria-label="Tutar" className="h-8 text-xs" />
            <Input name="probability" type="number" min={0} max={100} defaultValue={probability ?? ""} placeholder="Olasılık %" aria-label="Olasılık" className="h-8 text-xs" />
            <Input name="expectedCloseAt" type="date" defaultValue={expectedCloseAt ?? ""} aria-label="Beklenen kapanış" className="h-8 text-xs" />
          </div>
          {current === "LOST" && (
            <div className="grid gap-2">
              <Select name="lostReason" defaultValue={lostReason ?? ""} aria-label="Kaybedilme nedeni" className="h-8 text-xs" required>
                <option value="" disabled>Kaybedilme nedeni…</option>
                {REASONS.map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </Select>
              <Input name="lostNote" placeholder="Not (isteğe bağlı)" className="h-8 text-xs" maxLength={1000} />
            </div>
          )}
          <SubmitButton size="sm" variant="secondary" pendingText="Kaydediliyor…" className="self-start">Kaydet</SubmitButton>
          <FormMessage state={state} />
        </>
      )}
    </ActionForm>
  );
}

export function TaskCreateForm({ leads }: { leads: Array<{ id: string; name: string }> }) {
  return (
    <ActionForm action={createTaskAction} resetOnSuccess>
      {(state) => (
        <>
          <FormMessage state={state} />
          <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr_1fr]">
            <Field label="Görev" htmlFor="title" error={state.fieldErrors?.title}>
              <Input id="title" name="title" required maxLength={200} placeholder="ör. Numune gönder" />
            </Field>
            <Field label="Lead (isteğe bağlı)" htmlFor="leadId">
              <Select id="leadId" name="leadId" defaultValue="">
                <option value="">—</option>
                {leads.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Tarih" htmlFor="dueAt" error={state.fieldErrors?.dueAt}>
              <Input id="dueAt" name="dueAt" type="date" />
            </Field>
            <Field label="Öncelik" htmlFor="priority">
              <Select id="priority" name="priority" defaultValue="MEDIUM">
                <option value="LOW">Düşük</option>
                <option value="MEDIUM">Orta</option>
                <option value="HIGH">Yüksek</option>
                <option value="URGENT">Acil</option>
              </Select>
            </Field>
          </div>
          <Field label="Açıklama (isteğe bağlı)" htmlFor="description">
            <Textarea id="description" name="description" rows={2} maxLength={2000} />
          </Field>
          <SubmitButton size="sm" pendingText="Ekleniyor…" className="self-start">Görev ekle</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
