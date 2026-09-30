"use client";

import { useState } from "react";
import { Pencil, Plus, X } from "lucide-react";
import { addFactAction, correctFactAction, correctSummaryAction, removeFactAction } from "@/app/actions/facts";
import { ActionForm, SubmitButton } from "./forms";
import { Button, Input, Select, Textarea } from "./ui";

export function FactEditButton({ factId, value }: { factId: string; value: string }) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)} aria-label="Düzelt">
        <Pencil className="size-3.5" aria-hidden /> Düzelt
      </Button>
    );
  }
  return (
    <div className="w-full basis-full">
      <ActionForm action={correctFactAction} onSuccess={() => setEditing(false)} className="gap-2">
        {(state) => (
          <>
            <input type="hidden" name="factId" value={factId} />
            <Textarea name="value" defaultValue={value} className="min-h-16" autoFocus aria-label="Düzeltilmiş değer" />
            {state.error && <p className="text-xs text-danger">{state.error}</p>}
            <div className="flex gap-2">
              <SubmitButton size="sm" pendingText="Kaydediliyor…">Kaydet ve onayla</SubmitButton>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Vazgeç</Button>
            </div>
          </>
        )}
      </ActionForm>
    </div>
  );
}

/** Bilgi grubuna yeni onaylı bilgi ekleme (ör. Hedef pazar → Hizmet verilen sektör: Raylı sistemler) */
export function FactAddButton({ keys }: { keys: Array<{ key: string; label: string }> }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" aria-hidden /> Ekle
      </Button>
    );
  }
  return (
    <div className="w-full basis-full">
      <ActionForm action={addFactAction} className="gap-2" resetOnSuccess>
        {(state) => (
          <>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select name="key" defaultValue={keys[0]?.key} aria-label="Bilgi türü" className="sm:w-52">
                {keys.map((k) => (
                  <option key={k.key} value={k.key}>{k.label}</option>
                ))}
              </Select>
              <Input name="value" required maxLength={500} autoFocus placeholder="ör. Raylı sistemler / Demiryolu" aria-label="Değer" className="flex-1" />
            </div>
            {state.error && <p className="text-xs text-danger">{state.error}</p>}
            {state.ok && <p className="text-xs text-success">{state.message} Başka bir tane ekleyebilirsiniz.</p>}
            <div className="flex gap-2">
              <SubmitButton size="sm" pendingText="Ekleniyor…">Ekle</SubmitButton>
              <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Kapat</Button>
            </div>
          </>
        )}
      </ActionForm>
    </div>
  );
}

/** Onaylı bilgiyi kaldırma (onay sorar) */
export function FactRemoveButton({ factId, value }: { factId: string; value: string }) {
  return (
    <form
      action={removeFactAction}
      onSubmit={(e) => {
        if (!window.confirm(`"${value.slice(0, 80)}" kaldırılsın mı? Satış mesajlarında artık kullanılmaz.`)) e.preventDefault();
      }}
    >
      <input type="hidden" name="factId" value={factId} />
      <Button type="submit" variant="ghost" size="sm" aria-label="Kaldır" title="Kaldır" className="px-2 text-text-3 hover:text-danger">
        <X className="size-3.5" aria-hidden />
      </Button>
    </form>
  );
}

export function SummaryEditor({ summary }: { summary: string }) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <Button type="button" variant="secondary" onClick={() => setEditing(true)}>
        <Pencil className="size-4" aria-hidden /> Düzelt
      </Button>
    );
  }
  return (
    <div className="w-full">
      <ActionForm action={correctSummaryAction} onSuccess={() => setEditing(false)} className="gap-2">
        {(state) => (
          <>
            <Textarea name="summary" defaultValue={summary} className="min-h-32" autoFocus aria-label="Şirket özeti" />
            {state.error && <p className="text-xs text-danger">{state.error}</p>}
            <div className="flex gap-2">
              <SubmitButton pendingText="Kaydediliyor…">Kaydet ve onayla</SubmitButton>
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>Vazgeç</Button>
            </div>
          </>
        )}
      </ActionForm>
    </div>
  );
}
