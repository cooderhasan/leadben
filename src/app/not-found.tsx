import { LinkButton } from "@/components/ui";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="text-sm font-medium text-accent">404</p>
      <h1 className="text-2xl font-semibold">Sayfa bulunamadı</h1>
      <LinkButton href="/dashboard" variant="secondary">Dashboard&apos;a dön</LinkButton>
    </main>
  );
}
