"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

interface JobState {
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  progress: number;
  error: string | null;
}

/**
 * Arka plan işini izler; bitince sayfayı sunucudan yeniler.
 * Uzun işlemler HTTP isteğinde beklenmez — UI bu bileşenle ilerlemeyi gösterir.
 */
export function JobPoller({ jobId, label, steps }: { jobId: string; label: string; steps?: Array<[number, string]> }) {
  const router = useRouter();
  const [job, setJob] = useState<JobState>({ status: "QUEUED", progress: 0, error: null });

  useEffect(() => {
    let stop = false;
    let delay = 1500;
    const tick = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as JobState;
          if (stop) return;
          setJob(data);
          if (data.status === "SUCCEEDED" || data.status === "FAILED" || data.status === "CANCELLED") {
            router.refresh();
            return;
          }
        }
      } catch {
        /* ağ hatası — tekrar dene */
      }
      delay = Math.min(delay * 1.2, 5000);
      if (!stop) setTimeout(tick, delay);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [jobId, router]);

  const currentStep = steps?.filter(([p]) => job.progress >= p).at(-1)?.[1];

  return (
    <div className="rounded-lg border border-border bg-surface-2 p-4" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-sm font-medium text-text">
        <Loader2 className="size-4 animate-spin text-accent" aria-hidden />
        {label}
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-border">
        <div className="h-full rounded-full bg-accent transition-all duration-500" style={{ width: `${Math.max(5, job.progress)}%` }} />
      </div>
      {currentStep && <p className="mt-2 text-xs text-text-2">{currentStep}</p>}
    </div>
  );
}
