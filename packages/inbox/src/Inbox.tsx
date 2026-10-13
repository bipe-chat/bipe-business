import { useCallback, useEffect, useState } from "react";
import { api, errorText, type Conversation, type Detail, type Session, type TeamMember } from "./api.ts";
import { Chat } from "./Chat.tsx";
import { CustomerCard } from "./CustomerCard.tsx";
import { displayName, formatDateTime, formatWhen } from "./lib.ts";
import { ChannelPill, usePoll } from "./ui.tsx";

type Who = "me" | "none" | "all";
type Tab = "open" | "waiting" | "solved";

const WHO: { id: Who; label: string }[] = [
  { id: "me", label: "Minhas" },
  { id: "none", label: "Sem responsável" },
  { id: "all", label: "Todas" },
];
const TABS: { id: Tab; label: string }[] = [
  { id: "open", label: "Abertas" },
  { id: "waiting", label: "Esperando" },
  { id: "solved", label: "Resolvidas" },
];

function remembered<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function remember(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    // Not important.
  }
}

export function Inbox({ session }: { session: Session }) {
  const [who, setWho] = useState<Who>(() => remembered("bipe-inbox-who", ["me", "none", "all"], "all"));
  const [tab, setTab] = useState<Tab>(() => remembered("bipe-inbox-tab", ["open", "waiting", "solved"], "open"));
  const [list, setList] = useState<Conversation[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [agents, setAgents] = useState<TeamMember[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const refreshList = usePoll(
    async () => {
      try {
        const assignee = who === "all" ? undefined : who;
        // Moved chats are done here: they show with the solved ones, marked "Continuou no Bipe".
        const parts = await Promise.all(
          (tab === "solved" ? (["solved", "moved"] as const) : [tab]).map((status) => api.conversations({ assignee, status })),
        );
        const all = parts.flatMap((p) => p.conversations);
        all.sort((a, b) => (b.last_inbound_at ?? b.created_at) - (a.last_inbound_at ?? a.created_at));
        setList(all);
        setListError(null);
      } catch (e) {
        setListError(errorText(e));
      }
    },
    5000,
    [who, tab],
  );

  usePoll(
    async () => {
      try {
        setAgents((await api.agents()).agents);
      } catch {
        // The list still works without names.
      }
    },
    60_000,
    [],
  );

  const loadDetail = useCallback(async (id: string) => {
    try {
      const d = await api.conversation(id);
      setDetail((prev) => (prev && prev.conversation.id !== id ? prev : d));
      setDetailError(null);
    } catch (e) {
      setDetailError(errorText(e));
    }
  }, []);

  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    if (selected) void loadDetail(selected);
  }, [selected, loadDetail]);

  // WhatsApp messages live on the bridge: refresh them every 5 s. Bipe messages come by sync.
  const channel = detail?.conversation.channel;
  usePoll(
    () => {
      if (selected && channel) void loadDetail(selected);
    },
    channel === "whatsapp" ? 5000 : 30_000,
    [selected, channel],
  );

  const onConversation = (c: Conversation) => {
    setDetail((d) => (d && d.conversation.id === c.id ? { ...d, conversation: c } : d));
    setList((l) => l?.map((x) => (x.id === c.id ? c : x)) ?? l);
  };

  const agentName = (id: string | null) => (id ? (agents.find((a) => a.id === id)?.name ?? "Outra pessoa") : null);
  const pick = (id: string) => setSelected(id);

  return (
    <main className={`inbox ${selected ? "has-selection" : ""}`}>
      <section className="queue" aria-label="Fila de conversas">
        <div className="filters">
          <div className="seg" role="group" aria-label="De quem">
            {WHO.map((w) => (
              <button
                key={w.id}
                type="button"
                aria-pressed={who === w.id}
                onClick={() => {
                  setWho(w.id);
                  remember("bipe-inbox-who", w.id);
                }}
              >
                {w.label}
              </button>
            ))}
          </div>
          <div className="tabs" role="group" aria-label="Status">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={tab === t.id}
                onClick={() => {
                  setTab(t.id);
                  remember("bipe-inbox-tab", t.id);
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        {listError && (
          <p className="error pad" role="alert">
            {listError}{" "}
            <button type="button" className="link" onClick={refreshList}>
              Tentar de novo
            </button>
          </p>
        )}
        {list === null && !listError && <p className="muted pad">Carregando…</p>}
        {list?.length === 0 && <p className="muted pad">Nenhuma conversa aqui.</p>}
        <ul className="conv-list">
          {list?.map((c) => {
            const assignee = agentName(c.assignee_id);
            return (
              <li key={c.id}>
                <button type="button" className="conv-row" aria-current={selected === c.id ? "true" : undefined} onClick={() => pick(c.id)}>
                  <span className="conv-top">
                    <span className="conv-name">{displayName(c)}</span>
                    <time className="conv-time" dateTime={c.last_inbound_at ? new Date(c.last_inbound_at).toISOString() : undefined} title={formatDateTime(c.last_inbound_at)}>
                      {formatWhen(c.last_inbound_at)}
                    </time>
                  </span>
                  <span className="conv-meta">
                    <ChannelPill channel={c.channel} />
                    {c.status === "moved" ? <span className="moved">Continuou no Bipe</span> : <span className="muted">{assignee ?? "Sem responsável"}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="chat" aria-label="Conversa">
        {!selected && (
          <div className="empty">
            <p>Escolha uma conversa na fila.</p>
          </div>
        )}
        {selected && (
          <button type="button" className="back ghost" onClick={() => setSelected(null)}>
            Voltar para a fila
          </button>
        )}
        {selected && detailError && !detail && (
          <p className="error pad" role="alert">
            {detailError}
          </p>
        )}
        {selected && !detail && !detailError && <p className="muted pad">Carregando…</p>}
        {detail && (
          <Chat
            key={detail.conversation.id}
            session={session}
            detail={detail}
            agents={agents}
            onConversation={onConversation}
            reload={() => loadDetail(detail.conversation.id)}
            open={pick}
          />
        )}
      </section>

      <aside className="card" aria-label="Cliente">
        {detail && <CustomerCard key={detail.conversation.id} detail={detail} onNotes={(notes) => setDetail({ ...detail, notes })} open={pick} />}
      </aside>
    </main>
  );
}
