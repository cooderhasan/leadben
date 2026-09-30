import type { Metadata } from "next";
import Link from "next/link";
import { Check, Package, Plus } from "lucide-react";
import { requireTenantPage } from "@/server/tenancy/context";
import { listProducts } from "@/server/services/products";
import { toggleProductAction, verifyProductsAction } from "@/app/actions/products";
import { Badge, Button, Card, CardHeader, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { FACT_SOURCE_LABELS } from "@/lib/facts";

export const metadata: Metadata = { title: "Ürünler" };

export default async function ProductsPage() {
  const ctx = await requireTenantPage();
  const products = await listProducts(ctx);
  const pending = products.filter((p) => p.status === "PENDING");
  const verified = products.filter((p) => p.status === "VERIFIED");

  return (
    <>
      <PageHeader
        title="Ürünler"
        description="AI hangi lead'e hangi ürünün uygun olduğunu bu listeden eşleştirir. Yalnızca onaylı ve aktif ürünler kullanılır."
        actions={
          <LinkButton href="/products/new">
            <Plus className="size-4" aria-hidden /> Ürün ekle
          </LinkButton>
        }
      />

      {pending.length > 0 && (
        <Card className="mb-6 border-warning/40">
          <CardHeader
            title={`Dokümanlardan çıkarılan ${pending.length} ürün onay bekliyor`}
            description="Kontrol edip onaylayın; gerekirse düzeltin. Onaylanmayan ürünler satışta kullanılmaz."
            action={
              <form action={verifyProductsAction}>
                {pending.map((p) => (
                  <input key={p.id} type="hidden" name="productId" value={p.id} />
                ))}
                <Button type="submit" size="sm" variant="secondary">
                  <Check className="size-3.5" aria-hidden /> Tümünü onayla
                </Button>
              </form>
            }
          />
          <ul className="divide-y divide-border">
            {pending.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text">{p.name}</p>
                  <p className="truncate text-xs text-text-3">{p.description ?? p.category?.name ?? "Açıklama yok"}</p>
                </div>
                <div className="flex gap-1">
                  <form action={verifyProductsAction}>
                    <input type="hidden" name="productId" value={p.id} />
                    <Button type="submit" size="sm" variant="ghost" className="text-success">
                      <Check className="size-3.5" aria-hidden /> Onayla
                    </Button>
                  </form>
                  <LinkButton href={`/products/${p.id}`} size="sm" variant="ghost">Düzelt</LinkButton>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        {verified.length === 0 ? (
          <EmptyState
            icon={<Package className="size-8" />}
            title="Henüz ürün yok"
            description="Ürünlerinizi elle ekleyin veya katalog yükleyin — AI ürünleri dokümandan çıkarıp onayınıza sunar."
            action={
              <div className="flex gap-2">
                <LinkButton href="/products/new">Ürün ekle</LinkButton>
                <LinkButton href="/knowledge" variant="secondary">Katalog yükle</LinkButton>
              </div>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-border text-left text-xs text-text-2">
                <tr>
                  <th className="px-5 py-3 font-medium">Ürün</th>
                  <th className="px-3 py-3 font-medium">Kategori</th>
                  <th className="px-3 py-3 font-medium">Sektörler</th>
                  <th className="px-3 py-3 font-medium">Kaynak</th>
                  <th className="px-5 py-3 text-right font-medium">Durum</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {verified.map((p) => (
                  <tr key={p.id} className="hover:bg-surface-2/60">
                    <td className="px-5 py-3">
                      <Link href={`/products/${p.id}`} className="font-medium text-text hover:text-accent">{p.name}</Link>
                      {p.sku && <span className="ml-2 text-xs text-text-3">{p.sku}</span>}
                    </td>
                    <td className="px-3 py-3 text-text-2">{p.category?.name ?? "—"}</td>
                    <td className="max-w-56 truncate px-3 py-3 text-text-2">{p.industries.join(", ") || "—"}</td>
                    <td className="px-3 py-3 text-text-2">{FACT_SOURCE_LABELS[p.source]}</td>
                    <td className="px-5 py-3 text-right">
                      <form action={toggleProductAction} className="inline">
                        <input type="hidden" name="id" value={p.id} />
                        <input type="hidden" name="active" value={String(!p.active)} />
                        <button type="submit" title={p.active ? "Pasife al" : "Aktif et"}>
                          {p.active ? <Badge tone="success">Aktif</Badge> : <Badge>Pasif</Badge>}
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
