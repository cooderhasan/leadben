"use client";

import { addSuppressionAction, checkDomainAction, saveSenderAction, sendTestEmailAction } from "@/app/actions/email";
import { ActionForm, FormMessage, SubmitButton } from "@/components/forms";
import { Field, Input, Select, Textarea } from "@/components/ui";

export interface SenderFormValues {
  fromName?: string;
  fromEmail?: string;
  replyTo?: string | null;
  legalName?: string;
  postalAddress?: string;
  phone?: string | null;
  signature?: string | null;
}

export function SenderForm({ values, disabled }: { values: SenderFormValues; disabled: boolean }) {
  return (
    <ActionForm action={saveSenderAction}>
      {(state) => (
        <>
          <FormMessage state={state} />
          <fieldset disabled={disabled} className="grid gap-4 sm:grid-cols-2">
            <Field label="Gönderen adı" htmlFor="fromName" error={state.fieldErrors?.fromName} hint="ör. Ahmet — Aktif Yay">
              <Input id="fromName" name="fromName" defaultValue={values.fromName} required maxLength={100} />
            </Field>
            <Field label="Gönderen e-posta" htmlFor="fromEmail" error={state.fieldErrors?.fromEmail} hint="Firmanızın alan adında, sağlayıcıda doğrulanmış olmalı.">
              <Input id="fromEmail" name="fromEmail" type="email" defaultValue={values.fromEmail} required />
            </Field>
            <Field label="Yanıt adresi (isteğe bağlı)" htmlFor="replyTo" error={state.fieldErrors?.replyTo}>
              <Input id="replyTo" name="replyTo" type="email" defaultValue={values.replyTo ?? ""} />
            </Field>
            <Field label="Telefon (isteğe bağlı)" htmlFor="phone">
              <Input id="phone" name="phone" type="tel" defaultValue={values.phone ?? ""} />
            </Field>
            <Field label="Ticari unvan" htmlFor="legalName" error={state.fieldErrors?.legalName} className="sm:col-span-2" hint="Her iletinin altında gönderici kimliği olarak yer alır.">
              <Input id="legalName" name="legalName" defaultValue={values.legalName} required maxLength={200} placeholder="ör. Aktif Yay San. ve Tic. Ltd. Şti." />
            </Field>
            <Field label="Açık adres" htmlFor="postalAddress" error={state.fieldErrors?.postalAddress} className="sm:col-span-2">
              <Textarea id="postalAddress" name="postalAddress" rows={2} defaultValue={values.postalAddress} required maxLength={400} />
            </Field>
            <Field label="İmza (isteğe bağlı)" htmlFor="signature" className="sm:col-span-2" hint="Boşsa gönderen adı kullanılır.">
              <Textarea id="signature" name="signature" rows={3} defaultValue={values.signature ?? ""} maxLength={600} />
            </Field>
          </fieldset>
          {!disabled && <SubmitButton pendingText="Kaydediliyor…" className="self-start">Kaydet</SubmitButton>}
        </>
      )}
    </ActionForm>
  );
}

export function TestEmailForm({ defaultTo }: { defaultTo: string }) {
  return (
    <ActionForm action={sendTestEmailAction} className="gap-3">
      {(state) => (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field label="Test e-postasının gideceği adres" htmlFor="test-to" className="flex-1" error={state.fieldErrors?.to}>
              <Input id="test-to" name="to" type="email" required defaultValue={defaultTo} />
            </Field>
            <SubmitButton variant="secondary" pendingText="Gönderiliyor…" className="self-start sm:self-end">
              Test e-postası gönder
            </SubmitButton>
          </div>
          <FormMessage state={state} />
        </>
      )}
    </ActionForm>
  );
}

export function DomainCheckButton() {
  return (
    <ActionForm action={checkDomainAction} className="gap-2">
      {(state) => (
        <>
          <SubmitButton variant="secondary" size="sm" pendingText="DNS kontrol ediliyor…" className="self-start">
            SPF / DMARC kontrol et
          </SubmitButton>
          <FormMessage state={state} />
        </>
      )}
    </ActionForm>
  );
}

export function SuppressionAddForm() {
  return (
    <ActionForm action={addSuppressionAction} resetOnSuccess>
      {(state) => (
        <>
          <FormMessage state={state} />
          <div className="grid gap-3 sm:grid-cols-[140px_1fr_1fr_auto] sm:items-end">
            <Field label="Tür" htmlFor="type">
              <Select id="type" name="type" defaultValue="EMAIL">
                <option value="EMAIL">E-posta</option>
                <option value="DOMAIN">Alan adı</option>
                <option value="PHONE">Telefon</option>
              </Select>
            </Field>
            <Field label="Değer" htmlFor="value" error={state.fieldErrors?.value}>
              <Input id="value" name="value" required placeholder="ornek@firma.com veya firma.com" />
            </Field>
            <Field label="Neden (isteğe bağlı)" htmlFor="reason">
              <Input id="reason" name="reason" maxLength={500} />
            </Field>
            <SubmitButton pendingText="Ekleniyor…">Ekle</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
