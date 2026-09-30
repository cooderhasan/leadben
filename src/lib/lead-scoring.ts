/**
 * Lead puanlama kuralları (spec §40, UI planı: /30 /20 /15 /20 /15).
 * AI alt skor önerir; toplam ve üst sınırlar burada, deterministik olarak uygulanır.
 * Böylece AI veriye dayanmayan yüksek puan veremez.
 */
export const SCORE_MAX = {
  productFit: 30,
  industryFit: 20,
  sizeFit: 15,
  buyingSignal: 20,
  reachability: 15,
} as const;

export type ScoreKey = keyof typeof SCORE_MAX;

export const SCORE_LABELS: Record<ScoreKey, string> = {
  productFit: "Ürün uyumu",
  industryFit: "Sektör uyumu",
  sizeFit: "Ölçek uyumu",
  buyingSignal: "Satın alma sinyali",
  reachability: "Ulaşılabilirlik",
};

/** Kanıt yokken verilebilecek en yüksek puanlar (varsayıma dayalı puan sınırı). */
export const UNVERIFIED_CAPS = {
  /** Doğrulanmış sinyal yoksa */
  buyingSignal: 4,
  /** Çalışan sayısı / ölçek bilgisi yoksa */
  sizeFit: 7,
  /** Firmanın ne yaptığına dair hiç araştırma yoksa (yalnızca dizin kategorisi) */
  productFit: 15,
} as const;

export interface ReachabilityInput {
  website?: string | null;
  phone?: string | null;
  genericEmail?: string | null;
  contactCount?: number;
  linkedin?: string | null;
  instagram?: string | null;
}

/** Ulaşılabilirlik tamamen veriden hesaplanır — AI'a sorulmaz. */
export function computeReachability(i: ReachabilityInput, mode: "default" | "phone_first" = "default"): number {
  let s = 0;
  if (mode === "phone_first") {
    // Sitesi olmayan esnafa telefon / WhatsApp ile ulaşılır; web sitesi burada ulaşılabilirlik sayılmaz
    if (i.phone) s += 8;
    if (i.genericEmail) s += 3;
    if (i.instagram || i.linkedin) s += 2;
    if ((i.contactCount ?? 0) > 0) s += 2;
    return Math.min(s, SCORE_MAX.reachability);
  }
  if (i.genericEmail) s += 5;
  if (i.phone) s += 4;
  if (i.website) s += 3;
  if ((i.contactCount ?? 0) > 0) s += 2;
  if (i.linkedin || i.instagram) s += 1;
  return Math.min(s, SCORE_MAX.reachability);
}

export interface ScoreEvidence {
  verifiedSignalCount: number;
  hasSizeData: boolean;
  /** Lead web sitesi araştırıldı mı (enrichment var mı) */
  researched: boolean;
  reachability: number;
  /**
   * E-ticaret fırsatı modu: sitede ölçülerek bulunan durum (AI tahmini değil).
   * Verilirse satın alma sinyali buna göre belirlenir; verilmezse (mod kapalı) etkisi yok.
   */
  ecommerceStatus?: EcommerceStatusKey | null;
}

export type EcommerceStatusKey =
  | "NO_WEBSITE"
  | "SOCIAL_ONLY"
  | "SITE_DOWN"
  | "INFO_SITE"
  | "MARKETPLACE_ONLY"
  | "OUTDATED_ECOMMERCE"
  | "HAS_ECOMMERCE";

/**
 * Doğrulanmış e-ticaret durumuna göre satın alma sinyali tabanı (/20). En sıcak: pazaryerinde satıp kendi mağazası
 * olmayan (entegrasyon ihtiyacı belli). Modern e-ticareti olan firma için üst sınır.
 */
export const ECOMMERCE_SIGNAL_FLOOR: Record<Exclude<EcommerceStatusKey, "HAS_ECOMMERCE">, number> = {
  MARKETPLACE_ONLY: 20,
  SOCIAL_ONLY: 17,
  NO_WEBSITE: 16,
  OUTDATED_ECOMMERCE: 15,
  SITE_DOWN: 15,
  INFO_SITE: 14,
};
export const HAS_ECOMMERCE_SIGNAL_CAP = 2;

export interface AiSubScores {
  productFit: number;
  industryFit: number;
  sizeFit: number;
  buyingSignal: number;
}

export interface FinalScore extends AiSubScores {
  reachability: number;
  total: number;
  /** Kanıt eksikliği nedeniyle düşürülen alt skorlar (kullanıcıya gösterilir) */
  capped: ScoreKey[];
}

const clamp = (n: number, max: number) => Math.max(0, Math.min(max, Math.round(Number.isFinite(n) ? n : 0)));

export function finalizeScore(ai: AiSubScores, ev: ScoreEvidence): FinalScore {
  const capped: ScoreKey[] = [];
  const cap = (key: keyof AiSubScores, value: number, limit: number | null) => {
    const v = clamp(value, SCORE_MAX[key]);
    if (limit !== null && v > limit) {
      capped.push(key);
      return limit;
    }
    return v;
  };

  const productFit = cap("productFit", ai.productFit, ev.researched ? null : UNVERIFIED_CAPS.productFit);
  const industryFit = cap("industryFit", ai.industryFit, null);
  const sizeFit = cap("sizeFit", ai.sizeFit, ev.hasSizeData ? null : UNVERIFIED_CAPS.sizeFit);
  let buyingSignal: number;
  if (ev.ecommerceStatus === "HAS_ECOMMERCE") {
    buyingSignal = cap("buyingSignal", ai.buyingSignal, HAS_ECOMMERCE_SIGNAL_CAP);
  } else if (ev.ecommerceStatus) {
    // Sitede ölçülmüş durum doğrulanmış sinyaldir: taban uygulanır, AI daha yüksek verebilir
    buyingSignal = Math.max(clamp(ai.buyingSignal, SCORE_MAX.buyingSignal), ECOMMERCE_SIGNAL_FLOOR[ev.ecommerceStatus]);
  } else {
    buyingSignal = cap("buyingSignal", ai.buyingSignal, ev.verifiedSignalCount > 0 ? null : UNVERIFIED_CAPS.buyingSignal);
  }
  const reachability = clamp(ev.reachability, SCORE_MAX.reachability);

  return {
    productFit,
    industryFit,
    sizeFit,
    buyingSignal,
    reachability,
    total: productFit + industryFit + sizeFit + buyingSignal + reachability,
    capped,
  };
}

export function scoreTone(total: number | null | undefined): "success" | "warning" | "neutral" | "danger" {
  if (total === null || total === undefined) return "neutral";
  if (total >= 70) return "success";
  if (total >= 45) return "warning";
  return "danger";
}
