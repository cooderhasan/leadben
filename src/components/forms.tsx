"use client";

import { useActionState, useEffect, useRef, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import type { ActionState } from "@/lib/action-state";
import { Alert, Button } from "./ui";
import { cn } from "@/lib/cn";

export function SubmitButton({
  children,
  pendingText,
  variant = "primary",
  size = "md",
  className,
  name,
  value,
}: {
  children: ReactNode;
  pendingText?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  className?: string;
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size={size} disabled={pending} className={className} name={name} value={value}>
      {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {pending && pendingText ? pendingText : children}
    </Button>
  );
}

export function FormMessage({ state }: { state: ActionState }) {
  if (state.error) return <Alert tone="danger">{state.error}</Alert>;
  if (state.ok && state.message) return <Alert tone="success">{state.message}</Alert>;
  return null;
}

/**
 * Server action formu: hata/başarı mesajı, alan hataları (render prop ile), başarıda sıfırlama.
 */
export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess = false,
  onSuccess,
}: {
  action: (state: ActionState, fd: FormData) => Promise<ActionState>;
  children: (state: ActionState) => ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  onSuccess?: () => void;
}) {
  const [state, formAction] = useActionState(action, {});
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) {
      if (resetOnSuccess) ref.current?.reset();
      onSuccess?.();
    }
  }, [state, resetOnSuccess, onSuccess]);
  return (
    <form ref={ref} action={formAction} className={cn("flex flex-col gap-4", className)}>
      {children(state)}
    </form>
  );
}
