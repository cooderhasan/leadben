import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireTenantPage } from "@/server/tenancy/context";
import { tenantDb } from "@/server/tenancy/tenant-db";
import { getProposal, parseItems } from "@/server/services/proposals";
import { getSenderSettings } from "@/server/services/email-settings";
import { isAppError } from "@/lib/errors";
import { PrintButton } from "./print-button";

export const metadata: Metadata = { title: "Teklif" };

/**
 * Yazdırılabilir teklif (tarayıcıdan "PDF olarak kaydet"). Yalnızca onaylı teklif yazdırılır.
 * Ek kütüphane ve Türkçe font gerektirmez.
 */
export default async function PrintProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireTenantPage();
  const { id } = await params;
  let p;
  try {
    p = await getProposal(ctx, id);
  } catch (err) {
    if (isAppError(err) && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  if (!["APPROVED", "SENT", "ACCEPTED"].includes(p.status)) notFound();
  const [{ settings }, company] = await Promise.all([
    getSenderSettings(ctx.companyId),
    tenantDb(ctx).company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { name: true, website: true } }),
  ]);
  const items = parseItems(p.items);
  const money = (n: number) => new Intl.NumberFormat("tr-TR", { style: "currency", currency: p.currency }).format(n);
  const date = (d: Date) => new Intl.DateTimeFormat("tr-TR", { dateStyle: "long" }).format(d);

  return (
    <main className="mx-auto max-w-3xl bg-white px-8 py-10 text-[13px] leading-relaxed text-black print:px-0 print:py-0">
      <div className="mb-6 flex justify-end print:hidden">
        <PrintButton />
      </div>
      <header className="mb-8 flex items-start justify-between gap-6 border-b border-black/20 pb-6">
        <div>
          <p className="text-lg font-semibold">{settings?.legalName ?? company.name}</p>
          {settings?.postalAddress && <p className="text-black/70">{settings.postalAddress}</p>}
          <p className="text-black/70">{[settings?.phone, settings?.fromEmail, company.website].filter(Boolean).join(" · ")}</p>
        </div>
        <div className="text-right">
          <p className="text-xl font-semibold">TEKLİF</p>
          <p>No: {p.number}</p>
          <p>Tarih: {date(p.approvedAt ?? p.createdAt)}</p>
          {p.validUntil && <p>Geçerlilik: {date(p.validUntil)}</p>}
        </div>
      </header>

      <section className="mb-6">
        <p className="text-black/60">Sayın</p>
        <p className="font-semibold">{p.lead.companyName}</p>
        {p.lead.address && <p className="text-black/70">{p.lead.address}</p>}
      </section>

      {p.terms && <p className="mb-6 whitespace-pre-wrap">{p.terms}</p>}

      <table className="mb-6 w-full border-collapse">
        <thead>
          <tr className="border-b border-black/40 text-left">
            <th className="py-2 pr-2">#</th>
            <th className="py-2 pr-2">Açıklama</th>
            <th className="py-2 pr-2 text-right">Miktar</th>
            <th className="py-2 pr-2 text-right">Birim fiyat</th>
            <th className="py-2 text-right">Tutar</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i, idx) => (
            <tr key={idx} className="border-b border-black/10 align-top">
              <td className="py-2 pr-2">{idx + 1}</td>
              <td className="py-2 pr-2">
                {i.name}
                {i.note && <p className="text-black/60">{i.note}</p>}
              </td>
              <td className="py-2 pr-2 text-right tabular-nums">{i.quantity?.toLocaleString("tr-TR")} {i.unit}</td>
              <td className="py-2 pr-2 text-right tabular-nums">{i.unitPrice != null ? money(i.unitPrice) : "—"}</td>
              <td className="py-2 text-right tabular-nums">{i.unitPrice != null && i.quantity != null ? money(i.unitPrice * i.quantity) : "—"}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={4} className="py-3 pr-2 text-right font-semibold">Toplam (KDV hariç)</td>
            <td className="py-3 text-right font-semibold tabular-nums">{p.totalAmount != null ? money(Number(p.totalAmount)) : "—"}</td>
          </tr>
        </tfoot>
      </table>

      {p.deliveryTerms && <p className="mb-2"><strong>Teslim:</strong> {p.deliveryTerms}</p>}
      <p className="mt-10 text-black/60">Saygılarımızla,<br />{settings?.fromName ?? company.name}</p>
    </main>
  );
}
