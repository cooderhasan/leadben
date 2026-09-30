"use client";

import { Alert, Button } from "@/components/ui";

export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-col items-start gap-4">
      <Alert tone="danger">Bu sayfa yüklenirken bir hata oluştu. Sorun devam ederse yöneticinize bildirin.</Alert>
      <Button variant="secondary" onClick={reset}>Tekrar dene</Button>
    </div>
  );
}
