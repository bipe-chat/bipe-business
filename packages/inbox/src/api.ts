// The bridge's inbox API (packages/bridge/src/http.ts). Same origin, relative paths.

import type { Channel, Interactive, Status } from "./lib.ts";

export type Role = "agent" | "manager";
export type AgentInfo = { id: string; name: string; email: string; role: Role };
export type MatrixCreds = { homeserverUrl: string; userId: string; deviceId: string; accessToken: string };
export type Session = { token: string; agent: AgentInfo; matrix: MatrixCreds; company: { handle: string; whatsapp: boolean } };

export type Conversation = {
  id: string;
  channel: Channel;
  customer_id: string;
  external_id: string;
  contact: string;
  contact_name: string | null;
  status: Status;
  assignee_id: string | null;
  tags: string[];
  created_at: number;
  last_inbound_at: number | null;
  last_outbound_at: number | null;
  first_response_at: number | null;
  moved_to: string | null;
};
export type Note = { id: number; body: string; at: number; agent_id: string; agent_name: string };
export type WaMessage = { id: string; direction: "in" | "out"; type: string; body: string | null; agent_id: string | null; status: string | null; at: number };
export type Detail = { conversation: Conversation; notes: Note[]; whatsappMessages: WaMessage[]; sameCustomer: Conversation[] };
export type TeamMember = { id: string; email: string; name: string; role: Role; active: number; created_at: number };
export type Device = { device_id: string; agent_id: string; created_at: number; name: string };
export type SavedReply = { id: number; shortcut: string; body: string };
export type Stats = {
  newByChannel: Partial<Record<Channel, number>>;
  byStatus: Partial<Record<Status, number>>;
  linkCodes: { made: number; used: number };
  medianFirstResponseMs: number | null;
  perAgent: { id: string; name: string; open: number }[];
};
export type AuditRow = { id: number; at: number; agent_id: string | null; agent_name: string | null; action: string; conversation_id: string | null; detail: string | null };

const KEY = "bipe-inbox-session";

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    const s = raw ? (JSON.parse(raw) as Session) : null;
    return s?.token && s.matrix?.deviceId ? s : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    // Private window or blocked storage: the session lives until the tab closes.
  }
}

/** An API answer that is not 2xx. `code` is the bridge's `error` string, or a Cloud API error code. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;
  constructor(status: number, code: string, body: unknown) {
    super(`${status} ${code}`);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

let token: string | null = null;
let onUnauthorized: () => void = () => {};

export function setToken(t: string | null) {
  token = t;
}
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "network", null);
  }
  const json: any = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && path !== "/inbox/login") onUnauthorized();
    const code = typeof json?.error === "string" ? json.error : json?.error?.code !== undefined ? String(json.error.code) : String(res.status);
    throw new ApiError(res.status, code, json);
  }
  return json as T;
}

/** pt-BR text for an error, in Bipe's voice. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "network") return "Sem conexão com o servidor. Confira a internet e tente de novo.";
    if (e.code === "forbidden") return "Só a gestão pode fazer isso.";
    if (e.code === "email_taken") return "Já tem uma pessoa com esse e-mail.";
    if (e.code === "not_found") return "Não achei isso. Pode ter sido apagado.";
    if (e.code === "131047") return "O WhatsApp só aceita resposta livre até 24 horas depois da última mensagem do cliente.";
    if (e.code === "131009") return "A pergunta tem algo que o canal não aceita. Confira as opções.";
  }
  return "Algo deu errado. Tente de novo.";
}

export const api = {
  login: (email: string, password: string) => call<Session>("POST", "/inbox/login", { email, password }),
  logout: () => call<{ ok: true }>("POST", "/inbox/logout", {}),
  deviceReady: () => call<{ backup: { key: string; version: string } | null }>("POST", "/inbox/device/ready", {}),

  conversations: (q: { assignee?: "me" | "none"; status?: Status; channel?: Channel }) => {
    const p = new URLSearchParams();
    if (q.assignee) p.set("assignee", q.assignee);
    if (q.status) p.set("status", q.status);
    if (q.channel) p.set("channel", q.channel);
    return call<{ conversations: Conversation[] }>("GET", `/inbox/conversations?${p}`);
  },
  conversation: (id: string) => call<Detail>("GET", `/inbox/conversations/${encodeURIComponent(id)}`),
  patch: (id: string, p: { status?: Exclude<Status, "moved">; assigneeId?: string | null; tags?: string[] }) =>
    call<{ conversation: Conversation }>("PATCH", `/inbox/conversations/${encodeURIComponent(id)}`, p),
  take: (id: string) => call<{ conversation: Conversation }>("POST", `/inbox/conversations/${encodeURIComponent(id)}/take`, {}),
  addNote: (id: string, body: string) => call<{ notes: Note[] }>("POST", `/inbox/conversations/${encodeURIComponent(id)}/notes`, { body }),
  sendText: (id: string, text: string) => call<unknown>("POST", `/inbox/conversations/${encodeURIComponent(id)}/messages`, { text }),
  sendQuestion: (id: string, interactive: Interactive) => call<unknown>("POST", `/inbox/conversations/${encodeURIComponent(id)}/messages`, { interactive }),
  markSent: (id: string) => call<{ ok: true }>("POST", `/inbox/conversations/${encodeURIComponent(id)}/sent`, {}),
  linkCode: (id: string) => call<{ code: string; url: string; text: string }>("POST", `/inbox/conversations/${encodeURIComponent(id)}/link-code`, {}),

  savedReplies: () => call<{ savedReplies: SavedReply[] }>("GET", "/inbox/saved-replies"),
  putSavedReply: (shortcut: string, body: string) => call<{ savedReplies: SavedReply[] }>("PUT", "/inbox/saved-replies", { shortcut, body }),
  deleteSavedReply: (id: number) => call<{ savedReplies: SavedReply[] }>("DELETE", `/inbox/saved-replies/${id}`),

  agents: () => call<{ agents: TeamMember[] }>("GET", "/inbox/agents"),
  addAgent: (a: { email: string; name: string; role: Role; password: string }) => call<{ agents: TeamMember[] }>("POST", "/inbox/agents", a),
  removeAgent: (id: string) => call<{ agents: TeamMember[] }>("DELETE", `/inbox/agents/${encodeURIComponent(id)}`),
  devices: () => call<{ devices: Device[] }>("GET", "/inbox/devices"),
  removeDevice: (id: string) => call<{ devices: Device[] }>("DELETE", `/inbox/devices/${encodeURIComponent(id)}`),
  stats: (days = 7) => call<Stats>("GET", `/inbox/stats?days=${days}`),
  audit: (limit = 200) => call<{ audit: AuditRow[] }>("GET", `/inbox/audit?limit=${limit}`),
};
