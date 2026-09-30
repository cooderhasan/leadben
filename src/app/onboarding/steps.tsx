"use client";

import Link from "next/link";
import { Globe, Trash2 } from "lucide-react";
import {
  addCompetitorAction,
  analyzeWebsiteAction,
  saveCompanyInfoAction,
  saveExclusionsAction,
  saveProductionAction,
  saveSalesAction,
  saveTargetAction,
} from "@/app/actions/onboarding";
import { ActionForm, FormMessage, SubmitButton } from "@/components/forms";
import { Field, Input, Select, Textarea, buttonClass } from "@/components/ui";

const list = (v?: string[] | null) => (v ?? []).join(", ");

function StepFooter({ back, submit = "Kaydet ve devam et", returnTo }: { back?: string; submit?: string; returnTo?: string }) {
  return (
    <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-between">
      {back ? (
        <Link href={returnTo ?? `/onboarding?step=${back}`} className={buttonClass("ghost")}>
          Geri
        </Link>
      ) : (
        <span />
      )}
      {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
      <SubmitButton pendingText="Kaydediliyor…">{returnTo ? "Kaydet" : submit}</SubmitButton>
    </div>
  );
}

// ── 1. Web sitesi ──────────────────────────────────────────────────────
export function WebsiteStep({ defaultUrl, aiReady }: { defaultUrl?: string | null; aiReady: boolean }) {
  return (
    <ActionForm action={analyzeWebsiteAction}>
      {(state) => (
        <>
          <FormMessage state={state} />
          <Field
            label="Web siteniz"
            htmlFor="website"
            hint="Sitenizi okuyup ürünlerinizi, sektörlerinizi ve güçlü yönlerinizi çıkaracağım. 2 kredi."
            error={state.fieldErrors?.website}
          >
            <div className="relative">
              <Globe className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-3" aria-hidden />
              <Input id="website" name="website" placeholder="ornekfirma.com.tr" defaultValue={defaultUrl ?? ""} className="pl-9" required />
            </div>
          </Field>
          {!aiReady && (
            <p className="rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning">
              AI sağlayıcısı henüz yapılandırılmamış (.env → ANTHROPIC_API_KEY). Analiz başlatılamaz; bu adımı atlayıp bilgileri elle girebilirsiniz.
            </p>
          )}
          <SubmitButton pendingText="Başlatılıyor…" className="self-start">Sitemi analiz et</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}

// ── 2. Firma bilgileri ─────────────────────────────────────────────────
export interface CompanyDefaults {
  name: string;
  website?: string | null;
  country?: string | null;
  city?: string | null;
  sector?: string | null;
  subSector?: string | null;
  serviceRegions?: string[];
  sizeBand?: string | null;
  employeeCount?: number | null;
  description?: string | null;
}

export function CompanyStep({ d, suggestions, returnTo }: { d: CompanyDefaults; suggestions: { sector?: string; subSector?: string; description?: string }; returnTo?: string }) {
  return (
    <ActionForm action={saveCompanyInfoAction}>
      {(state) => (
        <>
          <FormMessage state={state} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Firma adı" htmlFor="name" error={state.fieldErrors?.name}>
              <Input id="name" name="name" defaultValue={d.name} required />
            </Field>
            <Field label="Web sitesi" htmlFor="website">
              <Input id="website" name="website" defaultValue={d.website ?? ""} />
            </Field>
            <Field label="Sektör" htmlFor="sector" hint={suggestions.sector && !d.sector ? `AI önerisi: ${suggestions.sector}` : undefined}>
              <Input id="sector" name="sector" defaultValue={d.sector ?? suggestions.sector ?? ""} placeholder="ör. Endüstriyel yay üretimi" />
            </Field>
            <Field label="Alt sektör" htmlFor="subSector">
              <Input id="subSector" name="subSector" defaultValue={d.subSector ?? suggestions.subSector ?? ""} />
            </Field>
            <Field label="Ülke" htmlFor="country">
              <Input id="country" name="country" defaultValue={d.country ?? "Türkiye"} />
            </Field>
            <Field label="Şehir" htmlFor="city">
              <Input id="city" name="city" defaultValue={d.city ?? ""} />
            </Field>
            <Field label="Hizmet bölgeleri" htmlFor="serviceRegions" hint="Virgülle ayırın: Türkiye, Almanya, Balkanlar">
              <Input id="serviceRegions" name="serviceRegions" defaultValue={list(d.serviceRegions)} />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Firma büyüklüğü" htmlFor="sizeBand">
                <Select id="sizeBand" name="sizeBand" defaultValue={d.sizeBand ?? ""}>
                  <option value="">Seçin</option>
                  <option value="1-10">1–10</option>
                  <option value="11-50">11–50</option>
                  <option value="51-200">51–200</option>
                  <option value="201-500">201–500</option>
                  <option value="500+">500+</option>
                </Select>
              </Field>
              <Field label="Çalışan sayısı" htmlFor="employeeCount" error={state.fieldErrors?.employeeCount}>
                <Input id="employeeCount" name="employeeCount" inputMode="numeric" defaultValue={d.employeeCount ?? ""} />
              </Field>
            </div>
          </div>
          <Field label="Kısa tanım" htmlFor="description" hint="Ne üretiyor / satıyorsunuz, kime?">
            <Textarea id="description" name="description" defaultValue={d.description ?? suggestions.description ?? ""} />
          </Field>
          <StepFooter back="website" returnTo={returnTo} />
        </>
      )}
    </ActionForm>
  );
}

// ── 3. Ürün ve üretim ──────────────────────────────────────────────────
export interface ProductionDefaults {
  minOrder?: string | null;
  priceRangeNote?: string | null;
  avgOrderValue?: number | null;
  productionCapacity?: string | null;
  deliveryTime?: string | null;
  customManufacturing?: boolean | null;
  certifications: string[];
  productNames: string[];
}

export function ProductionStep({ d, returnTo }: { d: ProductionDefaults; returnTo?: string }) {
  return (
    <ActionForm action={saveProductionAction}>
      {(state) => (
        <>
          <FormMessage state={state} />
          <Field
            label="Ürünleriniz / ürün gruplarınız"
            htmlFor="productNames"
            hint="Her satıra bir ürün. Detayları sonra Ürünler sayfasından ekleyebilirsiniz."
          >
            <Textarea id="productNames" name="productNames" defaultValue={d.productNames.join("\n")} placeholder={"Basma yay\nÇekme yay"} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Minimum sipariş" htmlFor="minOrder">
              <Input id="minOrder" name="minOrder" defaultValue={d.minOrder ?? ""} placeholder="ör. 500 adet" />
            </Field>
            <Field label="Teslim süresi" htmlFor="deliveryTime">
              <Input id="deliveryTime" name="deliveryTime" defaultValue={d.deliveryTime ?? ""} placeholder="ör. 2–4 hafta" />
            </Field>
            <Field label="Üretim kapasitesi" htmlFor="productionCapacity">
              <Input id="productionCapacity" name="productionCapacity" defaultValue={d.productionCapacity ?? ""} />
            </Field>
            <Field label="Ortalama sipariş tutarı (₺)" htmlFor="avgOrderValue" error={state.fieldErrors?.avgOrderValue}>
              <Input id="avgOrderValue" name="avgOrderValue" inputMode="decimal" defaultValue={d.avgOrderValue ?? ""} />
            </Field>
            <Field label="Fiyat aralığı notu" htmlFor="priceRangeNote" hint="Yalnızca iç bilgi — AI müşteriye fiyat vermez.">
              <Input id="priceRangeNote" name="priceRangeNote" defaultValue={d.priceRangeNote ?? ""} />
            </Field>
            <Field label="Özel üretim yapıyor musunuz?" htmlFor="customManufacturing">
              <Select id="customManufacturing" name="customManufacturing" defaultValue={d.customManufacturing == null ? "" : d.customManufacturing ? "yes" : "no"}>
                <option value="">Belirtilmedi</option>
                <option value="yes">Evet</option>
                <option value="no">Hayır</option>
              </Select>
            </Field>
          </div>
          <Field label="Sertifikalar / kalite belgeleri" htmlFor="certifications" hint="Virgülle ayırın. Buraya girdiğiniz belgeler onaylı bilgi sayılır.">
            <Input id="certifications" name="certifications" defaultValue={list(d.certifications)} placeholder="ISO 9001, IATF 16949" />
          </Field>
          <StepFooter back="company" returnTo={returnTo} />
        </>
      )}
    </ActionForm>
  );
}

// ── 4. Hedef müşteri ───────────────────────────────────────────────────
export interface TargetDefaults {
  name?: string;
  businessModel?: string | null;
  industries: string[];
  subIndustries: string[];
  countries: string[];
  cities: string[];
  minEmployees?: number | null;
  maxEmployees?: number | null;
  minRevenue?: number | null;
  customerTypes: string[];
  decisionMakerRoles: string[];
  notes?: string | null;
}

export function TargetStep({ d, returnTo }: { d: TargetDefaults; returnTo?: string }) {
  return (
    <ActionForm action={saveTargetAction}>
      {(state) => (
        <>
          <FormMessage state={state} />
          <input type="hidden" name="name" value={d.name ?? "Ana hedef pazar"} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Satış modeli" htmlFor="businessModel">
              <Select id="businessModel" name="businessModel" defaultValue={d.businessModel ?? "B2B"}>
                <option value="B2B">B2B — firmalara</option>
                <option value="B2C">B2C — bireylere</option>
                <option value="B2B_B2C">Her ikisi</option>
              </Select>
            </Field>
            <Field label="Hedef sektörler" htmlFor="industries" hint="Virgülle ayırın">
              <Input id="industries" name="industries" defaultValue={list(d.industries)} placeholder="Otomotiv, Beyaz eşya, Tarım makineleri" />
            </Field>
            <Field label="Alt sektörler" htmlFor="subIndustries">
              <Input id="subIndustries" name="subIndustries" defaultValue={list(d.subIndustries)} placeholder="Otomotiv yan sanayi" />
            </Field>
            <Field label="Ülkeler" htmlFor="countries">
              <Input id="countries" name="countries" defaultValue={list(d.countries)} placeholder="Türkiye" />
            </Field>
            <Field label="Şehirler" htmlFor="cities">
              <Input id="cities" name="cities" defaultValue={list(d.cities)} placeholder="İstanbul, Bursa, Kocaeli" />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Min. çalışan" htmlFor="minEmployees">
                <Input id="minEmployees" name="minEmployees" inputMode="numeric" defaultValue={d.minEmployees ?? ""} />
              </Field>
              <Field label="Maks. çalışan" htmlFor="maxEmployees">
                <Input id="maxEmployees" name="maxEmployees" inputMode="numeric" defaultValue={d.maxEmployees ?? ""} />
              </Field>
            </div>
            <Field label="Tahmini minimum ciro (₺)" htmlFor="minRevenue">
              <Input id="minRevenue" name="minRevenue" inputMode="decimal" defaultValue={d.minRevenue ?? ""} />
            </Field>
            <Field label="Müşteri tipi" htmlFor="customerTypes">
              <Input id="customerTypes" name="customerTypes" defaultValue={list(d.customerTypes)} placeholder="Üretici, OEM tedarikçisi" />
            </Field>
          </div>
          <Field label="Karar verici pozisyonlar" htmlFor="decisionMakerRoles">
            <Input
              id="decisionMakerRoles"
              name="decisionMakerRoles"
              defaultValue={list(d.decisionMakerRoles)}
              placeholder="Satın alma müdürü, Tedarik zinciri müdürü, Üretim müdürü"
            />
          </Field>
          <Field label="Notlar" htmlFor="notes">
            <Textarea id="notes" name="notes" defaultValue={d.notes ?? ""} />
          </Field>
          <StepFooter back="products" returnTo={returnTo} />
        </>
      )}
    </ActionForm>
  );
}

// ── 5. Satış bilgileri ─────────────────────────────────────────────────
export interface SalesDefaults {
  currency: string;
  avgSaleValue?: number | null;
  salesCycleDays?: number | null;
  monthlySalesTarget?: number | null;
  existingCustomerTypes: string[];
  existingCustomerExamples: string[];
}

export function SalesStep({ d, returnTo }: { d: SalesDefaults; returnTo?: string }) {
  return (
    <ActionForm action={saveSalesAction}>
      {(state) => (
        <>
          <FormMessage state={state} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Para birimi" htmlFor="currency">
              <Select id="currency" name="currency" defaultValue={d.currency}>
                <option value="TRY">TRY ₺</option>
                <option value="USD">USD $</option>
                <option value="EUR">EUR €</option>
              </Select>
            </Field>
            <Field label="Ortalama satış tutarı" htmlFor="avgSaleValue" error={state.fieldErrors?.avgSaleValue}>
              <Input id="avgSaleValue" name="avgSaleValue" inputMode="decimal" defaultValue={d.avgSaleValue ?? ""} />
            </Field>
            <Field label="Ortalama satış döngüsü (gün)" htmlFor="salesCycleDays">
              <Input id="salesCycleDays" name="salesCycleDays" inputMode="numeric" defaultValue={d.salesCycleDays ?? ""} />
            </Field>
            <Field label="Hedef aylık yeni satış" htmlFor="monthlySalesTarget">
              <Input id="monthlySalesTarget" name="monthlySalesTarget" inputMode="decimal" defaultValue={d.monthlySalesTarget ?? ""} />
            </Field>
          </div>
          <Field label="Mevcut müşteri tipleri" htmlFor="existingCustomerTypes">
            <Input id="existingCustomerTypes" name="existingCustomerTypes" defaultValue={list(d.existingCustomerTypes)} />
          </Field>
          <Field
            label="Mevcut müşteri örnekleri"
            htmlFor="existingCustomerExamples"
            hint="Yalnızca iç kullanım: AI benzer firmaları bulmak için kullanır, mesajlarda referans olarak göstermez."
          >
            <Input id="existingCustomerExamples" name="existingCustomerExamples" defaultValue={list(d.existingCustomerExamples)} />
          </Field>
          <StepFooter back="target" returnTo={returnTo} />
        </>
      )}
    </ActionForm>
  );
}

// ── 6. Rakipler ────────────────────────────────────────────────────────
export function CompetitorForm() {
  return (
    <ActionForm action={addCompetitorAction} resetOnSuccess>
      {(state) => (
        <>
          <FormMessage state={state} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Rakip adı" htmlFor="c-name" error={state.fieldErrors?.name}>
              <Input id="c-name" name="name" required />
            </Field>
            <Field label="Web sitesi" htmlFor="c-website">
              <Input id="c-website" name="website" />
            </Field>
            <Field label="Bilinen güçlü yönler" htmlFor="c-strengths" hint="Virgülle ayırın">
              <Input id="c-strengths" name="strengths" />
            </Field>
            <Field label="Bilinen zayıf yönler" htmlFor="c-weaknesses">
              <Input id="c-weaknesses" name="weaknesses" />
            </Field>
          </div>
          <SubmitButton variant="secondary" pendingText="Ekleniyor…" className="self-start">Rakip ekle</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}

export function DeleteIcon() {
  return <Trash2 className="size-4" aria-hidden />;
}

// ── 7. İstenmeyen müşteriler ───────────────────────────────────────────
export interface ExclusionDefaults {
  industries: string[];
  cities: string[];
  customerTypes: string[];
  notes?: string | null;
  rules: string[];
}

export function ExclusionsStep({ d, returnTo }: { d: ExclusionDefaults; returnTo?: string }) {
  return (
    <ActionForm action={saveExclusionsAction}>
      {(state) => (
        <>
          <FormMessage state={state} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="İstenmeyen sektörler" htmlFor="x-industries">
              <Input id="x-industries" name="industries" defaultValue={list(d.industries)} />
            </Field>
            <Field label="İstenmeyen şehirler" htmlFor="x-cities">
              <Input id="x-cities" name="cities" defaultValue={list(d.cities)} />
            </Field>
            <Field label="İstenmeyen müşteri tipleri" htmlFor="x-types" className="sm:col-span-2">
              <Input id="x-types" name="customerTypes" defaultValue={list(d.customerTypes)} placeholder="Bireysel müşteri, perakende" />
            </Field>
          </div>
          <Field
            label="Satış kuralları"
            htmlFor="x-rules"
            hint="Her satıra bir kural. AI bu kuralları ihlal etmez. Ör: 500 adetten düşük siparişlerle ilgilenmiyoruz."
          >
            <Textarea id="x-rules" name="rules" defaultValue={d.rules.join("\n")} />
          </Field>
          <Field label="Notlar" htmlFor="x-notes">
            <Textarea id="x-notes" name="notes" defaultValue={d.notes ?? ""} className="min-h-16" />
          </Field>
          <StepFooter back="competitors" returnTo={returnTo} />
        </>
      )}
    </ActionForm>
  );
}
