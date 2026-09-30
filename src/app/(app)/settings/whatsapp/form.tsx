"use client";

import { saveWhatsAppAction } from "@/app/actions/whatsapp";
import { ActionForm, FormMessage, SubmitButton } from "@/components/forms";
import { Field, Input } from "@/components/ui";

export function WhatsAppSettingsForm({ phoneNumberId, wabaId, tokenMask }: { phoneNumberId: string; wabaId: string; tokenMask: string | null }) {
  return (
    <ActionForm action={saveWhatsAppAction}>
      {(state) => (
        <>
          <FormMessage state={state} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Phone number ID" htmlFor="phoneNumberId" error={state.fieldErrors?.phoneNumberId}>
              <Input id="phoneNumberId" name="phoneNumberId" defaultValue={phoneNumberId} inputMode="numeric" required />
            </Field>
            <Field label="WhatsApp Business Account ID" htmlFor="wabaId" error={state.fieldErrors?.wabaId}>
              <Input id="wabaId" name="wabaId" defaultValue={wabaId} inputMode="numeric" required />
            </Field>
            <Field
              label="Kalıcı erişim anahtarı (System User token)"
              htmlFor="accessToken"
              hint={tokenMask ? `Kayıtlı: ${tokenMask} — değiştirmek istemiyorsanız boş bırakın.` : "Şifreli saklanır, bir daha gösterilmez."}
              error={state.fieldErrors?.accessToken}
            >
              <Input id="accessToken" name="accessToken" type="password" autoComplete="off" />
            </Field>
            <Field label="App secret" htmlFor="appSecret" hint="Webhook imzasını doğrulamak için. Şifreli saklanır.">
              <Input id="appSecret" name="appSecret" type="password" autoComplete="off" />
            </Field>
          </div>
          <SubmitButton pendingText="Bağlantı test ediliyor…" className="self-start">Kaydet ve test et</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
