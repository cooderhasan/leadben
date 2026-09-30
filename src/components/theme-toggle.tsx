"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/cn";
import { THEME_STORAGE_KEY as STORAGE_KEY, type ThemePref } from "@/lib/theme";

function apply(pref: ThemePref) {
  const dark = pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.themePref = pref;
}

const OPTIONS: Array<{ value: ThemePref; label: string; Icon: typeof Sun }> = [
  { value: "light", label: "Açık tema", Icon: Sun },
  { value: "dark", label: "Koyu tema", Icon: Moon },
  { value: "system", label: "Sistem ayarı", Icon: Monitor },
];

/** Açık / koyu / sistem seçici (üst bar). Tercih yalnızca bu tarayıcıda saklanır. */
export function ThemeToggle({ className }: { className?: string }) {
  const [pref, setPref] = useState<ThemePref>("system");

  useEffect(() => {
    const stored = document.documentElement.dataset.themePref as ThemePref | undefined;
    if (stored === "light" || stored === "dark" || stored === "system") setPref(stored);
  }, []);

  // "Sistem" seçiliyken işletim sistemi teması değişirse anında uy
  useEffect(() => {
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  const choose = (value: ThemePref) => {
    setPref(value);
    apply(value);
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      /* gizli pencere vb. — tercih bu oturumla sınırlı kalır */
    }
  };

  return (
    <div role="radiogroup" aria-label="Tema" className={cn("flex items-center rounded-full border border-border bg-surface p-0.5 shadow-card", className)}>
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={pref === value}
          title={label}
          aria-label={label}
          onClick={() => choose(value)}
          className={cn(
            "grid size-7 place-items-center rounded-full transition-colors",
            pref === value ? "bg-accent-soft text-accent-text" : "text-text-3 hover:text-text",
          )}
        >
          <Icon className="size-3.5" aria-hidden />
        </button>
      ))}
    </div>
  );
}
