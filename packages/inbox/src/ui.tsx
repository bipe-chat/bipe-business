import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { bipe } from "./matrix.ts";

/** Re-renders when the Bipe connection changes (state, timeline, decryption). */
export function useBipe() {
  useSyncExternalStore(bipe.subscribe, bipe.getVersion);
  return bipe;
}

/** Runs `fn` now and every `ms`, while the tab is visible. Returns a function that runs it at once. */
export function usePoll(fn: () => Promise<void> | void, ms: number, deps: unknown[]) {
  const ref = useRef(fn);
  ref.current = fn;
  const [, force] = useState(0);
  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (alive && document.visibilityState !== "hidden") void ref.current();
    };
    tick();
    const t = setInterval(tick, ms);
    const vis = () => document.visibilityState === "visible" && tick();
    document.addEventListener("visibilitychange", vis);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", vis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps]);
  return () => {
    void ref.current();
    force((n) => n + 1);
  };
}

export function BipeStatus() {
  const b = useBipe();
  const text =
    b.state === "ready"
      ? b.keys === "waiting"
        ? "Bipe conectado. Abrindo o histórico…"
        : b.keys === "failed"
          ? "Bipe conectado. O histórico antigo não abriu neste aparelho."
          : "Bipe conectado"
      : b.state === "offline"
        ? "Sem conexão com o Bipe. Tentando de novo…"
        : b.state === "failed"
          ? "O Bipe não conectou. Recarregue a página para tentar de novo."
          : "Conectando ao Bipe…";
  const tone = b.state === "ready" ? (b.keys === "failed" ? "warn" : "ok") : b.state === "connecting" ? "wait" : "warn";
  return (
    <span className={`status status-${tone}`} role="status" aria-live="polite">
      <span className="dot" aria-hidden="true" />
      {text}
    </span>
  );
}
