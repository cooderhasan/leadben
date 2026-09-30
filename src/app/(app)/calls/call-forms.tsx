"use client";

import { useState } from "react";
import { logCallAction } from "@/app/actions/calls";
import { ActionForm, FormMessage, SubmitButton } from "@/components/forms";
import { Field, Input, Select, Textarea } from "@/components/ui";

const OUTCOMES: Array<[string, string]> = [
  ["NO_ANSWER", "Açmadı / ulaşılamadı"],
  ["BUSY", "Meşgul"],
  ["CALL_BACK", "Tekrar ara (tarih seç)"],
  ["INTERESTED", "İlgileniyor"],
  ["CATALOG_REQUESTED", "Katalog / bilgi istedi"],
  ["MEETING_SET", "Görüşme / ziyaret ayarlandı"],
  ["WHATSAPP_CONSENT", "WhatsApp'tan gönderilmesine izin verdi"],
  ["EMAIL_OBTAINED", "E-posta adresi verdi"],
  ["NOT_INTERESTED", "İlgilenmiyor"],
  ["WRONG_NUMBER", "Yanlış numara"],
  ["DO_NOT_CALL", "Bir daha aranmak istemiyor"],
];

/** datetime-local değeri tarayıcının yerel saatidir → ISO'ya çevrilip gönderilir (sunucu UTC) */
function toIso(local: string): string {
  if (!local) return "";
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

export function CallResultForm({ leadId }: { leadId: string }) {
  const [outcome, setOutcome] = useState("");
  const [at, setAt] = useState("");
  const needsDate = outcome === "CALL_BACK" || outcome === "MEETING_SET";
  const needsEmail = outcome === "EMAIL_OBTAINED" || outcome === "CATALOG_REQUESTED";
  const needsMobile = outcome === "WHATSAPP_CONSENT";

  return (
    <ActionForm action={logCallAction} className="gap-3" onSuccess={() => { setOutcome(""); setAt(""); }} resetOnSuccess>
      {(state) => (
        <>
          <input type="hidden" name="leadId" value={leadId} />
          <input type="hidden" name="at" value={toIso(at)} />
          <Field label="Görüşme sonucu" htmlFor={`outcome-${leadId}`} error={state.fieldErrors?.outcome}>
            <Select id={`outcome-${leadId}`} name="outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)} required>
              <option value="" disabled>Seçin…</option>
              {OUTCOMES.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </Select>
          </Field>

          {needsDate && (
            <Field label={outcome === "CALL_BACK" ? "Ne zaman tekrar aranacak?" : "Görüşme zamanı (isteğe bağlı)"} htmlFor={`at-${leadId}`} error={state.fieldErrors?.at}>
              <Input id={`at-${leadId}`} type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} required={outcome === "CALL_BACK"} />
            </Field>
          )}

          {(needsMobile || needsEmail) && (
            <Field label="Görüştüğünüz kişi (isteğe bağlı)" htmlFor={`name-${leadId}`}>
              <Input id={`name-${leadId}`} name="contactName" maxLength={200} placeholder="ör. Satın alma — Ayşe Hanım" />
            </Field>
          )}

          {needsMobile && (
            <Field
              label="Cep telefonu (WhatsApp)"
              htmlFor={`mobile-${leadId}`}
              hint="Sözlü izin; kim ve ne zaman aldığı kayda geçer. Mesajı Meta onaylı şablonla gönderirsiniz."
              error={state.fieldErrors?.mobilePhone}
            >
              <Input id={`mobile-${leadId}`} name="mobilePhone" type="tel" inputMode="tel" placeholder="05xx xxx xx xx" required />
            </Field>
          )}

          {needsEmail && (
            <Field
              label={outcome === "EMAIL_OBTAINED" ? "Verilen e-posta" : "Gönderilecek e-posta (varsa)"}
              htmlFor={`email-${leadId}`}
              hint="Kurumsal adres (info@, satinalma@) firmaya, kişisel adres izinli kişi olarak kaydedilir."
              error={state.fieldErrors?.email}
            >
              <Input id={`email-${leadId}`} name="email" type="email" required={outcome === "EMAIL_OBTAINED"} />
            </Field>
          )}

          <Field label="Not (isteğe bağlı)" htmlFor={`note-${leadId}`}>
            <Textarea id={`note-${leadId}`} name="note" rows={2} maxLength={2000} placeholder="ör. Satın almadan Mehmet Bey; yıllık ihtiyaçları var, fiyat istediler." />
          </Field>

          <SubmitButton size="sm" pendingText="Kaydediliyor…" className="self-start">Sonucu kaydet</SubmitButton>
          <FormMessage state={state} />
        </>
      )}
    </ActionForm>
  );
}
