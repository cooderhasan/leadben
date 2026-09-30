"use client";

import { uploadDocumentAction } from "@/app/actions/knowledge";
import { ActionForm, FormMessage, SubmitButton } from "@/components/forms";
import { Field, Input, Select } from "@/components/ui";

export function UploadForm({ kinds }: { kinds: Array<[string, string]> }) {
  return (
    <ActionForm action={uploadDocumentAction} resetOnSuccess>
      {(state) => (
        <>
          <FormMessage state={state} />
          <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
            <Field label="Dosya" htmlFor="file" hint="PDF, TXT, MD veya CSV — en fazla 20 MB. İşleme 5 kredi." error={state.fieldErrors?.file}>
              <input
                id="file"
                name="file"
                type="file"
                accept=".pdf,.txt,.md,.csv"
                required
                className="block w-full cursor-pointer rounded-lg border border-border bg-surface text-sm text-text-2 file:mr-3 file:cursor-pointer file:border-0 file:border-r file:border-border file:bg-surface-2 file:px-3 file:py-2.5 file:text-sm file:font-medium file:text-text"
              />
            </Field>
            <Field label="Doküman türü" htmlFor="kind">
              <Select id="kind" name="kind" defaultValue="CATALOG">
                {kinds.map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Başlık (isteğe bağlı)" htmlFor="title">
            <Input id="title" name="title" placeholder="ör. 2026 Ürün Kataloğu" />
          </Field>
          <SubmitButton pendingText="Yükleniyor…" className="self-start">Yükle ve analiz et</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
