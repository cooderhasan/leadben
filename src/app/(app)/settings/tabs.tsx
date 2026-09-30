"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

const TABS = [
  { href: "/settings", label: "Genel" },
  { href: "/settings/team", label: "Ekip" },
  { href: "/settings/memory", label: "Şirket hafızası" },
  { href: "/settings/email", label: "E-posta ve uyum" },
  { href: "/settings/whatsapp", label: "WhatsApp" },
  { href: "/settings/api", label: "API ve webhook" },
  { href: "/settings/usage", label: "Kullanım ve kredi" },
  { href: "/settings/integrations", label: "Entegrasyonlar" },
];

export function SettingsTabs() {
  const pathname = usePathname();
  return (
    <nav className="-mx-4 overflow-x-auto border-b border-border px-4 sm:mx-0 sm:px-0" aria-label="Ayar sekmeleri">
      <ul className="flex gap-1">
        {TABS.map((t) => {
          const active = pathname === t.href;
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "block whitespace-nowrap border-b-2 px-3 py-2.5 text-sm",
                  active ? "border-accent font-medium text-text" : "border-transparent text-text-2 hover:text-text",
                )}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
