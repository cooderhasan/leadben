"use client";

import Link from "next/link";
import { loginAction, registerAction } from "@/app/actions/auth";
import { ActionForm, FormMessage, SubmitButton } from "@/components/forms";
import { Field, Input } from "@/components/ui";

export function LoginForm({ next }: { next?: string }) {
  return (
    <ActionForm action={loginAction}>
      {(state) => (
        <>
          <FormMessage state={state} />
          {next && <input type="hidden" name="next" value={next} />}
          <Field label="E-posta" htmlFor="email" error={state.fieldErrors?.email}>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </Field>
          <Field label="Parola" htmlFor="password" error={state.fieldErrors?.password}>
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </Field>
          <SubmitButton pendingText="Giriş yapılıyor…" className="w-full">Giriş yap</SubmitButton>
          <p className="text-center text-sm text-text-2">
            Hesabınız yok mu?{" "}
            <Link href="/register" className="font-medium text-accent hover:underline">Kayıt olun</Link>
          </p>
        </>
      )}
    </ActionForm>
  );
}

export function RegisterForm() {
  return (
    <ActionForm action={registerAction}>
      {(state) => (
        <>
          <FormMessage state={state} />
          <Field label="Adınız soyadınız" htmlFor="name" error={state.fieldErrors?.name}>
            <Input id="name" name="name" autoComplete="name" required />
          </Field>
          <Field label="Firma adı" htmlFor="companyName" error={state.fieldErrors?.companyName}>
            <Input id="companyName" name="companyName" autoComplete="organization" required />
          </Field>
          <Field label="İş e-postası" htmlFor="email" error={state.fieldErrors?.email}>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </Field>
          <Field label="Parola" htmlFor="password" hint="En az 10 karakter; harf ve rakam içermeli." error={state.fieldErrors?.password}>
            <Input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
          </Field>
          <SubmitButton pendingText="Hesap oluşturuluyor…" className="w-full">Hesap oluştur</SubmitButton>
          <p className="text-center text-sm text-text-2">
            Zaten hesabınız var mı?{" "}
            <Link href="/login" className="font-medium text-accent hover:underline">Giriş yapın</Link>
          </p>
        </>
      )}
    </ActionForm>
  );
}
