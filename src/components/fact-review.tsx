import { Check, ExternalLink, PackagePlus, ShieldAlert, X } from "lucide-react";
import type { CompanyFact } from "@prisma/client";
import { promoteFactAction, rejectFactsAction, verifyFactsAction, verifySummaryAction } from "@/app/actions/facts";
import { FACT_GROUP_ORDER, FACT_SOURCE_LABELS, factGroup, factLabel } from "@/lib/facts";
import { Badge, Button, Card, CardBody, CardHeader } from "./ui";
import { FactEditButton, SummaryEditor } from "./fact-editors";

/** "Firmayı böyle anladım" — AI özeti + Onayla / Düzelt. */
export function SummaryCard({ summary, status }: { summary: string | null; status: "PENDING" | "VERIFIED" | "REJECTED" }) {
  if (!summary) return null;
  return (
    <Card className={status === "PENDING" ? "border-accent/40 ring-1 ring-accent/15" : undefined}>
      <CardBody className="flex flex-col gap-4 py-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold text-text">Firmayı böyle anladım</h2>
          {status === "VERIFIED" ? <Badge tone="success">Onaylandı</Badge> : <Badge tone="warning">Onayınızı bekliyor</Badge>}
        </div>
        <p className="whitespace-pre-line text-[15px] leading-relaxed text-text">{summary}</p>
        {status !== "VERIFIED" && (
          <p className="text-xs text-text-3">
            Onaylamadığınız bilgiler satış mesajlarında kesin bilgi olarak kullanılmaz.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {status !== "VERIFIED" && (
            <form action={verifySummaryAction}>
              <Button type="submit">
                <Check className="size-4" aria-hidden /> Onayla
              </Button>
            </form>
          )}
          <SummaryEditor summary={summary} />
        </div>
      </CardBody>
    </Card>
  );
}

function ConfidenceHint({ fact }: { fact: CompanyFact }) {
  if (fact.source === "AI_INFERRED") return <Badge tone="accent">AI çıkarımı</Badge>;
  if ((fact.confidence ?? 1) < 0.5)
    return (
      <Badge tone="warning">
        <ShieldAlert className="size-3" aria-hidden /> Kaynakta doğrulanamadı
      </Badge>
    );
  return null;
}

/**
 * Onay bekleyen bilgileri gruplar halinde gösterir. Her bilgi: Onayla / Düzelt / Reddet.
 * Grup başına "Tümünü onayla".
 */
export function FactReview({ facts, emptyText }: { facts: CompanyFact[]; emptyText?: string }) {
  if (facts.length === 0) {
    return emptyText ? <p className="text-sm text-text-2">{emptyText}</p> : null;
  }
  const groups = new Map<string, CompanyFact[]>();
  for (const f of facts) {
    const g = factGroup(f.key);
    groups.set(g, [...(groups.get(g) ?? []), f]);
  }
  const ordered = [...FACT_GROUP_ORDER, "Diğer"].filter((g) => groups.has(g));

  return (
    <div className="flex flex-col gap-4">
      {ordered.map((group) => {
        const items = groups.get(group)!;
        return (
          <Card key={group}>
            <CardHeader
              title={group}
              description={`${items.length} bilgi onay bekliyor`}
              action={
                <form action={verifyFactsAction}>
                  {items.map((f) => (
                    <input key={f.id} type="hidden" name="factId" value={f.id} />
                  ))}
                  <Button type="submit" size="sm" variant="secondary">
                    <Check className="size-3.5" aria-hidden /> Tümünü onayla
                  </Button>
                </form>
              }
            />
            <ul className="divide-y divide-border">
              {items.map((f) => (
                <li key={f.id} className="flex flex-col gap-2 px-5 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium uppercase tracking-wide text-text-3">{factLabel(f.key)}</span>
                    <ConfidenceHint fact={f} />
                    <span className="text-xs text-text-3">· {FACT_SOURCE_LABELS[f.source]}</span>
                    {f.sourceRef?.startsWith("http") && (
                      <a href={f.sourceRef} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 text-xs text-accent hover:underline">
                        kaynak <ExternalLink className="size-3" aria-hidden />
                      </a>
                    )}
                  </div>
                  <p className="text-sm text-text">{f.value}</p>
                  <div className="flex flex-wrap items-center gap-1">
                    <form action={verifyFactsAction}>
                      <input type="hidden" name="factId" value={f.id} />
                      <Button type="submit" size="sm" variant="ghost" className="text-success">
                        <Check className="size-3.5" aria-hidden /> Onayla
                      </Button>
                    </form>
                    <FactEditButton factId={f.id} value={f.value} />
                    <form action={rejectFactsAction}>
                      <input type="hidden" name="factId" value={f.id} />
                      <Button type="submit" size="sm" variant="ghost" className="text-danger">
                        <X className="size-3.5" aria-hidden /> Reddet
                      </Button>
                    </form>
                    {f.key === "product" && (
                      <form action={promoteFactAction}>
                        <input type="hidden" name="factId" value={f.id} />
                        <Button type="submit" size="sm" variant="ghost">
                          <PackagePlus className="size-3.5" aria-hidden /> Ürünlere ekle
                        </Button>
                      </form>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}
