import { useState, type FormEvent } from "react";
import { api, errorText, type Detail, type Note } from "./api.ts";
import { contactLabel, displayName, formatDateTime, formatWhen, STATUS_LABEL } from "./lib.ts";
import { ChannelPill } from "./ui.tsx";

export function CustomerCard({ detail, onNotes, open }: { detail: Detail; onNotes: (n: Note[]) => void; open: (id: string) => void }) {
  const conv = detail.conversation;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contact = contactLabel(conv.channel, conv.contact);

  const addNote = async (e: FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onNotes((await api.addNote(conv.id, note.trim())).notes);
      setNote("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card-inner">
      <section>
        <h2>{displayName(conv)}</h2>
        {contact && (
          <p className="contact">
            <span className="muted small">{conv.channel === "bipe" ? "Bipe" : "Número no WhatsApp"}</span>
            <br />
            <span className="mono">{contact}</span>
          </p>
        )}
        <p className="muted small">Cliente desde {formatDateTime(conv.created_at)}</p>
      </section>

      <section>
        <h3>Canais</h3>
        <ul className="channels">
          <li>
            <ChannelPill channel={conv.channel} /> <span className="muted small">esta conversa</span>
          </li>
          {detail.sameCustomer.map((c) => (
            <li key={c.id}>
              <button type="button" className="link" onClick={() => open(c.id)}>
                <ChannelPill channel={c.channel} /> {STATUS_LABEL[c.status]}
                {c.last_inbound_at ? `, ${formatWhen(c.last_inbound_at)}` : ""}
              </button>
            </li>
          ))}
        </ul>
      </section>

      {conv.tags.length > 0 && (
        <section>
          <h3>Etiquetas</h3>
          <p className="tag-list">
            {conv.tags.map((t) => (
              <span key={t} className="tag">
                {t}
              </span>
            ))}
          </p>
        </section>
      )}

      <section>
        <h3>Notas internas: o cliente não vê</h3>
        {detail.notes.length === 0 && <p className="muted small">Nenhuma nota ainda.</p>}
        <ul className="notes">
          {detail.notes.map((n) => (
            <li key={n.id}>
              <p>{n.body}</p>
              <span className="muted small">
                {n.agent_name}, {formatWhen(n.at)}
              </span>
            </li>
          ))}
        </ul>
        <form onSubmit={addNote} className="note-form">
          <label className="visually-hidden" htmlFor="note">
            Nova nota interna
          </label>
          <textarea id="note" rows={2} value={note} maxLength={4000} placeholder="Escreva uma nota para a equipe" onChange={(e) => setNote(e.target.value)} />
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="secondary" disabled={busy || !note.trim()}>
            Salvar nota
          </button>
        </form>
      </section>
    </div>
  );
}
