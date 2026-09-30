import type { Metadata } from "next";
import { Brain } from "lucide-react";
import { requireTenantPage } from "@/server/tenancy/context";
import { listMemories, MEMORY_TYPE_LABELS } from "@/server/services/memory";
import { setMemoryStatusAction } from "@/app/actions/settings";
import { Badge, Button, Card, CardBody, CardHeader, EmptyState } from "@/components/ui";
import { FACT_SOURCE_LABELS } from "@/lib/facts";
import { formatDate } from "@/lib/cn";
import { MemoryForm } from "../forms";

export const metadata: Metadata = { title: "Şirket hafızası" };

export default async function MemoryPage() {
  const ctx = await requireTenantPage();
  const memories = await listMemories(ctx);
  return (
    <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
      <Card>
        <CardHeader title="Kurallar ve tercihler" description="AI tüm satış işlemlerinde bu kuralları uygular. Kritik kurallar yalnızca sizin onayınızla değişir." />
        {memories.length === 0 ? (
          <EmptyState icon={<Brain className="size-8" />} title="Henüz kural yok" />
        ) : (
          <ul className="divide-y divide-border">
            {memories.map((m) => (
              <li key={m.id} className="flex items-start gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Badge tone={m.type === "RULE" ? "accent" : "neutral"}>{MEMORY_TYPE_LABELS[m.type]}</Badge>
                    {m.status === "ARCHIVED" && <Badge>Arşivde</Badge>}
                    <span className="text-xs text-text-3">{FACT_SOURCE_LABELS[m.source]} · {formatDate(m.createdAt)}</span>
                  </div>
                  <p className={m.status === "ARCHIVED" ? "text-sm text-text-3 line-through" : "text-sm text-text"}>{m.content}</p>
                </div>
                <form action={setMemoryStatusAction}>
                  <input type="hidden" name="id" value={m.id} />
                  <input type="hidden" name="status" value={m.status === "ACTIVE" ? "ARCHIVED" : "ACTIVE"} />
                  <Button type="submit" size="sm" variant="ghost">{m.status === "ACTIVE" ? "Arşivle" : "Etkinleştir"}</Button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader title="Yeni kural" />
        <CardBody className="py-5"><MemoryForm /></CardBody>
      </Card>
    </div>
  );
}
