/**
 * Sunucu açılışında bir kez çalışır. Zamanlayıcıyı başlatır (hatırlatmalar, rakip taraması, gelen posta):
 * her 5 dakikada kendi /api/cron/tick uç noktasını süreç içi gizli anahtarla çağırır.
 * (Route handler üzerinden çağrılır; böylece sunucu modülleri normal Next.js ortamında yüklenir.)
 *
 * SCHEDULER_ENABLED=false → kapalı (ör. birden fazla web kopyası varsa tek birinde açın veya dış cron kullanın).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV !== "production" || process.env.SCHEDULER_ENABLED === "false") return;

  // Web Crypto: bu dosya edge için de derlendiğinden node:crypto kullanılmaz
  if (!process.env.INTERNAL_CRON_TOKEN) process.env.INTERNAL_CRON_TOKEN = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
  const port = process.env.PORT ?? "3000";
  // Gelen yanıtlar birkaç dakikada görünsün; hatırlatma / rakip işlerinin kendi sıklık sınırları vardır
  const intervalMs = 5 * 60_000;

  const tick = async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/cron/tick`, {
        method: "POST",
        headers: { "x-cron-token": process.env.INTERNAL_CRON_TOKEN! },
        // Yönlendirme izlenmez: middleware /login'e atarsa sessizce "başarılı" görünmesin
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status !== 200) console.warn(`[scheduler] tick HTTP ${res.status} — hatırlatmalar işlenmedi`);
    } catch (err) {
      console.warn("[scheduler] tick başarısız:", (err as Error).message);
    }
  };

  setTimeout(() => void tick(), 60_000).unref();
  setInterval(() => void tick(), intervalMs).unref();
  console.log("[scheduler] zamanlayıcı açık (5 dk)");
}
