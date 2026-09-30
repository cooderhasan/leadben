import type { Metadata } from "next";
import Link from "next/link";
import { Check, ListChecks, Sparkles } from "lucide-react";
import { requireTenantPage } from "@/server/tenancy/context";
import { can } from "@/server/tenancy/permissions";
import { listTasks, PRIORITY_LABELS } from "@/server/services/crm";
import { listLeads } from "@/server/services/leads";
import { setTaskStatusAction } from "@/app/actions/crm";
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { TaskCreateForm } from "../pipeline/crm-forms";

export const metadata: Metadata = { title: "Görevler" };

const fmt = (d: Date) => new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium" }).format(d);
const PRIORITY_TONE = { LOW: "neutral", MEDIUM: "neutral", HIGH: "warning", URGENT: "danger" } as const;

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ done?: string }> }) {
  const ctx = await requireTenantPage();
  const { done } = await searchParams;
  const showDone = done === "1";
  const canWrite = can(ctx, "lead.write");
  const [tasks, leads] = await Promise.all([
    listTasks(ctx, { status: showDone ? "DONE" : "OPEN" }),
    canWrite ? listLeads(ctx, { take: 200 }) : Promise.resolve({ rows: [], total: 0 }),
  ]);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today.getTime() + 86_400_000);
  const groups = showDone
    ? [{ title: "Tamamlanan", items: tasks }]
    : [
        { title: "Gecikmiş", items: tasks.filter((t) => t.dueAt && t.dueAt < today) },
        { title: "Bugün", items: tasks.filter((t) => t.dueAt && t.dueAt >= today && t.dueAt < tomorrow) },
        { title: "Yaklaşan", items: tasks.filter((t) => t.dueAt && t.dueAt >= tomorrow) },
        { title: "Tarihsiz", items: tasks.filter((t) => !t.dueAt) },
      ];

  return (
    <>
      <PageHeader
        title="Görevler"
        description="Yanıtlardan AI'ın açtığı görevler ve sizin eklediğiniz işler."
        actions={
          <Link href={showDone ? "/tasks" : "/tasks?done=1"} className="text-sm text-accent">
            {showDone ? "Açık görevler" : "Tamamlananlar"}
          </Link>
        }
      />
      {canWrite && !showDone && (
        <Card className="mb-6">
          <CardHeader title="Yeni görev" />
          <CardBody>
            <TaskCreateForm leads={leads.rows.map((l) => ({ id: l.id, name: l.companyName }))} />
          </CardBody>
        </Card>
      )}

      {tasks.length === 0 ? (
        <Card>
          <EmptyState icon={<ListChecks className="size-8" />} title={showDone ? "Tamamlanan görev yok" : "Açık görev yok"} description="Olumlu yanıt geldiğinde AI burada görev açar." />
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          {groups
            .filter((g) => g.items.length > 0)
            .map((g) => (
              <Card key={g.title}>
                <CardHeader title={`${g.title} (${g.items.length})`} />
                <ul className="divide-y divide-border">
                  {g.items.map((t) => (
                    <li key={t.id} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
                          {t.title}
                          {t.createdByAI && <Sparkles className="size-3.5 text-accent" aria-label="AI oluşturdu" />}
                        </p>
                        <p className="text-xs text-text-3">
                          {t.lead && <Link href={`/leads/${t.lead.id}`} className="hover:text-accent">{t.lead.companyName}</Link>}
                          {t.lead && t.dueAt && " · "}
                          {t.dueAt && fmt(t.dueAt)}
                        </p>
                        {t.description && <p className="mt-1 line-clamp-2 text-xs text-text-2">{t.description}</p>}
                      </div>
                      <Badge tone={PRIORITY_TONE[t.priority]}>{PRIORITY_LABELS[t.priority]}</Badge>
                      {canWrite && !showDone && (
                        <form action={setTaskStatusAction}>
                          <input type="hidden" name="id" value={t.id} />
                          <input type="hidden" name="status" value="DONE" />
                          <Button type="submit" size="sm" variant="secondary"><Check className="size-4" aria-hidden /> Tamamla</Button>
                        </form>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
        </div>
      )}
    </>
  );
}
