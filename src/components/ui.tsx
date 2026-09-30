import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

// ── Buton ─────────────────────────────────────────────────────────────
type Variant = "primary" | "secondary" | "ghost" | "danger";
const variants: Record<Variant, string> = {
  primary:
    "bg-accent text-white shadow-sm shadow-accent/25 hover:bg-accent-hover bg-linear-to-b from-white/10 to-transparent",
  secondary: "bg-surface text-text border border-border shadow-card hover:bg-surface-2 hover:border-border-strong",
  ghost: "text-text-2 hover:bg-surface-2 hover:text-text",
  danger: "bg-surface text-danger border border-border shadow-card hover:bg-danger-soft hover:border-danger/30",
};
const sizes = { sm: "h-8 px-3 text-[13px]", md: "h-10 px-4 text-sm", lg: "h-11 px-5 text-base" };

export function buttonClass(variant: Variant = "primary", size: keyof typeof sizes = "md", extra?: string) {
  return cn(
    "inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-[background-color,border-color,color,box-shadow,transform] duration-150 active:translate-y-px disabled:pointer-events-none disabled:opacity-50",
    variants[variant],
    sizes[size],
    extra,
  );
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ComponentProps<"button"> & { variant?: Variant; size?: keyof typeof sizes }) {
  return <button className={buttonClass(variant, size, className)} {...props} />;
}

export function LinkButton({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ComponentProps<typeof Link> & { variant?: Variant; size?: keyof typeof sizes }) {
  return <Link className={buttonClass(variant, size, className)} {...props} />;
}

// ── Kart ──────────────────────────────────────────────────────────────
export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("rounded-xl border border-border bg-surface shadow-card", className)} {...props} />;
}

export function CardHeader({ title, description, action, icon }: { title: ReactNode; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
      <div className="flex min-w-0 items-start gap-3">
        {icon && <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text [&>svg]:size-4">{icon}</span>}
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight text-text">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-text-2">{description}</p>}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function CardBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("px-5 py-4", className)} {...props} />;
}

// ── Sayfa başlığı ─────────────────────────────────────────────────────
export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-text sm:text-[28px] sm:leading-9">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-text-2">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

// ── Rozet ─────────────────────────────────────────────────────────────
type Tone = "neutral" | "accent" | "success" | "warning" | "danger";
const tones: Record<Tone, string> = {
  neutral: "bg-surface-2 text-text-2 ring-border",
  accent: "bg-accent-soft text-accent-text ring-accent/20",
  success: "bg-success-soft text-success ring-success/20",
  warning: "bg-warning-soft text-warning ring-warning/20",
  danger: "bg-danger-soft text-danger ring-danger/20",
};
export function Badge({ tone = "neutral", className, ...props }: ComponentProps<"span"> & { tone?: Tone }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset", tones[tone], className)}
      {...props}
    />
  );
}

// ── Form alanları ─────────────────────────────────────────────────────
const fieldBase =
  "w-full rounded-lg border border-border bg-surface px-3 text-sm text-text shadow-card transition-colors placeholder:text-text-3 hover:border-border-strong focus:border-accent focus:outline-none focus:ring-3 focus:ring-[var(--ring)] disabled:opacity-60";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(fieldBase, "h-10", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn(fieldBase, "min-h-24 py-2 leading-relaxed", className)} {...props} />;
}

/** Yerel ok yerine temaya uyan ok (her iki temada okunur nötr gri) */
const selectArrow =
  "appearance-none bg-no-repeat bg-[length:16px_16px] bg-[position:right_0.6rem_center] bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='%23868c98'%3E%3Cpath fill-rule='evenodd' d='M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z' clip-rule='evenodd'/%3E%3C/svg%3E\")]";

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn(fieldBase, selectArrow, "h-10 pr-9", className)} {...props} />;
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-text">
        {label}
      </label>
      {children}
      {error ? <p className="text-xs text-danger">{error}</p> : hint ? <p className="text-xs leading-relaxed text-text-3">{hint}</p> : null}
    </div>
  );
}

// ── Boş durum ─────────────────────────────────────────────────────────
export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && (
        <div className="mb-4 grid size-14 place-items-center rounded-2xl bg-surface-2 text-text-3 ring-1 ring-border [&>svg]:size-6">{icon}</div>
      )}
      <p className="text-[15px] font-semibold text-text">{title}</p>
      {description && <p className="mt-1.5 max-w-md text-sm leading-relaxed text-text-2">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

// ── Stat ──────────────────────────────────────────────────────────────
export function Stat({ label, value, sub, icon }: { label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1.5 truncate text-xs font-medium text-text-2">
        {icon && <span className="text-text-3 [&>svg]:size-3.5">{icon}</span>}
        {label}
      </p>
      <p className="mt-1.5 text-2xl font-semibold tracking-tight text-text tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-text-3">{sub}</p>}
    </div>
  );
}

/** Tek istatistik kartı (sayfa üstündeki özet satırları için) */
export function StatCard({ label, value, sub, icon, tone = "neutral" }: { label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode; tone?: Tone }) {
  return (
    <Card className="flex items-start justify-between gap-3 p-4">
      <Stat label={label} value={value} sub={sub} />
      {icon && <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg ring-1 ring-inset [&>svg]:size-4", tones[tone])}>{icon}</span>}
    </Card>
  );
}

export function Alert({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <div className={cn("rounded-lg px-4 py-3 text-sm leading-relaxed ring-1 ring-inset", tones[tone], className)}>{children}</div>;
}
