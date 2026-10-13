import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, errorText, type Conversation, type Detail, type SavedReply, type Session, type TeamMember } from "./api.ts";
import { addTag, contactLabel, displayName, fillVariables, firstName, formatDateTime, formatWhen, matchReplies, slashQuery, STATUS_LABEL, type Status } from "./lib.ts";
import type { ChatItem } from "./matrix.ts";
import { QuestionDialog } from "./QuestionDialog.tsx";
import { useBipe } from "./ui.tsx";

const STATUSES: Status[] = ["open", "waiting", "solved"];

type Props = {
  session: Session;
  detail: Detail;
  agents: TeamMember[];
  onConversation: (c: Conversation) => void;
};

export function Chat({ session, detail, agents, onConversation }: Props) {
  const conv = detail.conversation;
  const b = useBipe();
  const room = conv.room_id;
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [replies, setReplies] = useState<SavedReply[]>([]);
  const [slash, setSlash] = useState<{ query: string; start: number } | null>(null);
  const [active, setActive] = useState(0);
  const [asking, setAsking] = useState(false);
  const [olderBusy, setOlderBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .savedReplies()
      .then((r) => setReplies(r.savedReplies))
      .catch(() => {});
  }, []);

  const items: ChatItem[] = b.items(room);
  const lastId = items[items.length - 1]?.id;

  // Keep the newest message in view when it arrives.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastId]);

  const patch = async (p: Parameters<typeof api.patch>[1]) => {
    setError(null);
    try {
      onConversation((await api.patch(conv.id, p)).conversation);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const take = async () => {
    setError(null);
    try {
      onConversation((await api.take(conv.id)).conversation);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const mine = conv.assignee_id === session.agent.id;
  const team = agents.filter((a) => a.active);
  const bipeReady = b.state === "ready" && b.hasRoom(room);
  const canSend = !sending && text.trim().length > 0 && bipeReady;

  const send = async () => {
    if (!canSend) return;
    const body = text.trim();
    setSending(true);
    setError(null);
    try {
      // Text goes from this agent's own device. The bridge only records who answered.
      await b.sendText(room, body);
      await api.markSent(conv.id).catch(() => {});
      setText("");
      setSlash(null);
    } catch {
      setError("A mensagem não saiu pelo Bipe. Tente de novo.");
    } finally {
      setSending(false);
      box.current?.focus();
    }
  };

  const suggestions = useMemo(() => (slash ? matchReplies(replies, slash.query).slice(0, 8) : []), [slash, replies]);

  const updateSlash = (value: string, caret: number) => {
    const q = slashQuery(value, caret);
    setSlash(q && replies.length ? q : null);
    setActive(0);
  };

  const insertReply = (r: SavedReply) => {
    if (!slash) return;
    const filled = fillVariables(r.body, { nome: firstName(conv.contact_name) });
    const caret = box.current?.selectionStart ?? text.length;
    const next = text.slice(0, slash.start) + filled + text.slice(caret);
    setText(next);
    setSlash(null);
    requestAnimationFrame(() => {
      const el = box.current;
      if (!el) return;
      el.focus();
      const at = slash.start + filled.length;
      el.setSelectionRange(at, at);
    });
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash && suggestions.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (a + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if ((e.key === "Enter" && !e.ctrlKey && !e.metaKey) || e.key === "Tab") {
        e.preventDefault();
        insertReply(suggestions[active]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlash(null);
        return;
      }
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    }
  };

  const loadOlder = async () => {
    setOlderBusy(true);
    try {
      await b.loadOlder(room);
    } finally {
      setOlderBusy(false);
    }
  };

  const contact = contactLabel(conv.contact);

  return (
    <div className="chat-inner">
      <header className="chat-head">
        <div className="chat-title">
          <h2>{displayName(conv)}</h2>
          {contact && contact !== displayName(conv) && <span className="muted small">{contact}</span>}
        </div>
        <div className="chat-controls">
          <label className="inline">
            <span>Status</span>
            <select value={conv.status} onChange={(e) => void patch({ status: e.target.value as Status })}>
              {STATUSES.map((st) => (
                <option key={st} value={st}>
                  {STATUS_LABEL[st]}
                </option>
              ))}
            </select>
          </label>
          <div className="inline">
            <span>Responsável</span>
            {mine ? <strong>Você</strong> : <button type="button" className="secondary" onClick={take}>Assumir</button>}
          </div>
          <label className="inline">
            <span>{mine ? "Passar para" : "Responsável atual"}</span>
            <select value={conv.assignee_id ?? ""} onChange={(e) => void patch({ assigneeId: e.target.value || null })}>
              <option value="">Sem responsável</option>
              {team.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id === session.agent.id ? `${a.name} (você)` : a.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <Tags tags={conv.tags} onChange={(tags) => void patch({ tags })} />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </header>

      <div className="messages" ref={scroller} aria-live="polite" aria-label="Mensagens">
        {b.state === "ready" && b.hasRoom(room) && b.canLoadOlder(room) && (
          <button type="button" className="link older" onClick={loadOlder} disabled={olderBusy}>
            {olderBusy ? "Carregando…" : "Ver mensagens anteriores"}
          </button>
        )}
        {b.state !== "ready" && !b.hasRoom(room) && (
          <p className="muted center">{b.state === "failed" ? "O Bipe não conectou neste aparelho. Recarregue a página para tentar de novo." : "Conectando ao Bipe…"}</p>
        )}
        {b.state === "ready" && !b.hasRoom(room) && <p className="muted center">Esta conversa ainda não chegou neste aparelho.</p>}
        {items.length === 0 && b.hasRoom(room) && <p className="muted center">Nenhuma mensagem ainda.</p>}
        {items.map((m) => (
          <Bubble key={m.id} m={m} />
        ))}
      </div>

      <div className="composer">
        {!bipeReady && <p className="hint">Conectando ao Bipe… Dá para escrever, e o envio libera quando conectar.</p>}
        <div className="composer-box">
          <label className="visually-hidden" htmlFor="composer">
            Mensagem
          </label>
          <textarea
            id="composer"
            ref={box}
            rows={3}
            value={text}
            placeholder="Escreva a resposta. Digite / para respostas prontas."
            aria-autocomplete="list"
            aria-controls={slash ? "saved-replies" : undefined}
            aria-activedescendant={slash && suggestions[active] ? `reply-${suggestions[active]!.id}` : undefined}
            onChange={(e) => {
              setText(e.target.value);
              updateSlash(e.target.value, e.target.selectionStart);
            }}
            onKeyDown={onKey}
            onBlur={() => setTimeout(() => setSlash(null), 150)}
          />
          {slash && (
            <ul className="replies" id="saved-replies" role="listbox" aria-label="Respostas prontas">
              {suggestions.length === 0 && <li className="muted">Nenhuma resposta pronta com /{slash.query}</li>}
              {suggestions.map((r, i) => (
                <li
                  key={r.id}
                  id={`reply-${r.id}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insertReply(r);
                  }}
                >
                  <strong>/{r.shortcut}</strong> <span className="muted">{r.body}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="composer-actions">
          <button type="button" className="secondary" onClick={() => setAsking(true)}>
            Pergunta com opções
          </button>
          <span className="spacer" />
          <span className="muted small kbd-hint">Ctrl + Enter envia</span>
          <button type="button" className="primary" onClick={send} disabled={!canSend}>
            {sending ? "Enviando…" : "Enviar"}
          </button>
        </div>
      </div>
      {asking && (
        <QuestionDialog
          onClose={() => setAsking(false)}
          onSend={async (question) => {
            await api.sendQuestion(conv.id, question);
          }}
        />
      )}
    </div>
  );
}

function Bubble({ m }: { m: ChatItem }) {
  return (
    <div className={`bubble ${m.mine ? "out" : "in"} ${m.kind} ${m.pending ? "pending" : ""}`}>
      {m.kind === "question" ? (
        <div className="question">
          <p className="q-label">Pergunta</p>
          <p>{m.body}</p>
          <ul>
            {m.options?.map((o, i) => (
              <li key={i}>{o}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p>{m.body}</p>
      )}
      <span className="bubble-meta">
        <time dateTime={new Date(m.at).toISOString()} title={formatDateTime(m.at)}>
          {formatWhen(m.at)}
        </time>
        {m.pending && " · enviando"}
      </span>
    </div>
  );
}

function Tags({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const next = addTag(tags, draft);
    setDraft("");
    if (next !== tags) onChange(next);
  };
  return (
    <div className="tags" role="group" aria-label="Etiquetas">
      {tags.map((t) => (
        <span key={t} className="tag">
          {t}
          <button type="button" aria-label={`Tirar a etiqueta ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}>
            ×
          </button>
        </span>
      ))}
      <label className="visually-hidden" htmlFor="new-tag">
        Nova etiqueta
      </label>
      <input
        id="new-tag"
        className="tag-input"
        value={draft}
        maxLength={40}
        placeholder="+ etiqueta"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
        onBlur={() => draft.trim() && add()}
      />
    </div>
  );
}
