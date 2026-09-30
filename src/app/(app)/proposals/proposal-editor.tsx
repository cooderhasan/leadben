"use client";

import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { saveProposalAction } from "@/app/actions/proposals";
import { ActionForm, FormMessage, SubmitButton } from "@/components/forms";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";

export interface EditorItem {
  productId: string | null;
  name: string;
  quantity: number | null;
  unit: string | null;
  unitPrice: number | null;
  note: string | null;
}

const toNum = (s: string) => {
  const t = s.trim().replace(/\s/g, "");
  if (!t) return NaN;
  const lastDot = t.lastIndexOf(".");
  const lastComma = t.lastIndexOf(",");
  if (lastDot !== -1 && lastComma !== -1) return lastComma > lastDot ? Number(t.replace(/\./g, "").replace(",", ".")) : Number(t.replace(/,/g, ""));
  if (lastComma !== -1) return Number(t.replace(",", "."));
  if (/^\d{1,3}(\.\d{3})+$/.test(t)) return Number(t.replace(/\./g, ""));
  return Number(t);
};
const fmtInput = (n: number | null) => (n == null ? "" : String(n).replace(".", ","));

interface Row {
  key: number;
  productId: string;
  name: string;
  qty: string;
  unit: string;
  price: string;
  note: string;
}

export function ProposalEditor({
  id,
  items,
  products,
  currency,
  validUntil,
  deliveryTerms,
  terms,
  editable,
}: {
  id: string;
  items: EditorItem[];
  products: Array<{ id: string; name: string }>;
  currency: string;
  validUntil: string | null;
  deliveryTerms: string | null;
  terms: string | null;
  editable: boolean;
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    (items.length ? items : [{ productId: null, name: "", quantity: null, unit: "adet", unitPrice: null, note: null }]).map((i, k) => ({
      key: k,
      productId: i.productId ?? "",
      name: i.name,
      qty: fmtInput(i.quantity),
      unit: i.unit ?? "",
      price: fmtInput(i.unitPrice),
      note: i.note ?? "",
    })),
  );
  const [cur, setCur] = useState(currency);
  const total = useMemo(() => {
    let t = 0;
    for (const r of rows) {
      const q = toNum(r.qty);
      const p = toNum(r.price);
      if (!Number.isFinite(q) || !Number.isFinite(p)) return null;
      t += q * p;
    }
    return rows.length ? t : null;
  }, [rows]);
  const money = (n: number) => new Intl.NumberFormat("tr-TR", { style: "currency", currency: cur }).format(n);
  const set = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <ActionForm action={saveProposalAction}>
      {(state) => (
        <>
          <input type="hidden" name="id" value={id} />
          <FormMessage state={state} />
          <fieldset disabled={!editable} className="flex flex-col gap-4">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="text-left text-xs text-text-2">
                  <tr>
                    <th className="py-2 pr-2 font-medium">Kalem</th>
                    <th className="w-24 px-2 py-2 font-medium">Adet</th>
                    <th className="w-20 px-2 py-2 font-medium">Birim</th>
                    <th className="w-32 px-2 py-2 font-medium">Birim fiyat</th>
                    <th className="w-32 px-2 py-2 text-right font-medium">Tutar</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const q = toNum(r.qty);
                    const p = toNum(r.price);
                    return (
                      <tr key={r.key} className="align-top">
                        <td className="py-1.5 pr-2">
                          <input type="hidden" name="item_productId" value={r.productId} />
                          <Select
                            value={r.productId}
                            onChange={(e) => {
                              const prod = products.find((x) => x.id === e.target.value);
                              set(r.key, { productId: e.target.value, name: prod ? prod.name : r.name });
                            }}
                            aria-label="Ürün"
                            className="mb-1 h-8 text-xs"
                          >
                            <option value="">Listede olmayan kalem</option>
                            {products.map((x) => (
                              <option key={x.id} value={x.id}>{x.name}</option>
                            ))}
                          </Select>
                          <Input name="item_name" value={r.name} onChange={(e) => set(r.key, { name: e.target.value })} placeholder="Kalem adı" aria-label="Kalem adı" className="h-8 text-xs" />
                          <Input name="item_note" value={r.note} onChange={(e) => set(r.key, { note: e.target.value })} placeholder="Not (ölçü, malzeme…)" aria-label="Not" className="mt-1 h-8 text-xs" />
                        </td>
                        <td className="px-2 py-1.5">
                          <Input name="item_qty" value={r.qty} onChange={(e) => set(r.key, { qty: e.target.value })} inputMode="decimal" aria-label="Adet" className={`h-8 text-xs ${r.qty && !Number.isFinite(q) ? "border-danger" : ""}`} />
                        </td>
                        <td className="px-2 py-1.5">
                          <Input name="item_unit" value={r.unit} onChange={(e) => set(r.key, { unit: e.target.value })} aria-label="Birim" className="h-8 text-xs" />
                        </td>
                        <td className="px-2 py-1.5">
                          <Input name="item_price" value={r.price} onChange={(e) => set(r.key, { price: e.target.value })} inputMode="decimal" placeholder="Siz girin" aria-label="Birim fiyat" className={`h-8 text-xs ${!r.price ? "border-warning" : ""}`} />
                        </td>
                        <td className="px-2 py-2 text-right text-xs tabular-nums text-text">{Number.isFinite(q) && Number.isFinite(p) ? money(q * p) : "—"}</td>
                        <td className="py-1.5">
                          <Button type="button" variant="ghost" size="sm" aria-label="Kalemi sil" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                            <Trash2 className="size-4" aria-hidden />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setRows((rs) => [...rs, { key: Math.max(0, ...rs.map((x) => x.key)) + 1, productId: "", name: "", qty: "", unit: "adet", price: "", note: "" }])}
              >
                <Plus className="size-4" aria-hidden /> Kalem ekle
              </Button>
              <p className="text-sm">
                Toplam (KDV hariç): <strong className="tabular-nums">{total != null ? money(total) : "Fiyat/adet eksik"}</strong>
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Para birimi" htmlFor="currency">
                <Select id="currency" name="currency" value={cur} onChange={(e) => setCur(e.target.value)}>
                  <option value="TRY">TRY</option>
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                </Select>
              </Field>
              <Field label="Geçerlilik" htmlFor="validUntil">
                <Input id="validUntil" name="validUntil" type="date" defaultValue={validUntil ?? ""} />
              </Field>
              <Field label="Teslim koşulu" htmlFor="deliveryTerms" hint="Doğrulanmış bilgilerinizde yoksa AI boş bırakır.">
                <Input id="deliveryTerms" name="deliveryTerms" defaultValue={deliveryTerms ?? ""} maxLength={600} />
              </Field>
            </div>
            <Field label="Açıklama / koşullar" htmlFor="terms">
              <Textarea id="terms" name="terms" rows={3} defaultValue={terms ?? ""} maxLength={2000} />
            </Field>
          </fieldset>
          {editable && <SubmitButton pendingText="Kaydediliyor…" className="self-start">Kaydet</SubmitButton>}
        </>
      )}
    </ActionForm>
  );
}
