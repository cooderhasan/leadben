"use client";

import { addMemberAction, addMemoryAction } from "@/app/actions/settings";
import { ActionForm, FormMessage, SubmitButton } from "@/components/forms";
import { Field, Input, Select, Textarea } from "@/components/ui";

export function MemoryForm() {
  return (
    <ActionForm action={addMemoryAction} resetOnSuccess>
      {(state) => (
        <>
          <FormMessage state={state} />
          <Field label="Tür" htmlFor="m-type">
            <Select id="m-type" name="type" defaultValue="RULE">
              <option value="RULE">Satış kuralı</option>
              <option value="PREFERENCE">Tercih</option>
              <option value="FACT">Bilgi</option>
            </Select>
          </Field>
          <Field label="İçerik" htmlFor="m-content" error={state.fieldErrors?.content} hint="Ör: Almanya'da 5.000 adetten düşük siparişlerle ilgilenmiyoruz.">
            <Textarea id="m-content" name="content" required />
          </Field>
          <SubmitButton pendingText="Kaydediliyor…" className="self-start">Hafızaya ekle</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}

export function MemberForm() {
  return (
    <ActionForm action={addMemberAction} resetOnSuccess>
      {(state) => (
        <>
          <FormMessage state={state} />
          <Field label="E-posta" htmlFor="mb-email" error={state.fieldErrors?.email} hint="Kişinin önce kayıt olmuş olması gerekir. E-posta daveti Faz 2'de.">
            <Input id="mb-email" name="email" type="email" required />
          </Field>
          <Field label="Rol" htmlFor="mb-role">
            <Select id="mb-role" name="role" defaultValue="MEMBER">
              <option value="ADMIN">Yönetici</option>
              <option value="MEMBER">Üye</option>
              <option value="VIEWER">İzleyici</option>
            </Select>
          </Field>
          <SubmitButton pendingText="Ekleniyor…" className="self-start">Ekibe ekle</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
