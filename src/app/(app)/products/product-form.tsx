"use client";

import Link from "next/link";
import { saveProductAction } from "@/app/actions/products";
import { ActionForm, FormMessage, SubmitButton } from "@/components/forms";
import { Field, Input, Select, Textarea, buttonClass } from "@/components/ui";

export interface ProductDefaults {
  id?: string;
  name?: string;
  sku?: string | null;
  categoryName?: string | null;
  description?: string | null;
  technicalSpecsText?: string;
  materials?: string[];
  dimensions?: string | null;
  applications?: string[];
  industries?: string[];
  minOrder?: string | null;
  priceRange?: string | null;
  deliveryTime?: string | null;
  certifications?: string[];
  active?: boolean;
  pending?: boolean;
}

const list = (v?: string[]) => (v ?? []).join(", ");

export function ProductForm({ d, categories }: { d: ProductDefaults; categories: string[] }) {
  return (
    <ActionForm action={saveProductAction}>
      {(state) => (
        <>
          <FormMessage state={state} />
          {d.id && <input type="hidden" name="id" value={d.id} />}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Ürün adı" htmlFor="name" error={state.fieldErrors?.name}>
              <Input id="name" name="name" defaultValue={d.name} required />
            </Field>
            <Field label="Kategori" htmlFor="categoryName" hint="Yoksa yeni kategori oluşturulur">
              <Input id="categoryName" name="categoryName" list="categories" defaultValue={d.categoryName ?? ""} />
              <datalist id="categories">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
            <Field label="Stok kodu (SKU)" htmlFor="sku">
              <Input id="sku" name="sku" defaultValue={d.sku ?? ""} />
            </Field>
            <Field label="Durum" htmlFor="active">
              <Select id="active" name="active" defaultValue={d.active === false ? "false" : "true"}>
                <option value="true">Aktif — satışta kullanılabilir</option>
                <option value="false">Pasif</option>
              </Select>
            </Field>
          </div>
          <Field label="Açıklama" htmlFor="description">
            <Textarea id="description" name="description" defaultValue={d.description ?? ""} />
          </Field>
          <Field label="Teknik özellikler" htmlFor="technicalSpecsText" hint="Her satıra bir özellik: Tel çapı: 0,5–8 mm">
            <Textarea id="technicalSpecsText" name="technicalSpecsText" defaultValue={d.technicalSpecsText ?? ""} className="font-mono text-xs" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Malzemeler" htmlFor="materials" hint="Virgülle ayırın">
              <Input id="materials" name="materials" defaultValue={list(d.materials)} />
            </Field>
            <Field label="Ölçüler" htmlFor="dimensions">
              <Input id="dimensions" name="dimensions" defaultValue={d.dimensions ?? ""} />
            </Field>
            <Field label="Kullanım alanları" htmlFor="applications">
              <Input id="applications" name="applications" defaultValue={list(d.applications)} />
            </Field>
            <Field label="Sektörler" htmlFor="industries">
              <Input id="industries" name="industries" defaultValue={list(d.industries)} />
            </Field>
            <Field label="Minimum sipariş" htmlFor="minOrder">
              <Input id="minOrder" name="minOrder" defaultValue={d.minOrder ?? ""} />
            </Field>
            <Field label="Teslim süresi" htmlFor="deliveryTime">
              <Input id="deliveryTime" name="deliveryTime" defaultValue={d.deliveryTime ?? ""} />
            </Field>
            <Field label="Fiyat aralığı" htmlFor="priceRange" hint="İç bilgi. AI müşteriye fiyat vermez, insan onayı gerekir.">
              <Input id="priceRange" name="priceRange" defaultValue={d.priceRange ?? ""} />
            </Field>
            <Field label="Sertifikalar" htmlFor="certifications">
              <Input id="certifications" name="certifications" defaultValue={list(d.certifications)} />
            </Field>
          </div>
          <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end">
            <Link href="/products" className={buttonClass("ghost")}>Vazgeç</Link>
            <SubmitButton pendingText="Kaydediliyor…">{d.pending ? "Düzelt ve onayla" : "Kaydet"}</SubmitButton>
          </div>
        </>
      )}
    </ActionForm>
  );
}
