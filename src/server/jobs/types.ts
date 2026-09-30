import type { LeadSearchQuery } from "@/server/providers/lead-source/types";

export interface JobPayloads {
  "website.analyze": { analysisId: string; usageId?: string };
  "document.ingest": { documentId: string; usageId?: string };
  /** Doğal dil lead araması. `runId` ilk denemede yazılır; tekrar denemede yeni (ücretli) çalıştırma başlatılmaz. */
  "lead.search": {
    prompt: string;
    /** Eski işlerde yok → "maps" */
    source?: import("@/server/providers/lead-source/types").LeadSourceKind;
    interpretation: string;
    query: LeadSearchQuery;
    usageId?: string;
    reserved: number;
    runId?: string;
  };
  /** Lead web sitesi araştırması + ardından puanlama (tek işlem, "AI ile Analiz Et") */
  "lead.enrich": { leadId: string; usageId?: string };
  /** Toplu puanlama (araştırma yapmadan, mevcut veriyle) */
  "lead.score": { leadIds: string[]; usageId?: string };
  /** Web sitesinden kurumsal e-posta bulma (AI'sız, kredi düşmez) */
  "lead.find_email": { leadIds: string[] };
  /** Sitede e-ticaret / eski site kontrolü (AI'sız, kredi düşmez) */
  "lead.check_ecommerce": { leadIds: string[] };
  /** Firma adından web sitesi bulma (web araması; bulunamayanın kredisi iade edilir) */
  "lead.find_website": { leadIds: string[]; usageId?: string; runId?: string };
  /** Liste sayfası / yapıştırılmış metinden firma çıkarma (AI + kaynak metinde doğrulama) */
  /** "Hazırla": seçilen lead'ler için e-posta bul → araştır → puanla (sırayla) */
  "lead.prepare": {
    plan: Array<{ leadId: string; email: boolean; research: boolean; score: boolean }>;
    enrichUsageId?: string;
    scoreUsageId?: string;
  };
  "lead.list_import": { url: string | null; text: string | null; usageId?: string; filter?: string[]; render?: boolean };
  /** Kampanya stratejisi (AI) — sonuç PENDING, insan onayı bekler */
  "campaign.strategy": { campaignId: string; usageId?: string };
  /** Kampanya ilk temas mesajları (AI) — her mesaj PENDING_APPROVAL */
  "campaign.generate_messages": { campaignId: string; leadIds: string[]; usageId?: string };
  /** Onaylı mesajların gönderimi (günlük sınır, uyum ve engel kontrolü her mesajda tekrar yapılır) */
  "campaign.send": { campaignId: string };
  /** Gelen yanıtın AI sınıflandırması + otomatik aksiyonlar (görev, fırsat, ret) */
  "conversation.classify": { conversationMessageId: string };
  /** Kampanya dışı tek onaylı ileti (ör. yanıt taslağı) */
  "message.send": { messageId: string };
  /** Şirketin vakti gelmiş hatırlatmaları (zamanlayıcı tetikler) */
  "followup.run": Record<string, never>;
  /** Teklif taslağı (AI) — fiyatlar boş kalır, insan girer */
  "proposal.draft": { proposalId: string; usageId?: string };
  /** Rakip sitesi taraması. usageId yoksa (zamanlayıcı) kredi işte düşülür; yetersizse atlanır. */
  "competitor.scan": { competitorId: string; usageId?: string };
  /** Giden webhook teslimi (HMAC imzalı; başarısızlıkta tekrar denenir) */
  "webhook.deliver": { endpointId: string; eventId: string; event: string; data: unknown };
}

export type JobType = keyof JobPayloads;

export interface JobHelpers {
  jobId: string;
  companyId: string | null;
  createdById: string | null;
  isFinalAttempt: boolean;
  progress(pct: number): Promise<void>;
}

export type JobHandler<T extends JobType> = (payload: JobPayloads[T], helpers: JobHelpers) => Promise<unknown>;

/**
 * Tekrar denenmemesi gereken hata (ör. geçersiz URL, robots.txt yasağı, yetersiz kredi).
 */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}
