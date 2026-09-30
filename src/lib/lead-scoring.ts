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
export function computeReachability(i: ReachabilityInput): number {
  let s = 0;
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
}

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
  const buyingSignal = cap("buyingSignal", ai.buyingSignal, ev.verifiedSignalCount > 0 ? null : UNVERIFIED_CAPS.buyingSignal);
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
