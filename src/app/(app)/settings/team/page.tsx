import type { Metadata } from "next";
import { requireTenantPage } from "@/server/tenancy/context";
import { listMembers } from "@/server/services/members";
import { can, roleLabel } from "@/server/tenancy/permissions";
import { removeMemberAction } from "@/app/actions/settings";
import { Badge, Button, Card, CardBody, CardHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/cn";
import { MemberForm } from "../forms";

export const metadata: Metadata = { title: "Ekip" };

export default async function TeamPage() {
  const ctx = await requireTenantPage();
  const members = await listMembers(ctx);
  const canManage = can(ctx, "member.manage");
  return (
    <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
      <Card>
        <CardHeader title="Ekip üyeleri" description={`${members.length} kişi`} />
        <ul className="divide-y divide-border">
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-3 px-5 py-3">
              <div className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent-text">
                {m.user.name.slice(0, 1).toLocaleUpperCase("tr-TR")}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{m.user.name}{m.user.id === ctx.userId && <span className="text-text-3"> (siz)</span>}</p>
                <p className="truncate text-xs text-text-3">{m.user.email}{m.user.lastLoginAt ? ` · son giriş ${formatDateTime(m.user.lastLoginAt)}` : ""}</p>
              </div>
              <Badge tone={m.role === "OWNER" ? "accent" : "neutral"}>{roleLabel(m.role)}</Badge>
              {canManage && m.user.id !== ctx.userId && (
                <form action={removeMemberAction}>
                  <input type="hidden" name="id" value={m.id} />
                  <Button type="submit" size="sm" variant="ghost" className="text-danger">Çıkar</Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      </Card>
      {canManage && (
        <Card>
          <CardHeader title="Üye ekle" />
          <CardBody className="py-5"><MemberForm /></CardBody>
        </Card>
      )}
    </div>
  );
}
