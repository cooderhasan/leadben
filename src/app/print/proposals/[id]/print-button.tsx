"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui";

export function PrintButton() {
  return (
    <Button type="button" onClick={() => window.print()}>
      <Printer className="size-4" aria-hidden /> Yazdır / PDF olarak kaydet
    </Button>
  );
}
