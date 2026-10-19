// The bridge's inbox API (packages/bridge/src/http.ts). Same origin, relative paths.

import type { Question, Status } from "./lib.ts";

export type Role = "agent" | "manager";
export type AgentInfo = { id: string; name: string; email: string; role: Role };
export type MatrixCreds = { homeserverUrl: string; userId: string; deviceId: string; accessToken: string };
/**
 * bipe#407: the bridge session is an HttpOnly cookie that scripts cannot read. The Matrix credential comes from
 * `GET /inbox/session` after each page load and lives in memory only. Nothing goes to browser storage.
 */
export type Session = { agent: AgentInfo; matrix: MatrixCreds; company: { handle: string } };

export type Conversation = {
  id: string;
  customer_id: string;
  room_id: string;
  contact: string;
  contact_name: string | null;
  status: Status;
  assignee_id: string | null;
  tags: string[];
  created_at: number;
  last_inbound_at: number | null;
  last_outbound_at: number | null;
  first_response_at: number | null;
};
export type Note = { id: number; body: string; at: number; agent_id: string; agent_name: string };
export type Detail = { conversation: Conversation; notes: Note[]; sameCustomer: Conversation[] };
export type TeamMember = { id: string; email: string; name: string; role: Role; active: number; created_at: number };
// revoke_requested_at: a removal waits for Matrix to confirm (bipe#396). The bridge retries it.
export type Device = { device_id: string; agent_id: string; created_at: number; revoke_requested_at: number | null; revoke_attempts: number; name: string };
export type SavedReply = { id: number; shortcut: string; body: string };
export type Stats = {
  days: number;
  newConversations: number;
  byStatus: Partial<Record<Status, number>>;
  medianFirstResponseMs: number | null;
  perAgent: { id: string; name: string; open: number }[];
};
export type AuditRow = { id: number; at: number; agent_id: string | null; agent_name: string | null; action: string; conversation_id: string | null; detail: string | null };

/** Builds before bipe#407 kept the whole session, both tokens included, under this key. */
const LEGACY_KEY = "bipe-inbox-session";

/** Removes a session that an older build left in localStorage. The person signs in again once. */
export function clearLegacySession() {
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // Blocked storage: there is nothing to remove.
  }
}

/** An API answer that is not 2xx. `code` is the bridge's `error` string, or `error.code` when the error is an object. */
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

let onUnauthorized: () => void = () => {};

export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      // The bridge refuses a cookie write without this header (CSRF, bipe#407).
      headers: { "x-bipe-inbox": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "network", null);
  }
  const json: any = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && path !== "/inbox/login" && path !== "/inbox/session") onUnauthorized();
    const code = typeof json?.error === "string" ? json.error : typeof json?.error?.code === "string" ? json.error.code : String(res.status);
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
    if (e.code === "unauthorized") return "Sua sessão terminou. Entre de novo.";
    if (e.code === "invalid_question") return "A pergunta tem algo que o Bipe não aceita. Confira as opções.";
    if (e.code === "invalid_request") return "O pedido saiu incompleto. Confira os campos e tente de novo.";
    if (e.code === "customer_must_write_first") return "O cliente precisa escrever primeiro para a empresa.";
    if (e.code === "unknown_handle") return "Não achei esse cliente no Bipe.";
    if (e.code === "unknown_template") return "Esse modelo de mensagem não existe.";
  }
  return "Algo deu errado. Tente de novo.";
}

export const api = {
  login: (email: string, password: string) => call<Session>("POST", "/inbox/login", { email, password }),
  session: () => call<Session>("GET", "/inbox/session"),
  logout: () => call<{ ok: true }>("POST", "/inbox/logout", {}),
  deviceReady: () => call<{ backup: { key: string; version: string } | null }>("POST", "/inbox/device/ready", {}),

  conversations: (q: { assignee?: "me" | "none"; status?: Status }) => {
    const p = new URLSearchParams();
    if (q.assignee) p.set("assignee", q.assignee);
    if (q.status) p.set("status", q.status);
    return call<{ conversations: Conversation[] }>("GET", `/inbox/conversations?${p}`);
  },
  conversation: (id: string) => call<Detail>("GET", `/inbox/conversations/${encodeURIComponent(id)}`),
  patch: (id: string, p: { status?: Status; assigneeId?: string | null; tags?: string[] }) =>
    call<{ conversation: Conversation }>("PATCH", `/inbox/conversations/${encodeURIComponent(id)}`, p),
  take: (id: string) => call<{ conversation: Conversation }>("POST", `/inbox/conversations/${encodeURIComponent(id)}/take`, {}),
  addNote: (id: string, body: string) => call<{ notes: Note[] }>("POST", `/inbox/conversations/${encodeURIComponent(id)}/notes`, { body }),
  sendQuestion: (id: string, question: Question) => call<unknown>("POST", `/inbox/conversations/${encodeURIComponent(id)}/messages`, { question }),
  markSent: (id: string) => call<{ ok: true }>("POST", `/inbox/conversations/${encodeURIComponent(id)}/sent`, {}),

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
