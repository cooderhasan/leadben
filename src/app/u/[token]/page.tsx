import type { Metadata } from "next";
import { CheckCircle2, MailX } from "lucide-react";
import { describeUnsubscribe } from "@/server/services/unsubscribe";
import { unsubscribeAction } from "@/app/actions/unsubscribe";
import { Button, Card, CardBody } from "@/components/ui";

export const metadata: Metadata = { title: "E-posta aboneliği" };

/**
 * Herkese açık ret sayfası. Oturum gerektirmez; GET ile işlem yapılmaz (bağlantı önizleyicileri
 * yanlışlıkla ret yapmasın) — kullanıcı düğmeye basar.
 */
export default async function UnsubscribePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ done?: string }>;
}) {
  const { token } = await params;
  const { done } = await searchParams;
  const info = await describeUnsubscribe(token);

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md">
        <CardBody className="flex flex-col items-center gap-4 py-8 text-center">
          {!info ? (
            <>
              <MailX className="size-10 text-text-3" aria-hidden />
              <h1 className="text-lg font-semibold text-text">Bağlantı geçersiz</h1>
              <p className="text-sm text-text-2">Bu ret bağlantısı geçersiz veya süresi dolmuş. Gönderene yanıt vererek de listeden çıkabilirsiniz.</p>
            </>
          ) : done === "1" || info.alreadyUnsubscribed ? (
            <>
              <CheckCircle2 className="size-10 text-success" aria-hidden />
              <h1 className="text-lg font-semibold text-text">Listeden çıkarıldınız</h1>
              <p className="text-sm text-text-2">
                <strong>{info.address}</strong> adresine <strong>{info.companyName}</strong> tarafından bu sistem üzerinden
                başka ticari ileti gönderilmeyecek.
              </p>
            </>
          ) : (
            <>
              <MailX className="size-10 text-text-2" aria-hidden />
              <h1 className="text-lg font-semibold text-text">E-posta almayı durdur</h1>
              <p className="text-sm text-text-2">
                <strong>{info.address}</strong> adresine <strong>{info.companyName}</strong> tarafından gönderilen
                ticari iletileri almak istemiyor musunuz?
              </p>
              <form action={unsubscribeAction}>
                <input type="hidden" name="token" value={token} />
                <Button type="submit">Evet, listeden çıkar</Button>
              </form>
            </>
          )}
        </CardBody>
      </Card>
    </main>
  );
}
