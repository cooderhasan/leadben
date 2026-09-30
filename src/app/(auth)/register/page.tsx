import type { Metadata } from "next";
import Link from "next/link";
import { env } from "@/server/env";
import { Alert } from "@/components/ui";
import { RegisterForm } from "../auth-forms";

export const metadata: Metadata = { title: "Kayıt" };
export const dynamic = "force-dynamic";

export default function RegisterPage() {
  if (!env().ALLOW_SIGNUP) {
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">Kayıtlar şu an kapalı</h1>
        <Alert className="mt-4">Bu sunucu davetle kullanılıyor. Hesabınız varsa giriş yapın.</Alert>
        <Link href="/login" className="mt-4 inline-block text-sm font-medium text-accent hover:underline">Giriş sayfasına dön</Link>
      </>
    );
  }
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">AI satış departmanınızı kurun</h1>
      <p className="mb-6 mt-1 text-sm text-text-2">Birkaç dakikada şirketinizi tanıtın, gerisini AI ile birlikte yapalım.</p>
      <RegisterForm />
    </>
  );
}
