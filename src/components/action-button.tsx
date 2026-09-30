"use client";

import type { ReactNode } from "react";
import type { ActionState } from "@/lib/action-state";
import { ActionForm, FormMessage, SubmitButton } from "./forms";

/**
 * Tek düğmeli server action formu: gizli alanlar + düğme + sonuç mesajı.
 * Kredi harcayan / onay veren işlemlerde hatayı (ör. yetersiz kredi) kullanıcıya gösterir.
 */
export function ActionButton({
  action,
  fields,
  children,
  pendingText = "İşleniyor…",
  variant = "primary",
  size = "sm",
  confirm,
}: {
  action: (state: ActionState, fd: FormData) => Promise<ActionState>;
  fields: Record<string, string | string[]>;
  children: ReactNode;
  pendingText?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  /** Tıklamadan önce onay penceresi metni */
  confirm?: string;
}) {
  return (
    <ActionForm action={action} className="gap-2">
      {(state) => (
        <>
          {Object.entries(fields).flatMap(([k, v]) =>
            (Array.isArray(v) ? v : [v]).map((val, i) => <input key={`${k}-${i}`} type="hidden" name={k} value={val} />),
          )}
          <span
            className="contents"
            onClickCapture={(e) => {
              if (confirm && (e.target as HTMLElement).closest("button") && !window.confirm(confirm)) {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
          >
            <SubmitButton variant={variant} size={size} pendingText={pendingText} className="self-start">
              {children}
            </SubmitButton>
          </span>
          <FormMessage state={state} />
        </>
      )}
    </ActionForm>
  );
}
