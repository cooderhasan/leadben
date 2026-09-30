"use client";

import { createApiKeyAction, createWebhookAction } from "@/app/actions/integrations";
import { ActionForm, SubmitButton } from "@/components/forms";
import { Alert, Field, Input, Select } from "@/components/ui";

function OneTimeSecret({ label, value }: { label: string; value: string }) {
  return (
    <Alert tone="success">
      <p className="font-medium">{label}</p>
      <code className="mt-2 block select-all break-all rounded bg-surface px-2 py-1.5 text-text">{value}</code>
      <p className="mt-2 text-xs">Bu değer bir daha gösterilmeyecek. Şimdi güvenli bir yere kopyalayın.</p>
    </Alert>
  );
}

export function ApiKeyForm() {
  return (
    <ActionForm action={createApiKeyAction} resetOnSuccess>
      {(state) => (
        <>
          {state.ok && state.message && <OneTimeSecret label="Yeni API anahtarınız" value={state.message} />}
          {state.error && <Alert tone="danger">{state.error}</Alert>}
          <div className="grid gap-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
            <Field label="Ad" htmlFor="keyName" error={state.fieldErrors?.name}>
              <Input id="keyName" name="name" placeholder="ör. Zapier" required maxLength={100} />
            </Field>
            <Field label="Yetki" htmlFor="scope">
              <Select id="scope" name="scope" defaultValue="read">
                <option value="read">Yalnızca okuma</option>
                <option value="write">Okuma + yazma</option>
              </Select>
            </Field>
            <SubmitButton pendingText="Oluşturuluyor…">Anahtar oluştur</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function WebhookForm({ events }: { events: Array<[string, string]> }) {
  return (
    <ActionForm action={createWebhookAction} resetOnSuccess>
      {(state) => (
        <>
          {state.ok && state.message && <OneTimeSecret label="İmza anahtarı (X-SOS-Signature doğrulaması için)" value={state.message} />}
          {state.error && <Alert tone="danger">{state.error}</Alert>}
          <Field label="Hedef adres (https)" htmlFor="whUrl" error={state.fieldErrors?.url}>
            <Input id="whUrl" name="url" type="url" placeholder="https://hooks.zapier.com/…" required />
          </Field>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-sm font-medium text-text">Olaylar</legend>
            {events.map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-sm text-text">
                <input type="checkbox" name="events" value={key} defaultChecked={key === "reply.received"} /> {label} <code className="text-xs text-text-3">{key}</code>
              </label>
            ))}
            {state.fieldErrors?.events && <p className="text-xs text-danger">{state.fieldErrors.events}</p>}
          </fieldset>
          <SubmitButton pendingText="Ekleniyor…" className="self-start">Webhook ekle</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
