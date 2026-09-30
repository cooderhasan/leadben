"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { bulkLeadsAction, estimatePrepareAction } from "@/app/actions/leads";
import { Alert, Button, Input, Select } from "@/components/ui";
import type { ActionState } from "@/lib/action-state";
import { cn } from "@/lib/cn";

const FORM_ID = "bulk-form";
const boxes = () => Array.from(document.querySelectorAll<HTMLInputElement>(`input[data-bulk][form="${FORM_ID}"]`));

/** Tablo başlığındaki "sayfadakilerin tümü" kutusu */
export function SelectPageCheckbox() {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const sync = () => {
      const all = boxes();
      const n = all.filter((b) => b.checked).length;
      if (ref.current) {
        ref.current.checked = all.length > 0 && n === all.length;
        ref.current.indeterminate = n > 0 && n < all.length;
      }
    };
    document.addEventListener("change", sync);
    return () => document.removeEventListener("change", sync);
  }, []);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label="Bu sayfadakilerin tümünü seç"
      className="size-4 cursor-pointer accent-[var(--accent)]"
      onChange={(e) => {
        for (const b of boxes()) b.checked = e.target.checked;
        document.dispatchEvent(new Event("change"));
      }}
    />
  );
}

const OPS: Array<[string, string]> = [
  ["prepare", "Hazırla (e-posta bul → analiz et → puanla)"],
  ["find_website", "Firma adından web sitesini bul (1 kredi)"],
  ["find_email", "Web sitesinde e-posta bul (ücretsiz)"],
  ["score", "Yalnızca puanla"],
  ["campaign", "Kampanyaya ekle"],
  ["assign", "Sorumlu ata"],
  ["list_add", "Listeye ekle"],
  ["list_remove", "Listeden çıkar"],
  ["status", "Durumu değiştir"],
  ["delete", "Sil"],
];

function ApplyButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending} className="h-9">
      {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {pending ? "Uygulanıyor…" : label}
    </Button>
  );
}

/**
 * Toplu işlem çubuğu. Satır kutuları tablo içinde `form="bulk-form"` ile bu forma bağlanır
 * (tablodaki satır formlarıyla iç içe form oluşmaz). "Filtreye uyan tümü" seçilirse filtre sunucuda yeniden uygulanır.
 */
export function BulkBar({
  matching,
  filter,
  campaigns,
  statuses,
  members,
  lists,
}: {
  matching: number;
  filter: Record<string, string | undefined>;
  campaigns: Array<{ id: string; name: string }>;
  statuses: Array<[string, string]>;
  members: Array<{ id: string; name: string }>;
  lists: Array<{ id: string; name: string }>;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(bulkLeadsAction, {});
  const [selected, setSelected] = useState(0);
  const [pageCount, setPageCount] = useState(0);
  const [allMode, setAllMode] = useState(false);
  const [op, setOp] = useState("prepare");
  const [steps, setSteps] = useState({ p_email: true, p_research: true, p_score: true });
  const [listChoice, setListChoice] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const confirmed = useRef(false);

  useEffect(() => {
    const sync = () => {
      const all = boxes();
      setPageCount(all.length);
      const n = all.filter((b) => b.checked).length;
      setSelected(n);
      if (n < all.length) setAllMode(false);
    };
    sync();
    document.addEventListener("change", sync);
    return () => document.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (state.ok) {
      for (const b of boxes()) b.checked = false;
      setAllMode(false);
      document.dispatchEvent(new Event("change"));
    }
  }, [state]);

  const count = allMode ? matching : selected;
  if (count === 0 && !state.message && !state.error) {
    return <p className="px-5 py-2.5 text-xs text-text-3">Toplu işlem için satırların solundaki kutuları işaretleyin.</p>;
  }

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    if (confirmed.current) {
      confirmed.current = false;
      return;
    }
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    let msg: string;
    if (op === "prepare") {
      const est = await estimatePrepareAction(fd);
      if (!est.ok) {
        window.alert(est.error ?? "Tahmin hesaplanamadı.");
        return;
      }
      if (!est.count) {
        window.alert("Seçili adımlarda yapılacak iş çıkmadı.\n\nAnaliz ve e-posta araması için firmanın web sitesi gerekir; e-postası zaten olan firmada arama yapılmaz.");
        return;
      }
      const lines = [
        est.research ? `• ${est.research} firma analiz edilip puanlanacak (${est.research * 2} kredi)` : null,
        est.scoreOnly ? `• ${est.scoreOnly} firma (web sitesi yok) yalnızca puanlanacak (${est.scoreOnly} kredi)` : null,
        est.emailOnly ? `• ${est.emailOnly} firmada yalnızca e-posta aranacak (ücretsiz)` : null,
      ].filter(Boolean);
      msg =
        `${est.count} firma hazırlanacak${est.capped ? " (tek seferde en fazla 50)" : ""}:\n` +
        `${lines.join("\n")}\n` +
        (!est.research && !est.scoreOnly ? "\nUYARI: Analiz ve puanlama yapılmayacak. İstiyorsanız 'Analiz et' / 'Puanla' seçeneklerini işaretleyin.\n" : "") +
        `\nEn fazla ${est.credits} kredi. Yapılamayan adımın kredisi iade edilir. Devam edilsin mi?`;
    } else if (op === "delete") {
      msg = `${count} firma kalıcı olarak silinecek. Bu işlem geri alınamaz. Emin misiniz?`;
    } else {
      msg = `${count} firmaya "${OPS.find(([k]) => k === op)?.[1]}" uygulansın mı?`;
    }
    if (!window.confirm(msg)) return;
    confirmed.current = true;
    formRef.current?.requestSubmit();
  };

  return (
    <form id={FORM_ID} ref={formRef} action={formAction} onSubmit={onSubmit} className="flex flex-col gap-2 border-b border-border bg-accent-soft/40 px-5 py-3">
      <input type="hidden" name="mode" value={allMode ? "all" : "selected"} />
      {allMode && Object.entries(filter).map(([k, v]) => (v ? <input key={k} type="hidden" name={`f_${k}`} value={v} /> : null))}
      {count > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-sm font-medium text-text">{count} firma seçili</span>
          {!allMode && selected === pageCount && matching > pageCount && (
            <button type="button" onClick={() => setAllMode(true)} className="text-xs font-medium text-accent-text underline-offset-2 hover:underline">
              Filtreye uyan tümünü seç ({matching})
            </button>
          )}
          {allMode && (
            <button type="button" onClick={() => setAllMode(false)} className="text-xs text-text-3 hover:text-text">
              Yalnızca bu sayfadakiler
            </button>
          )}
          <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
            <Select name="op" value={op} onChange={(e) => setOp(e.target.value)} aria-label="İşlem" className="h-9 w-auto min-w-56 text-sm">
              {OPS.map(([k, l]) => (
                <option key={k} value={k}>{l}</option>
              ))}
            </Select>
            {op === "prepare" && (
              <div className="flex flex-wrap items-center gap-1.5">
                {([["p_email", "E-posta bul"], ["p_research", "Analiz et"], ["p_score", "Puanla"]] as const).map(([n, l]) => (
                  <label
                    key={n}
                    className={cn(
                      "flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                      steps[n] ? "border-accent bg-accent-soft text-accent-text" : "border-border text-text-3 hover:text-text",
                    )}
                  >
                    <input
                      type="checkbox"
                      name={n}
                      checked={steps[n]}
                      onChange={(e) => setSteps((s) => ({ ...s, [n]: e.target.checked }))}
                      className="size-3.5 accent-[var(--accent)]"
                    />
                    {l}
                  </label>
                ))}
              </div>
            )}
            {op === "campaign" && (
              <Select name="campaignId" defaultValue="" aria-label="Kampanya" className="h-9 w-auto min-w-48 text-sm">
                <option value="" disabled>{campaigns.length ? "Kampanya seçin…" : "Açık kampanya yok"}</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
            )}
            {op === "assign" && (
              <Select name="ownerId" defaultValue="" aria-label="Sorumlu" className="h-9 w-auto min-w-48 text-sm">
                <option value="" disabled>Kişi seçin…</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
                <option value="none">— Sorumluyu kaldır</option>
              </Select>
            )}
            {(op === "list_add" || op === "list_remove") && (
              <>
                <Select
                  name="listId"
                  value={listChoice}
                  onChange={(e) => setListChoice(e.target.value)}
                  aria-label="Liste"
                  className="h-9 w-auto min-w-48 text-sm"
                >
                  <option value="" disabled>{lists.length ? "Liste seçin…" : "Liste yok"}</option>
                  {lists.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                  {op === "list_add" && <option value="__new">+ Yeni liste oluştur</option>}
                </Select>
                {op === "list_add" && listChoice === "__new" && (
                  <Input name="listName" required placeholder="Yeni liste adı" maxLength={120} className="h-9 w-auto min-w-44 text-sm" />
                )}
              </>
            )}
            {op === "status" && (
              <Select name="status" defaultValue="" aria-label="Yeni durum" className="h-9 w-auto min-w-40 text-sm">
                <option value="" disabled>Durum seçin…</option>
                {statuses.map(([k, l]) => (
                  <option key={k} value={k}>{l}</option>
                ))}
              </Select>
            )}
            <ApplyButton label={op === "delete" ? "Sil" : "Uygula"} />
          </div>
        </div>
      )}
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.ok && state.message && <Alert tone="success" className={cn(count > 0 && "mt-1")}>{state.message}</Alert>}
    </form>
  );
}
