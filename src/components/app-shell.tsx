"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import {
  BookOpen,
  Building2,
  Factory,
  FileBarChart,
  FileText,
  KanbanSquare,
  LayoutDashboard,
  LineChart,
  ListChecks,
  Mail,
  Megaphone,
  Menu,
  Package,
  PhoneCall,
  Radar,
  Settings,
  Sparkles,
  Swords,
  X,
  type LucideIcon,
} from "lucide-react";
import { NAV_SECTIONS, type NavIcon } from "./nav";
import { cn } from "@/lib/cn";

const ICONS: Record<NavIcon, LucideIcon> = {
  FileText,
  LayoutDashboard,
  PhoneCall,
  Sparkles,
  Building2,
  Megaphone,
  KanbanSquare,
  ListChecks,
  Mail,
  Factory,
  Package,
  BookOpen,
  Swords,
  Radar,
  LineChart,
  FileBarChart,
  Settings,
};

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-5" aria-label="Ana menü">
      {NAV_SECTIONS.map((section, i) => (
        <div key={section.title ?? i} className="flex flex-col gap-0.5">
          {section.title && <p className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-text-3">{section.title}</p>}
          {section.items.map((item) => {
            const Icon = ICONS[item.icon];
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "group relative flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-sm transition-colors",
                  active ? "bg-accent-soft font-medium text-accent-text" : "text-text-2 hover:bg-surface-2 hover:text-text",
                )}
              >
                {active && <span className="absolute inset-y-1.5 -left-3 w-[3px] rounded-r-full bg-accent" aria-hidden />}
                <Icon className={cn("size-4 shrink-0", active ? "text-accent" : "text-text-3 group-hover:text-text-2")} aria-hidden />
                <span className="flex-1 truncate">{item.label}</span>
                {item.phase > 1 && (
                  <span className="rounded bg-surface-2 px-1.5 py-px text-[10px] font-medium text-text-3 group-hover:bg-surface">Faz {item.phase}</span>
                )}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function Brand() {
  return (
    <Link href="/dashboard" className="flex items-center gap-2.5 px-2.5">
      <span className="grid size-8 place-items-center rounded-lg bg-linear-to-br from-accent to-accent-2 text-white shadow-sm shadow-accent/30">
        <Sparkles className="size-4" aria-hidden />
      </span>
      <span className="leading-tight">
        <span className="block text-sm font-semibold tracking-tight text-text">AI Sales OS</span>
        <span className="block text-[11px] text-text-3">Satış operasyonu</span>
      </span>
    </Link>
  );
}

export function AppShell({ topbar, footer, children }: { topbar: ReactNode; footer: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);

  return (
    <div className="flex min-h-dvh">
      {/* Masaüstü kenar çubuğu */}
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col gap-5 border-r border-border bg-surface/70 px-3 py-4 backdrop-blur lg:flex">
        <Brand />
        <div className="-mx-3 flex-1 overflow-y-auto px-3">
          <NavList />
        </div>
        {footer}
      </aside>

      {/* Mobil çekmece */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menü">
          <button className="absolute inset-0 bg-black/50 backdrop-blur-sm" aria-label="Menüyü kapat" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col gap-5 border-r border-border bg-surface px-3 py-4 shadow-pop">
            <div className="flex items-center justify-between">
              <Brand />
              <button onClick={() => setOpen(false)} className="rounded-lg p-2 text-text-2 hover:bg-surface-2" aria-label="Kapat">
                <X className="size-5" />
              </button>
            </div>
            <div className="-mx-3 flex-1 overflow-y-auto px-3">
              <NavList onNavigate={() => setOpen(false)} />
            </div>
            {footer}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-bg/80 px-4 backdrop-blur-md sm:px-6">
          <button onClick={() => setOpen(true)} className="-ml-1 rounded-lg p-2 text-text-2 hover:bg-surface-2 lg:hidden" aria-label="Menüyü aç">
            <Menu className="size-5" />
          </button>
          {topbar}
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </div>
    </div>
  );
}
