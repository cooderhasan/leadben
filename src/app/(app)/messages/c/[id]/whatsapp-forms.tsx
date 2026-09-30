"use client";

import { useState } from "react";
import { Send } from "lucide-react";
import { replyWhatsAppAction, sendTemplateAction } from "@/app/actions/whatsapp";
import { ActionForm, FormMessage, SubmitButton } from "@/components/forms";
import { Field, Input, Select, Textarea } from "@/components/ui";

export function WhatsAppReplyForm({ conversationId, hoursLeft }: { conversationId: string; hoursLeft: number }) {
  return (
    <ActionForm action={replyWhatsAppAction} resetOnSuccess>
      {(state) => (
        <>
          <input type="hidden" name="conversationId" value={conversationId} />
          <Field label="WhatsApp yanıtı" htmlFor="waBody" hint={`Yanıt penceresi yaklaşık ${hoursLeft} saat daha açık.`} error={state.fieldErrors?.body}>
            <Textarea id="waBody" name="body" rows={3} maxLength={4000} required />
          </Field>
          <SubmitButton size="sm" pendingText="Gönderiliyor…" className="self-start">
            <Send className="size-4" aria-hidden /> Gönder
          </SubmitButton>
          <FormMessage state={state} />
        </>
      )}
    </ActionForm>
  );
}

export function TemplateSendForm({
  leadId,
  contactId,
  templates,
}: {
  leadId: string;
  contactId: string;
  templates: Array<{ key: string; label: string; bodyText: string; bodyParams: number }>;
}) {
  const [selected, setSelected] = useState(templates[0]?.key ?? "");
  const t = templates.find((x) => x.key === selected);
  return (
    <ActionForm action={sendTemplateAction}>
      {(state) => (
        <>
          <FormMessage state={state} />
          <input type="hidden" name="leadId" value={leadId} />
          <input type="hidden" name="contactId" value={contactId} />
          <Field label="Onaylı şablon" htmlFor="template" error={state.fieldErrors?.template}>
            <Select id="template" name="template" value={selected} onChange={(e) => setSelected(e.target.value)}>
              {templates.map((x) => (
                <option key={x.key} value={x.key}>{x.label}</option>
              ))}
            </Select>
          </Field>
          {t && (
            <>
              <p className="whitespace-pre-wrap rounded-lg bg-surface-2 p-3 text-sm text-text">{t.bodyText}</p>
              {Array.from({ length: t.bodyParams }, (_, i) => (
                <Field key={`${t.key}-${i}`} label={`{{${i + 1}}}`} htmlFor={`param-${i}`}>
                  <Input id={`param-${i}`} name="param" required maxLength={500} />
                </Field>
              ))}
            </>
          )}
          <SubmitButton pendingText="Gönderiliyor…" className="self-start">
            <Send className="size-4" aria-hidden /> Şablonu gönder
          </SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
