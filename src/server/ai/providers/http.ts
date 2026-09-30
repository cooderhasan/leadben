import { AIProviderError } from "../types";

/** AI sağlayıcılarına JSON POST. 429/5xx ve ağ hataları "retryable" işaretlenir. */
export async function postJson<T>(
  provider: string,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 120_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw new AIProviderError(`${provider} bağlantı hatası: ${(err as Error).message}`, provider, undefined, true);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
    throw new AIProviderError(`${provider} ${res.status}: ${text.slice(0, 500)}`, provider, res.status, retryable);
  }
  return (await res.json()) as T;
}
