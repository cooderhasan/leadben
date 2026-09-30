export type NavIcon =
  | "LayoutDashboard" | "Sparkles" | "Building2" | "PhoneCall" | "Megaphone" | "Mail" | "KanbanSquare" | "FileText"
  | "ListChecks" | "Factory" | "Package" | "BookOpen" | "Swords" | "Radar" | "LineChart" | "FileBarChart" | "Settings";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  phase: number;
}

/** Sol menü (spec §90), bölümlere ayrılmış. `phase` > 1 olan bölümler henüz geliştirilmedi ve "Faz N" etiketiyle gösterilir. */
export const NAV_SECTIONS: Array<{ title: string | null; items: NavItem[] }> = [
  {
    title: null,
    items: [
      { href: "/dashboard", label: "Genel bakış", icon: "LayoutDashboard", phase: 1 },
      { href: "/assistant", label: "AI Asistan", icon: "Sparkles", phase: 1 },
    ],
  },
  {
    title: "Satış",
    items: [
      { href: "/leads", label: "Potansiyel müşteriler", icon: "Building2", phase: 1 },
      { href: "/calls", label: "Arama listesi", icon: "PhoneCall", phase: 1 },
      { href: "/campaigns", label: "Kampanyalar", icon: "Megaphone", phase: 1 },
      { href: "/messages", label: "Mesajlar", icon: "Mail", phase: 1 },
      { href: "/pipeline", label: "Satış hunisi", icon: "KanbanSquare", phase: 1 },
      { href: "/proposals", label: "Teklifler", icon: "FileText", phase: 1 },
      { href: "/tasks", label: "Görevler", icon: "ListChecks", phase: 1 },
    ],
  },
  {
    title: "Şirketim",
    items: [
      { href: "/company", label: "Şirket profili", icon: "Factory", phase: 1 },
      { href: "/products", label: "Ürünler", icon: "Package", phase: 1 },
      { href: "/knowledge", label: "Bilgi bankası", icon: "BookOpen", phase: 1 },
      { href: "/competitors", label: "Rakipler", icon: "Swords", phase: 1 },
      { href: "/signals", label: "Satış sinyalleri", icon: "Radar", phase: 1 },
    ],
  },
  {
    title: "Raporlar",
    items: [
      { href: "/analytics", label: "Analitik", icon: "LineChart", phase: 1 },
      { href: "/reports", label: "AI raporları", icon: "FileBarChart", phase: 1 },
      { href: "/settings", label: "Ayarlar", icon: "Settings", phase: 1 },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);
