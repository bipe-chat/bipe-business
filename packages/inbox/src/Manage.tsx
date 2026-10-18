import { useEffect, useState, type FormEvent } from "react";
import { api, errorText, type AuditRow, type Device, type Role, type SavedReply, type Session, type Stats, type TeamMember } from "./api.ts";
import { auditLabel, formatDateTime, formatDuration, STATUS_LABEL, type Status } from "./lib.ts";

type Tab = "team" | "devices" | "replies" | "numbers" | "audit";
const TABS: { id: Tab; label: string }[] = [
  { id: "team", label: "Equipe" },
  { id: "devices", label: "Aparelhos" },
  { id: "replies", label: "Respostas prontas" },
  { id: "numbers", label: "Números" },
  { id: "audit", label: "Registro" },
];

/** Loads once, keeps an error in pt-BR. */
function useLoad<T>(fn: () => Promise<T>): [T | null, string | null, (v: T) => void, () => void] {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    fn()
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n]);
  return [data, error, setData, () => setN((x) => x + 1)];
}

export function Manage({ session }: { session: Session }) {
  const [tab, setTab] = useState<Tab>("team");
  return (
    <main className="manage">
      <h1>Gestão</h1>
      <div className="tabs wide" role="tablist" aria-label="Gestão">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls="manage-panel" onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="panel" id="manage-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "team" && <Team session={session} />}
        {tab === "devices" && <Devices session={session} />}
        {tab === "replies" && <Replies />}
        {tab === "numbers" && <Numbers />}
        {tab === "audit" && <Audit />}
      </div>
    </main>
  );
}

function Team({ session }: { session: Session }) {
  const [agents, loadError, setAgents] = useLoad(async () => (await api.agents()).agents);
  const [form, setForm] = useState({ email: "", name: "", role: "agent" as Role, password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (form.password.length < 12) {
      setError("A senha precisa de pelo menos 12 caracteres.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setAgents((await api.addAgent({ ...form, email: form.email.trim(), name: form.name.trim() })).agents);
      setForm({ email: "", name: "", role: "agent", password: "" });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: TeamMember) => {
    if (!window.confirm(`Remover ${a.name}? Remover tira o acesso e apaga os aparelhos dessa pessoa.`)) return;
    try {
      setAgents((await api.removeAgent(a.id)).agents);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="grid-2">
      <section>
        <h2>Equipe</h2>
        {loadError && <p className="error">{loadError}</p>}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>E-mail</th>
                <th>Papel</th>
                <th>
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {agents?.map((a) => (
                <tr key={a.id} className={a.active ? "" : "inactive"}>
                  <td>{a.name}</td>
                  <td className="mono small">{a.email}</td>
                  <td>{a.active ? (a.role === "manager" ? "Gestão" : "Atendimento") : "Removida"}</td>
                  <td className="right">
                    {a.active && a.id !== session.agent.id ? (
                      <button type="button" className="danger ghost" onClick={() => remove(a)}>
                        Remover
                      </button>
                    ) : a.id === session.agent.id ? (
                      <span className="muted small">Você</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <h2>Adicionar pessoa</h2>
        <form className="stack" onSubmit={add}>
          <label>
            Nome
            <input required maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            E-mail
            <input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label>
            Papel
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              <option value="agent">Atendimento</option>
              <option value="manager">Gestão</option>
            </select>
          </label>
          <label>
            Senha inicial
            <input type="password" autoComplete="new-password" required minLength={12} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            <span className="muted small">Pelo menos 12 caracteres. Passe para a pessoa por um canal seguro.</span>
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="primary" disabled={busy}>
            Adicionar
          </button>
        </form>
      </section>
    </div>
  );
}

function Devices({ session }: { session: Session }) {
  const [devices, loadError, setDevices] = useLoad(async () => (await api.devices()).devices);
  const [error, setError] = useState<string | null>(null);
  const remove = async (d: Device) => {
    if (!window.confirm(`Remover o aparelho ${d.device_id}? A sessão nele termina, e as chaves desse aparelho saem da conta.`)) return;
    try {
      setDevices((await api.removeDevice(d.device_id)).devices);
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <section>
      <h2>Aparelhos</h2>
      <p className="muted">Cada navegador em que alguém da equipe entrou é um aparelho da conta da empresa no Bipe.</p>
      {(loadError || error) && <p className="error">{loadError || error}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Pessoa</th>
              <th>Aparelho</th>
              <th>Entrou em</th>
              <th>
                <span className="visually-hidden">Ações</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {devices?.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  Nenhum aparelho.
                </td>
              </tr>
            )}
            {devices?.map((d) => (
              <tr key={d.device_id}>
                <td>{d.name}</td>
                <td className="mono small">{d.device_id}</td>
                <td>{formatDateTime(d.created_at)}</td>
                <td className="right">
                  {d.revoke_requested_at !== null ? (
                    <span className="error small" title="A sessão nesse aparelho já terminou. O Bipe ainda não confirmou que o aparelho saiu da conta. O sistema tenta de novo a cada 5 minutos.">
                      Remoção pendente
                    </span>
                  ) : d.device_id === session.matrix.deviceId ? (
                    <span className="muted small">Este aparelho</span>
                  ) : (
                    <button type="button" className="danger ghost" onClick={() => remove(d)}>
                      Remover
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Replies() {
  const [replies, loadError, setReplies] = useLoad(async () => (await api.savedReplies()).savedReplies);
  const [shortcut, setShortcut] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const s = shortcut.trim().toLowerCase().replace(/^\//, "");
    if (!/^[a-z0-9_-]+$/.test(s)) {
      setError("Use só letras sem acento, números, - e _ no atalho.");
      return;
    }
    setError(null);
    try {
      setReplies((await api.putSavedReply(s, body.trim())).savedReplies);
      setShortcut("");
      setBody("");
    } catch (err) {
      setError(errorText(err));
    }
  };
  const remove = async (r: SavedReply) => {
    if (!window.confirm(`Apagar a resposta /${r.shortcut}?`)) return;
    try {
      setReplies((await api.deleteSavedReply(r.id)).savedReplies);
    } catch (err) {
      setError(errorText(err));
    }
  };
  const edit = (r: SavedReply) => {
    setShortcut(r.shortcut);
    setBody(r.body);
  };

  return (
    <div className="grid-2">
      <section>
        <h2>Respostas prontas</h2>
        <p className="muted">Na conversa, digite / e o atalho. {"{nome}"} vira o primeiro nome do cliente.</p>
        {loadError && <p className="error">{loadError}</p>}
        {replies?.length === 0 && <p className="muted">Nenhuma resposta pronta ainda.</p>}
        <ul className="reply-list">
          {replies?.map((r) => (
            <li key={r.id}>
              <div>
                <strong className="mono">/{r.shortcut}</strong>
                <p>{r.body}</p>
              </div>
              <div className="row-actions">
                <button type="button" className="ghost" onClick={() => edit(r)}>
                  Editar
                </button>
                <button type="button" className="danger ghost" onClick={() => remove(r)}>
                  Apagar
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>Nova resposta</h2>
        <form className="stack" onSubmit={save}>
          <label>
            Atalho
            <input required maxLength={40} value={shortcut} placeholder="prazo" onChange={(e) => setShortcut(e.target.value)} />
            <span className="muted small">Com o mesmo atalho, a resposta muda.</span>
          </label>
          <label>
            Texto
            <textarea required rows={5} maxLength={4096} value={body} placeholder="Oi {nome}, o prazo de entrega é de 3 dias úteis." onChange={(e) => setBody(e.target.value)} />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="primary">
            Salvar
          </button>
        </form>
      </section>
    </div>
  );
}

function Numbers() {
  const [days, setDays] = useState(7);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .stats(days)
      .then((s) => alive && (setStats(s), setError(null)))
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [days]);

  const statuses: Status[] = ["open", "waiting", "solved"];
  return (
    <section>
      <div className="row-between">
        <h2>Números</h2>
        <label className="inline">
          <span>Período</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={1}>24 horas</option>
            <option value={7}>7 dias</option>
            <option value={30}>30 dias</option>
          </select>
        </label>
      </div>
      <p className="muted">Contados nos registros da empresa, sem ler o conteúdo das conversas.</p>
      {error && <p className="error">{error}</p>}
      {stats && (
        <div className="stats">
          <div className="stat">
            <h3>Conversas novas</h3>
            <p className="stat-big">{stats.newConversations}</p>
          </div>
          <div className="stat">
            <h3>Conversas por status</h3>
            {statuses.map((s) => (
              <p key={s} className="stat-row">
                <span>{STATUS_LABEL[s]}</span>
                <strong>{stats.byStatus[s] ?? 0}</strong>
              </p>
            ))}
          </div>
          <div className="stat">
            <h3>Tempo mediano da primeira resposta</h3>
            <p className="stat-big">{stats.medianFirstResponseMs === null ? "Sem dados" : formatDuration(stats.medianFirstResponseMs)}</p>
          </div>
          <div className="stat">
            <h3>Abertas por pessoa</h3>
            {stats.perAgent.length === 0 && <p className="muted">Ninguém na equipe.</p>}
            {stats.perAgent.map((a) => (
              <p key={a.id} className="stat-row">
                <span>{a.name}</span>
                <strong>{a.open}</strong>
              </p>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function Audit() {
  const [rows, error, , reload] = useLoad(async () => (await api.audit(200)).audit);
  return (
    <section>
      <div className="row-between">
        <h2>Registro</h2>
        <button type="button" className="secondary" onClick={reload}>
          Atualizar
        </button>
      </div>
      <p className="muted">Quem abriu e respondeu cada conversa. Fica no servidor da empresa.</p>
      {error && <p className="error">{error}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Quando</th>
              <th>Quem</th>
              <th>O quê</th>
              <th>Conversa</th>
              <th>Detalhe</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((r: AuditRow) => (
              <tr key={r.id}>
                <td className="nowrap">{formatDateTime(r.at)}</td>
                <td>{r.agent_name ?? "Sistema"}</td>
                <td>{auditLabel(r.action)}</td>
                <td className="mono small">{r.conversation_id ? r.conversation_id.slice(0, 8) : ""}</td>
                <td className="mono small detail">{r.detail ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
