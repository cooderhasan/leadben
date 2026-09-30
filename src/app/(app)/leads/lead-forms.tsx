"use client";

import {
  checkEcommerceAction,
  createLeadAction,
  findEmailsAction,
  importLeadsCsvAction,
  importListAction,
  quickDeleteLeadAction,
  quickSetEmailAction,
  researchLeadAction,
  scoreLeadsAction,
  searchLeadsAction,
  setEcommerceProspectingAction,
  updateLeadContactAction,
} from "@/app/actions/leads";
import { reviewComplianceAction } from "@/app/actions/email";
import { addReplyAction } from "@/app/actions/conversations";
import { ActionForm, FormMessage, SubmitButton } from "@/components/forms";
import { Field, Input, Select, Textarea } from "@/components/ui";
import { Loader2, Plus, Search, ShoppingCart, Sparkles, Trash2, Upload } from "lucide-react";
import { useFormStatus } from "react-dom";

export function LeadSearchForm({ enabled, maxLimit, presets = [] }: { enabled: boolean; maxLimit: number; presets?: Array<{ label: string; prompt: string }> }) {
  return (
    <ActionForm action={searchLeadsAction} resetOnSuccess>
      {(state) => (
        <>
          <FormMessage state={state} />
          {presets.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-text-2">Hazır aramalar</span>
              <div className="flex flex-wrap gap-1.5">
                {presets.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    disabled={!enabled}
                    title={p.prompt}
                    onClick={() => {
                      const el = document.getElementById("prompt") as HTMLTextAreaElement | null;
                      if (el) {
                        el.value = p.prompt;
                        el.focus();
                      }
                    }}
                    className="rounded-full border border-border px-2.5 py-1 text-xs text-text-2 transition-colors hover:border-accent hover:bg-accent-soft hover:text-accent-text disabled:opacity-50"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <Field
            label="Ne tür müşteriler arıyorsunuz?"
            htmlFor="prompt"
            hint={`Her yeni lead 1 kredi. Mevcut kayıtla eşleşenler ücretsiz. En fazla ${maxLimit} lead.`}
            error={state.fieldErrors?.prompt}
          >
            <Textarea
              id="prompt"
              name="prompt"
              rows={2}
              maxLength={1000}
              required
              disabled={!enabled}
              placeholder="ör. Bursa ve Kocaeli'deki otomotiv yan sanayi firmaları, metal pres ve kalıp üreticileri"
            />
          </Field>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Adet" htmlFor="limit" className="w-28">
              <Input id="limit" name="limit" type="number" min={1} max={maxLimit} defaultValue={Math.min(20, maxLimit)} disabled={!enabled} />
            </Field>
            <Field label="Kaynak" htmlFor="source" className="w-56">
              <Select id="source" name="source" defaultValue="auto" disabled={!enabled}>
                <option value="auto">Otomatik (AI seçer)</option>
                <option value="maps">Google Haritalar</option>
                <option value="web">Web araması</option>
              </Select>
            </Field>
            <SubmitButton pendingText="Anlaşılıyor…" className="self-end">
              <Search className="size-4" aria-hidden /> Lead bul
            </SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}

export function ListImportForm({ enabled }: { enabled: boolean }) {
  return (
    <ActionForm action={importListAction} resetOnSuccess>
      {(state) => (
        <>
          <FormMessage state={state} />
          <Field
            label="Liste sayfasının adresi"
            htmlFor="list-url"
            hint="OSB üye listesi, fuar katılımcıları, dernek üyeleri… AI sayfadaki firmaları çıkarır; sayfada yazmayan bilgi kaydedilmez. 3 kredi (firma çıkmazsa iade)."
            error={state.fieldErrors?.url}
          >
            <Input id="list-url" name="url" type="url" inputMode="url" placeholder="https://www.osb.org.tr/firmalar" disabled={!enabled} />
          </Field>
          <Field
            label="Sektör / anahtar kelime filtresi (isteğe bağlı)"
            htmlFor="list-filter"
            hint="Virgülle ayırın. Yalnızca sektöründe veya adında bu kelimelerden biri geçen firmalar alınır. Boş bırakılırsa tümü."
          >
            <Input id="list-filter" name="filter" placeholder="ör. otomotiv, makina, pres, döküm" maxLength={300} disabled={!enabled} />
          </Field>
          <label className="flex items-start gap-2 text-sm text-text-2">
            <input type="checkbox" name="render" className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]" disabled={!enabled} />
            <span>
              Sayfayı tarayıcıyla aç
              <span className="block text-xs text-text-3">
                Liste JavaScript ile yükleniyorsa (çoğu büyük fuar sitesi) işaretleyin. Daha yavaş ve 6 kredi.
              </span>
            </span>
          </label>
          <details>
            <summary className="cursor-pointer text-xs font-medium text-accent-text">Sayfa açılmıyorsa veya liste PDF&apos;teyse: metni yapıştır</summary>
            <Textarea name="text" rows={5} maxLength={50_000} className="mt-2 text-xs" placeholder="Listeyi kopyalayıp buraya yapıştırın (adres alanını boş bırakın)" disabled={!enabled} />
          </details>
          <SubmitButton variant="secondary" pendingText="Başlatılıyor…" className="self-start" >
            <Upload className="size-4" aria-hidden /> Listeyi içe aktar
          </SubmitButton>
        </>
      )}
    </ActionForm>
  );
}

export function CsvImportForm() {
  return (
    <ActionForm action={importLeadsCsvAction} resetOnSuccess>
      {(state) => (
        <>
          <FormMessage state={state} />
          <Field
            label="CSV dosyası"
            htmlFor="file"
            hint="İlk satır başlık: Firma, Web, Telefon, E-posta, İl, İlçe, Sektör… Ayraç ; veya , olabilir. Kredi harcamaz."
            error={state.fieldErrors?.file}
          >
            <input
              id="file"
              name="file"
              type="file"
              accept=".csv,text/csv"
              required
              className="block w-full cursor-pointer rounded-lg border border-border bg-surface text-sm text-text-2 file:mr-3 file:cursor-pointer file:border-0 file:border-r file:border-border file:bg-surface-2 file:px-3 file:py-2.5 file:text-sm file:font-medium file:text-text"
            />
          </Field>
          <SubmitButton variant="secondary" pendingText="İçe aktarılıyor…" className="self-start">
            <Upload className="size-4" aria-hidden /> İçe aktar
          </SubmitButton>
        </>
      )}
    </ActionForm>
  );
}

export function ManualLeadForm() {
  return (
    <ActionForm action={createLeadAction}>
      {(state) => (
        <>
          <FormMessage state={state} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Firma adı" htmlFor="companyName" error={state.fieldErrors?.companyName}>
              <Input id="companyName" name="companyName" required maxLength={300} />
            </Field>
            <Field label="Web sitesi" htmlFor="website" error={state.fieldErrors?.website}>
              <Input id="website" name="website" placeholder="ornek.com.tr" />
            </Field>
            <Field label="Telefon (kurumsal)" htmlFor="phone">
              <Input id="phone" name="phone" type="tel" />
            </Field>
            <Field label="E-posta (kurumsal, info@…)" htmlFor="genericEmail" error={state.fieldErrors?.genericEmail}>
              <Input id="genericEmail" name="genericEmail" type="email" />
            </Field>
            <Field label="İl" htmlFor="city">
              <Input id="city" name="city" />
            </Field>
            <Field label="İlçe / OSB" htmlFor="district">
              <Input id="district" name="district" />
            </Field>
            <Field label="Sektör" htmlFor="category" className="sm:col-span-2">
              <Input id="category" name="category" />
            </Field>
          </div>
          <SubmitButton pendingText="Kaydediliyor…" className="self-start">Kaydet</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}

export function LeadContactForm({ lead }: { lead: { id: string; website: string | null; phone: string | null; genericEmail: string | null } }) {
  return (
    <ActionForm action={updateLeadContactAction} className="gap-3">
      {(state) => (
        <>
          <input type="hidden" name="id" value={lead.id} />
          <Field label="Kurumsal e-posta" htmlFor="c-email" hint="info@, satis@, satinalma@… Kişisel adresler buraya girilmez." error={state.fieldErrors?.genericEmail}>
            <Input id="c-email" name="genericEmail" type="email" defaultValue={lead.genericEmail ?? ""} />
          </Field>
          <Field label="Telefon" htmlFor="c-phone" error={state.fieldErrors?.phone}>
            <Input id="c-phone" name="phone" type="tel" defaultValue={lead.phone ?? ""} />
          </Field>
          <Field label="Web sitesi" htmlFor="c-web" error={state.fieldErrors?.website}>
            <Input id="c-web" name="website" defaultValue={lead.website ?? ""} placeholder="ornek.com.tr" />
          </Field>
          <SubmitButton size="sm" pendingText="Kaydediliyor…" className="self-start">Kaydet</SubmitButton>
          <FormMessage state={state} />
        </>
      )}
    </ActionForm>
  );
}

export function CheckEcommerceButton({ leadId }: { leadId: string }) {
  return (
    <ActionForm action={checkEcommerceAction} className="gap-2">
      {(state) => (
        <>
          <input type="hidden" name="id" value={leadId} />
          <SubmitButton variant="secondary" pendingText="Başlatılıyor…" size="sm" className="self-start">
            <ShoppingCart className="size-4" aria-hidden /> Siteyi kontrol et (ücretsiz)
          </SubmitButton>
          <FormMessage state={state} />
        </>
      )}
    </ActionForm>
  );
}

/** Ayarlar: e-ticaret fırsatı modu */
export function EcommerceModeForm({ on }: { on: boolean }) {
  return (
    <ActionForm action={setEcommerceProspectingAction} className="gap-3">
      {(state) => (
        <>
          <label className="flex items-start gap-2 text-sm text-text">
            <input type="checkbox" name="on" defaultChecked={on} className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]" />
            <span>
              E-ticaret fırsatı modu
              <span className="block text-xs text-text-3">
                Hedef: kendi e-ticaret sitesi olmayan veya sitesi eski olan işletmeler. Aramadan sonra siteler otomatik (ücretsiz) kontrol edilir,
                lead listesi varsayılan olarak modern e-ticareti olanları gizler, puanlamada telefonla ulaşılabilirlik öne çıkar.
              </span>
            </span>
          </label>
          <SubmitButton size="sm" pendingText="Kaydediliyor…" className="self-start">Kaydet</SubmitButton>
          <FormMessage state={state} />
        </>
      )}
    </ActionForm>
  );
}

export function ResearchLeadButton({ leadId, hasWebsite }: { leadId: string; hasWebsite: boolean }) {
  return (
    <ActionForm action={researchLeadAction} className="gap-2">
      {(state) => (
        <>
          <input type="hidden" name="id" value={leadId} />
          <SubmitButton pendingText="Başlatılıyor…" size="sm">
            <Sparkles className="size-4" aria-hidden /> {hasWebsite ? "AI ile Analiz Et (2 kredi)" : "AI ile Analiz Et"}
          </SubmitButton>
          <FormMessage state={state} />
        </>
      )}
    </ActionForm>
  );
}

export function ManualReplyForm({ leadId, defaultFrom }: { leadId: string; defaultFrom: string }) {
  return (
    <ActionForm action={addReplyAction} resetOnSuccess>
      {(state) => (
        <>
          <FormMessage state={state} />
          <input type="hidden" name="leadId" value={leadId} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Yanıtı gönderen" htmlFor="fromAddress" error={state.fieldErrors?.fromAddress}>
              <Input id="fromAddress" name="fromAddress" type="email" defaultValue={defaultFrom} required />
            </Field>
            <Field label="Konu" htmlFor="replySubject">
              <Input id="replySubject" name="subject" maxLength={300} />
            </Field>
          </div>
          <Field label="Yanıt metni" htmlFor="replyBody" error={state.fieldErrors?.body} hint="AI sınıflandırır; ret ifadesi varsa adres hemen engel listesine eklenir.">
            <Textarea id="replyBody" name="body" rows={5} required maxLength={50_000} />
          </Field>
          <SubmitButton size="sm" pendingText="Ekleniyor…" className="self-start">Yanıtı ekle</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}

export function ComplianceReviewForm({ recordId, leadId }: { recordId: string; leadId: string }) {
  return (
    <ActionForm action={reviewComplianceAction} className="gap-2">
      {(state) => (
        <>
          <input type="hidden" name="id" value={recordId} />
          <input type="hidden" name="leadId" value={leadId} />
          <div className="flex flex-wrap items-center gap-2">
            <Select name="basis" defaultValue="" aria-label="İletişim dayanağı" className="h-8 w-60 text-xs" required>
              <option value="" disabled>İletişim dayanağı seçin…</option>
              <option value="B2B_TRADER_ADDRESS">Tacir kurumsal adresi</option>
              <option value="EXISTING_RELATIONSHIP">Mevcut müşteri ilişkisi</option>
              <option value="INBOUND_REQUEST">Firmadan gelen talep</option>
              <option value="EXPLICIT_CONSENT">Açık onay alındı</option>
            </Select>
            <SubmitButton size="sm" variant="secondary" pendingText="Kaydediliyor…">İnceledim, kaydet</SubmitButton>
          </div>
          <FormMessage state={state} />
        </>
      )}
    </ActionForm>
  );
}

export function FindEmailsButton({ leadIds }: { leadIds: string[] }) {
  return (
    <ActionForm action={findEmailsAction} className="gap-2">
      {(state) => (
        <>
          {leadIds.map((id) => (
            <input key={id} type="hidden" name="leadId" value={id} />
          ))}
          <SubmitButton variant="secondary" size="sm" pendingText="Başlatılıyor…">
            <Search className="size-4" aria-hidden /> {leadIds.length} firmanın sitesinde e-posta bul (ücretsiz)
          </SubmitButton>
          <FormMessage state={state} />
        </>
      )}
    </ActionForm>
  );
}

export function ScoreLeadsButton({ leadIds, label }: { leadIds: string[]; label: string }) {
  return (
    <ActionForm action={scoreLeadsAction} className="gap-2">
      {(state) => (
        <>
          {leadIds.map((id) => (
            <input key={id} type="hidden" name="leadId" value={id} />
          ))}
          <SubmitButton variant="secondary" size="sm" pendingText="Başlatılıyor…">
            {label}
          </SubmitButton>
          <FormMessage state={state} />
        </>
      )}
    </ActionForm>
  );
}

/** Listede satır içi "e-posta ekle": lead sayfasına girmeden kurumsal adres girilir */
export function QuickEmailForm({ leadId }: { leadId: string }) {
  return (
    <ActionForm action={quickSetEmailAction} className="gap-1">
      {(state) => (
        <>
          <input type="hidden" name="id" value={leadId} />
          <div className="flex items-center gap-1.5">
            <Input name="genericEmail" type="email" required placeholder="info@firma.com" aria-label="Kurumsal e-posta" className="h-8 min-w-0 flex-1 text-xs sm:w-52 sm:flex-none" />
            <SubmitButton size="sm" variant="secondary" pendingText="…" className="h-8 px-2.5">
              <Plus className="size-3.5" aria-hidden /> Ekle
            </SubmitButton>
          </div>
          {state.error && <p className="text-xs text-danger">{state.error}</p>}
          {state.ok && <p className="text-xs text-success">{state.message}</p>}
        </>
      )}
    </ActionForm>
  );
}

function DeleteIconButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      title="Lead'i sil"
      aria-label="Lead'i sil"
      className="grid size-8 place-items-center rounded-lg text-text-3 transition-colors hover:bg-danger-soft hover:text-danger disabled:opacity-50"
    >
      {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Trash2 className="size-4" aria-hidden />}
    </button>
  );
}

/** Listede satır içi silme (onay sorar; sayfa değişmez) */
export function QuickDeleteButton({ leadId, name }: { leadId: string; name: string }) {
  return (
    <ActionForm action={quickDeleteLeadAction} className="gap-0">
      {(state) => (
        <>
          <input type="hidden" name="id" value={leadId} />
          <span
            className="contents"
            onClickCapture={(e) => {
              if ((e.target as HTMLElement).closest("button") && !window.confirm(`"${name}" silinsin mi? Bu işlem geri alınamaz.`)) {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
          >
            <DeleteIconButton />
          </span>
          {state.error && <p className="text-xs text-danger">{state.error}</p>}
        </>
      )}
    </ActionForm>
  );
}
