import type { Metadata } from "next";
import { requireTenantPage } from "@/server/tenancy/context";
import { isAIConfigured } from "@/server/ai";
import { Alert, Card, CardBody, PageHeader } from "@/components/ui";
import { AssistantChat } from "./chat";

export const metadata: Metadata = { title: "AI Asistan" };

export default async function AssistantPage() {
  await requireTenantPage();
  const enabled = isAIConfigured();
  return (
    <>
      <PageHeader
        title="AI Asistan"
        description="Lead, kampanya, yanıt, fırsat ve görev verilerinize dayanarak cevap verir. Verinizde olmayan bir şeyi uydurmaz; bilmiyorsa söyler."
      />
      {!enabled && <Alert tone="neutral" className="mb-6">AI yapılandırılmadığı için asistan kapalı.</Alert>}
      <Card className="max-w-3xl">
        <CardBody>
          <AssistantChat enabled={enabled} />
        </CardBody>
      </Card>
      <p className="mt-3 max-w-3xl text-xs text-text-3">Konuşma saklanmaz; sayfayı yenileyince silinir.</p>
    </>
  );
}
