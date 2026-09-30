import { Construction } from "lucide-react";
import { Card, PageHeader, Badge } from "./ui";

/**
 * Sonraki fazlarda gelecek bölümler için dürüst yer tutucu.
 * Sahte sayı/örnek veri göstermez; bölümün ne yapacağını ve hangi fazda geleceğini anlatır.
 */
export function ComingSoon({ title, phase, description, bullets }: { title: string; phase: number; description: string; bullets: string[] }) {
  return (
    <>
      <PageHeader title={title} description={description} actions={<Badge tone="accent">Faz {phase}</Badge>} />
      <Card className="p-6 sm:p-8">
        <div className="flex items-start gap-4">
          <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text">
            <Construction className="size-5" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text">Bu bölüm Faz {phase}&apos;te geliştirilecek</p>
            <p className="mt-1 text-sm text-text-2">
              Veritabanı modeli hazır. Şirket profilinizi ve ürünlerinizi şimdiden tamamlarsanız bu bölüm açıldığında AI sizi doğrudan tanıyarak başlar.
            </p>
            <ul className="mt-4 grid gap-2 text-sm text-text-2 sm:grid-cols-2">
              {bullets.map((b) => (
                <li key={b} className="flex gap-2">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                  {b}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Card>
    </>
  );
}
