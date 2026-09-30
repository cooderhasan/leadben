import { redirect } from "next/navigation";
import { Sparkles } from "lucide-react";
import { getCurrentUser } from "@/server/auth/session";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  if (await getCurrentUser()) redirect("/dashboard");
  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      <aside className="hidden flex-col justify-between bg-[#15133a] p-10 text-white lg:flex">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="size-5 text-[#a5a0ff]" aria-hidden /> AI Sales OS
        </div>
        <div className="max-w-md">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">Siz ürününüzü anlatın.<br />Müşteriyi AI bulsun.</h2>
          <p className="mt-4 text-sm leading-relaxed text-white/70">
            Şirketinizi tanıtın, hedef müşterinizi belirleyin. AI potansiyel müşterileri bulsun, araştırıp önceliklendirsin
            ve satış sürecinizi sizin onayınızla yönetsin.
          </p>
        </div>
        <p className="text-xs text-white/50">Bir spam motoru değil — insan onaylı AI satış departmanı.</p>
      </aside>
      <main className="flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}
