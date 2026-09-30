import type { Metadata } from "next";
import { Building2 } from "lucide-react";
import { requireUserPage, resolveTenant } from "@/server/tenancy/context";
import { logoutAction } from "@/app/actions/auth";
import { redirect } from "next/navigation";
import { Button, Card, CardBody } from "@/components/ui";

export const metadata: Metadata = { title: "Şirket yok" };

/** Oturum açık ama hiçbir şirkete üye olmayan kullanıcı (ör. ekipten çıkarılmış). */
export default async function NoCompanyPage() {
  const user = await requireUserPage();
  if (await resolveTenant()) redirect("/dashboard");
  if (user.isPlatformAdmin) redirect("/admin");

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md">
        <CardBody className="flex flex-col items-center gap-4 py-8 text-center">
          <Building2 className="size-10 text-text-3" aria-hidden />
          <h1 className="text-lg font-semibold text-text">Bir şirkete üye değilsiniz</h1>
          <p className="text-sm text-text-2">
            <strong>{user.email}</strong> hesabı şu anda hiçbir şirkete bağlı değil. Şirket yöneticinizden sizi ekibe
            eklemesini isteyin, ardından tekrar giriş yapın.
          </p>
          <form action={logoutAction}>
            <Button type="submit" variant="secondary">Çıkış yap</Button>
          </form>
        </CardBody>
      </Card>
    </main>
  );
}
