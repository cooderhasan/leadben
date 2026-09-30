import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Koşullu sınıflar + çakışan Tailwind sınıflarının birleştirilmesi (sonraki kazanır: "w-full" + "w-44" → "w-44") */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export const formatNumber = (n: number) => new Intl.NumberFormat("tr-TR").format(n);

export const formatMoney = (n: number | null | undefined, currency = "TRY") =>
  n == null ? "—" : new Intl.NumberFormat("tr-TR", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);

export const formatDate = (d: Date | string) =>
  new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short", year: "numeric" }).format(new Date(d));

export const formatDateTime = (d: Date | string) =>
  new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(d));
