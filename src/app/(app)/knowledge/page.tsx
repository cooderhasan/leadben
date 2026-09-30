import type { Metadata } from "next";
import { BookOpen, FileText, Search, Trash2 } from "lucide-react";
import { requireTenantPage } from "@/server/tenancy/context";
import { DOCUMENT_KIND_LABELS, listDocuments, search } from "@/server/services/knowledge";
import { deleteDocumentAction, setDocumentVerifiedAction } from "@/app/actions/knowledge";
import { JobPoller } from "@/components/job-poller";
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, Input, PageHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/cn";
import { UploadForm } from "./upload-form";

export const metadata: Metadata = { title: "Bilgi Bankası" };

const STATUS: Record<string, { label: string; tone: "neutral" | "accent" | "success" | "danger" }> = {
  UPLOADED: { label: "Sırada", tone: "neutral" },
  PROCESSING: { label: "İşleniyor", tone: "accent" },
  READY: { label: "Hazır", tone: "success" },
  FAILED: { label: "Başarısız", tone: "danger" },
};

const fmtSize = (b: number | null) => (b == null ? "" : b > 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.ceil(b / 1024)} KB`);

export default async function KnowledgePage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const ctx = await requireTenantPage();
  const { q } = await searchParams;
  const [docs, hits] = await Promise.all([listDocuments(ctx), q ? search(ctx, q) : Promise.resolve(null)]);
  const processing = docs.filter((d) => (d.status === "UPLOADED" || d.status === "PROCESSING") && d.jobId);

  return (
    <>
      <PageHeader
        title="Bilgi bankası"
        description="Katalog, ürün listesi ve teknik dokümanlarınız. AI yalnızca kendi şirketinizin bilgi bankasını kullanır."
      />

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <Card>
          <CardHeader title="Doküman yükle" description="AI ürünleri, teknik özellikleri, sertifikaları ve MOQ bilgisini çıkarıp onayınıza sunar." />
          <CardBody className="py-5">
            <UploadForm kinds={Object.entries(DOCUMENT_KIND_LABELS)} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Bilgi bankasında ara" description="AI'ın satış sırasında bulacağı bilgiyi test edin." />
          <CardBody className="py-5">
            <form className="flex gap-2" role="search">
              <Input name="q" defaultValue={q} placeholder="ör. paslanmaz basma yay tel çapı" aria-label="Arama" />
              <Button type="submit" variant="secondary" aria-label="Ara"><Search className="size-4" /></Button>
            </form>
            {hits && (
              <div className="mt-4 flex flex-col gap-3">
                {hits.length === 0 ? (
                  <p className="text-sm text-text-2">Sonuç yok.</p>
                ) : (
                  hits.map((h) => (
                    <div key={h.chunkId} className="rounded-lg border border-border p-3">
                      <div className="mb-1 flex items-center gap-2">
                        <span className="truncate text-xs font-medium text-text-2">{h.documentTitle}</span>
                        {!h.verified && <Badge tone="warning">Satış için onaylanmadı</Badge>}
                      </div>
                      <p className="line-clamp-4 text-sm text-text">{h.content}</p>
                    </div>
                  ))
                )}
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      {processing.map((d) => (
        <div key={d.id} className="mt-6">
          <JobPoller
            jobId={d.jobId!}
            label={`"${d.title}" işleniyor…`}
            steps={[[0, "Metin çıkarılıyor"], [20, "Parçalara ayrılıyor"], [40, "İndeksleniyor"], [60, "Ürünler ve bilgiler çıkarılıyor"]]}
          />
        </div>
      ))}

      <Card className="mt-6">
        <CardHeader title="Dokümanlar" description="“Satışta kullan” onayı verdiğiniz dokümanlar AI mesajlarında kaynak olarak kullanılabilir." />
        {docs.length === 0 ? (
          <EmptyState icon={<BookOpen className="size-8" />} title="Henüz doküman yok" description="Ürün kataloğunuzla başlayın." />
        ) : (
          <ul className="divide-y divide-border">
            {docs.map((d) => (
              <li key={d.id} className="flex flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <FileText className="mt-0.5 size-5 shrink-0 text-text-3" aria-hidden />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text">{d.title}</p>
                    <p className="text-xs text-text-3">
                      {DOCUMENT_KIND_LABELS[d.kind]} · {fmtSize(d.sizeBytes)}
                      {d.pageCount ? ` · ${d.pageCount} sayfa` : ""} · {d._count.chunks} parça · {d._count.products} ürün · {formatDateTime(d.createdAt)}
                    </p>
                    {d.status === "FAILED" && d.error && <p className="mt-1 text-xs text-danger">{d.error}</p>}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={STATUS[d.status]!.tone}>{STATUS[d.status]!.label}</Badge>
                  {d.status === "READY" && (
                    <form action={setDocumentVerifiedAction}>
                      <input type="hidden" name="id" value={d.id} />
                      <input type="hidden" name="verified" value={String(!d.verified)} />
                      <Button type="submit" size="sm" variant={d.verified ? "secondary" : "primary"}>
                        {d.verified ? "Satışta kullanılıyor ✓" : "Satışta kullan"}
                      </Button>
                    </form>
                  )}
                  <form action={deleteDocumentAction}>
                    <input type="hidden" name="id" value={d.id} />
                    <Button type="submit" size="sm" variant="ghost" aria-label={`${d.title} sil`}>
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Alert className="mt-6">
        Dokümandan çıkarılan ürünler <strong>Ürünler</strong> sayfasında, şirket bilgileri (sertifika, MOQ, teslim süresi) <strong>Şirketim</strong> sayfasında onayınızı bekler.
      </Alert>
    </>
  );
}
