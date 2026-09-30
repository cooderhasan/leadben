"use client";

import { useRef, useState, useTransition } from "react";
import { Loader2, Send } from "lucide-react";
import { askAssistantAction } from "@/app/actions/insights";
import { Alert, Button, Textarea } from "@/components/ui";

interface Turn {
  role: "user" | "assistant";
  content: string;
  warning?: string | null;
}

const EXAMPLES = ["Bugün ne yapmalıyım?", "Hangi kampanyam daha iyi yanıt alıyor?", "En yüksek puanlı lead'lerim kimler?", "Son yanıtları özetle"];

export function AssistantChat({ enabled }: { enabled: boolean }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const input = useRef<HTMLTextAreaElement>(null);

  const ask = (question: string) => {
    const q = question.trim();
    if (!q || pending) return;
    setError(null);
    const history = turns.map(({ role, content }) => ({ role, content }));
    setTurns((t) => [...t, { role: "user", content: q }]);
    if (input.current) input.current.value = "";
    start(async () => {
      const res = await askAssistantAction(q, history);
      if (res.ok) setTurns((t) => [...t, { role: "assistant", content: res.answer, warning: res.warning }]);
      else {
        setError(res.error);
        setTurns((t) => t.slice(0, -1));
        if (input.current) input.current.value = q;
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {turns.length === 0 && (
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((e) => (
            <button key={e} type="button" disabled={!enabled || pending} onClick={() => ask(e)} className="rounded-full border border-border px-3 py-1.5 text-sm text-text-2 hover:border-accent hover:text-text disabled:opacity-50">
              {e}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-3" aria-live="polite">
        {turns.map((t, i) => (
          <div key={i} className={`max-w-[90%] rounded-lg px-4 py-3 text-sm leading-relaxed ${t.role === "user" ? "self-end bg-accent text-white" : "self-start border border-border bg-surface text-text"}`}>
            <p className="whitespace-pre-wrap">{t.content}</p>
            {t.warning && <p className="mt-2 text-xs text-warning">⚠ {t.warning}</p>}
          </div>
        ))}
        {pending && (
          <div className="flex items-center gap-2 self-start text-sm text-text-2">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Verileriniz inceleniyor…
          </div>
        )}
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          ask(input.current?.value ?? "");
        }}
      >
        <Textarea
          ref={input}
          name="question"
          rows={2}
          maxLength={2000}
          disabled={!enabled}
          placeholder="Satış verileriniz hakkında sorun… (soru başına 1 kredi)"
          aria-label="Soru"
          className="flex-1"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              ask(e.currentTarget.value);
            }
          }}
        />
        <Button type="submit" disabled={!enabled || pending} aria-label="Gönder">
          <Send className="size-4" aria-hidden />
        </Button>
      </form>
    </div>
  );
}
