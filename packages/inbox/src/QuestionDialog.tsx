import { useEffect, useRef, useState, type FormEvent } from "react";
import { errorText } from "./api.ts";
import { buildQuestion, QUESTION, questionProblems, type Question } from "./lib.ts";

/** "Pergunta com opções": a structured question. The customer taps one option in Bipe. */
export function QuestionDialog({ onClose, onSend }: { onClose: () => void; onSend: (q: Question) => Promise<void> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const limit = QUESTION.label;
  const problems = questionProblems(text, options);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (problems.length) return;
    setBusy(true);
    setError(null);
    try {
      await onSend(buildQuestion(text, options));
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} className="dialog" aria-labelledby="q-title" onClose={onClose}>
      <form onSubmit={submit}>
        <h2 id="q-title">Pergunta com opções</h2>
        <p className="muted small">O cliente responde com um toque. Coloque de 2 a 10 opções.</p>
        <label>
          Pergunta
          <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} maxLength={QUESTION.text} required />
        </label>
        <fieldset>
          <legend>
            Opções <span className="muted small">(até {limit} caracteres cada)</span>
          </legend>
          {options.map((o, i) => (
            <div className="option-row" key={i}>
              <label className="visually-hidden" htmlFor={`opt-${i}`}>
                Opção {i + 1}
              </label>
              <input
                id={`opt-${i}`}
                value={o}
                placeholder={`Opção ${i + 1}`}
                aria-invalid={tried && (o.trim().length === 0 || o.trim().length > limit)}
                onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))}
              />
              <span className={`count ${o.trim().length > limit ? "over" : ""}`} aria-hidden="true">
                {o.trim().length}/{limit}
              </span>
              {options.length > QUESTION.minOptions && (
                <button type="button" className="ghost" aria-label={`Tirar a opção ${i + 1}`} onClick={() => setOptions(options.filter((_, j) => j !== i))}>
                  Tirar
                </button>
              )}
            </div>
          ))}
          {options.length < QUESTION.maxOptions && (
            <button type="button" className="link" onClick={() => setOptions([...options, ""])}>
              Adicionar opção
            </button>
          )}
        </fieldset>
        {tried && problems.length > 0 && (
          <ul className="error" role="alert">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={() => ref.current?.close()}>
            Cancelar
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Enviando…" : "Enviar pergunta"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
