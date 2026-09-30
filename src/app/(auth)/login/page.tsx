import type { Metadata } from "next";
import { LoginForm } from "../auth-forms";

export const metadata: Metadata = { title: "Giriş" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Tekrar hoş geldiniz</h1>
      <p className="mb-6 mt-1 text-sm text-text-2">Satış departmanınız sizi bekliyor.</p>
      <LoginForm next={next} />
    </>
  );
}
