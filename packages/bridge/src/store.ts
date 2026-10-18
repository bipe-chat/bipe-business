import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { sha256 } from "./secrets.js";

// The bridge's own records, on the company's server. Chat content is never stored here:
// it stays end-to-end encrypted in Matrix.

export type Status = "open" | "waiting" | "solved";
export type Role = "agent" | "manager";

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

export type Agent = {
  id: string;
  email: string;
  name: string;
  role: Role;
  password_hash: string;
  active: number;
  created_at: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  room_id TEXT NOT NULL UNIQUE,
  contact TEXT NOT NULL,
  contact_name TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','waiting','solved')),
  assignee_id TEXT REFERENCES agents(id),
  tags TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  last_inbound_at INTEGER,
  last_outbound_at INTEGER,
  first_response_at INTEGER
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  agent_id TEXT NOT NULL,
  body TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS saved_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shortcut TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS templates (
  name TEXT NOT NULL,
  language TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('utility','authentication')),
  body TEXT NOT NULL,
  PRIMARY KEY (name, language)
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('agent','manager')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_devices (
  device_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  created_at INTEGER NOT NULL,
  removed_at INTEGER,
  revoke_requested_at INTEGER,
  revoke_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  device_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  agent_id TEXT,
  action TEXT NOT NULL,
  conversation_id TEXT,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

type Row = Record<string, unknown>;

function toConversation(r: Row | undefined): Conversation | undefined {
  if (!r) return undefined;
  return { ...(r as unknown as Conversation), tags: JSON.parse(String(r.tags ?? "[]")) };
}

export class Store {
  readonly db: DatabaseSync;
  now: () => number = () => Date.now();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    // bipe#396: databases from before pending removals get the two columns.
    const columns = (this.db.prepare("PRAGMA table_info(agent_devices)").all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes("revoke_requested_at")) {
      this.db.exec("ALTER TABLE agent_devices ADD COLUMN revoke_requested_at INTEGER; ALTER TABLE agent_devices ADD COLUMN revoke_attempts INTEGER NOT NULL DEFAULT 0;");
    }
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // --- key/value (sync tokens, bridge device id)
  get(k: string): string | undefined {
    const r = this.db.prepare("SELECT v FROM kv WHERE k = ?").get(k) as Row | undefined;
    return r ? String(r.v) : undefined;
  }
  set(k: string, v: string) {
    this.db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(k, v);
  }

  // --- conversations
  /** Finds or opens the conversation for a customer's room. */
  upsertConversation(roomId: string, contact: string, contactName: string | null): { conv: Conversation; created: boolean } {
    return this.tx(() => {
      const found = this.conversationByRoom(roomId);
      if (found) {
        if (contactName && contactName !== found.contact_name) {
          this.db.prepare("UPDATE conversations SET contact_name = ? WHERE id = ?").run(contactName, found.id);
          found.contact_name = contactName;
        }
        return { conv: found, created: false };
      }
      const customerId = randomUUID();
      const id = randomUUID();
      const at = this.now();
      this.db.prepare("INSERT INTO customers (id, created_at) VALUES (?, ?)").run(customerId, at);
      this.db
        .prepare("INSERT INTO conversations (id, customer_id, room_id, contact, contact_name, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, customerId, roomId, contact, contactName, at);
      return { conv: this.conversation(id)!, created: true };
    });
  }

  conversation(id: string): Conversation | undefined {
    return toConversation(this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as Row);
  }

  conversationByRoom(roomId: string): Conversation | undefined {
    return toConversation(this.db.prepare("SELECT * FROM conversations WHERE room_id = ?").get(roomId) as Row);
  }

  listConversations(f: { status?: Status; statuses?: Status[]; assigneeId?: string | null; customerId?: string; limit?: number }): Conversation[] {
    const where: string[] = [];
    const args: (string | number | null)[] = [];
    if (f.status) (where.push("status = ?"), args.push(f.status));
    if (f.statuses?.length) (where.push(`status IN (${f.statuses.map(() => "?").join(",")})`), args.push(...f.statuses));
    if (f.customerId) (where.push("customer_id = ?"), args.push(f.customerId));
    if (f.assigneeId === null) where.push("assignee_id IS NULL");
    else if (f.assigneeId) (where.push("assignee_id = ?"), args.push(f.assigneeId));
    const sql = `SELECT * FROM conversations ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY COALESCE(last_inbound_at, created_at) DESC LIMIT ?`;
    args.push(Math.min(f.limit ?? 200, 500));
    return (this.db.prepare(sql).all(...args) as Row[]).map((r) => toConversation(r)!);
  }

  markInbound(id: string) {
    const at = this.now();
    // A new customer message opens a solved or waiting chat again.
    this.db.prepare("UPDATE conversations SET last_inbound_at = ?, status = 'open' WHERE id = ?").run(at, id);
  }

  markOutbound(id: string) {
    const at = this.now();
    this.db.prepare("UPDATE conversations SET last_outbound_at = ?, first_response_at = COALESCE(first_response_at, ?) WHERE id = ?").run(at, at, id);
  }

  updateConversation(id: string, patch: { status?: Status; assignee_id?: string | null; tags?: string[] }) {
    const c = this.conversation(id);
    if (!c) return undefined;
    const next = {
      status: patch.status ?? c.status,
      assignee_id: patch.assignee_id === undefined ? c.assignee_id : patch.assignee_id,
      tags: JSON.stringify(patch.tags ?? c.tags),
    };
    this.db.prepare("UPDATE conversations SET status = ?, assignee_id = ?, tags = ? WHERE id = ?").run(next.status, next.assignee_id, next.tags, id);
    return this.conversation(id);
  }

  // --- notes
  addNote(conversationId: string, agentId: string, body: string) {
    this.db.prepare("INSERT INTO notes (conversation_id, agent_id, body, at) VALUES (?, ?, ?, ?)").run(conversationId, agentId, body, this.now());
  }
  notes(conversationId: string) {
    return this.db
      .prepare("SELECT n.id, n.body, n.at, n.agent_id, a.name AS agent_name FROM notes n JOIN agents a ON a.id = n.agent_id WHERE conversation_id = ? ORDER BY n.at")
      .all(conversationId) as Row[];
  }

  // --- saved replies and templates
  savedReplies() {
    return this.db.prepare("SELECT id, shortcut, body FROM saved_replies ORDER BY shortcut").all() as Row[];
  }
  putSavedReply(shortcut: string, body: string) {
    this.db.prepare("INSERT INTO saved_replies (shortcut, body) VALUES (?, ?) ON CONFLICT (shortcut) DO UPDATE SET body = excluded.body").run(shortcut, body);
  }
  deleteSavedReply(id: number) {
    this.db.prepare("DELETE FROM saved_replies WHERE id = ?").run(id);
  }
  templates() {
    return this.db.prepare("SELECT name, language, category, body FROM templates ORDER BY name, language").all() as Row[];
  }
  template(name: string, language: string) {
    return this.db.prepare("SELECT name, language, category, body FROM templates WHERE name = ? AND language = ?").get(name, language) as
      | { name: string; language: string; category: string; body: string }
      | undefined;
  }
  putTemplate(t: { name: string; language: string; category: "utility" | "authentication"; body: string }) {
    this.db
      .prepare("INSERT INTO templates (name, language, category, body) VALUES (?, ?, ?, ?) ON CONFLICT (name, language) DO UPDATE SET category = excluded.category, body = excluded.body")
      .run(t.name, t.language, t.category, t.body);
  }

  // --- agents and sessions
  addAgent(a: { email: string; name: string; role: Role; password_hash: string }): Agent {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO agents (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, a.email.toLowerCase(), a.name, a.role, a.password_hash, this.now());
    return this.agent(id)!;
  }
  agent(id: string) {
    return this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Agent | undefined;
  }
  agentByEmail(email: string) {
    return this.db.prepare("SELECT * FROM agents WHERE email = ?").get(email.toLowerCase()) as Agent | undefined;
  }
  agents() {
    return this.db.prepare("SELECT id, email, name, role, active, created_at FROM agents ORDER BY name").all() as Row[];
  }
  setAgentActive(id: string, active: boolean) {
    this.db.prepare("UPDATE agents SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
  }
  addDevice(deviceId: string, agentId: string) {
    this.db.prepare("INSERT OR REPLACE INTO agent_devices (device_id, agent_id, created_at) VALUES (?, ?, ?)").run(deviceId, agentId, this.now());
  }
  /** Devices whose Matrix device is not confirmed gone. A pending removal has revoke_requested_at set. */
  liveDevices(agentId?: string) {
    const columns = "d.device_id, d.agent_id, d.created_at, d.revoke_requested_at, d.revoke_attempts, a.name";
    const sql = agentId
      ? `SELECT ${columns} FROM agent_devices d JOIN agents a ON a.id = d.agent_id WHERE removed_at IS NULL AND agent_id = ?`
      : `SELECT ${columns} FROM agent_devices d JOIN agents a ON a.id = d.agent_id WHERE removed_at IS NULL`;
    return (agentId ? this.db.prepare(sql).all(agentId) : this.db.prepare(sql).all()) as {
      device_id: string;
      agent_id: string;
      created_at: number;
      revoke_requested_at: number | null;
      revoke_attempts: number;
      name: string;
    }[];
  }
  deviceAgent(deviceId: string) {
    return this.db.prepare("SELECT agent_id FROM agent_devices WHERE device_id = ? AND removed_at IS NULL").get(deviceId) as { agent_id: string } | undefined;
  }
  /** Matrix confirmed that the device is gone. */
  markDeviceRemoved(deviceId: string) {
    this.db.prepare("UPDATE agent_devices SET removed_at = ? WHERE device_id = ? AND removed_at IS NULL").run(this.now(), deviceId);
    this.db.prepare("DELETE FROM sessions WHERE device_id = ?").run(deviceId);
  }
  /** bipe#396: ends the device's bridge sessions now and records that its Matrix device must go. */
  requestRevocation(deviceId: string) {
    this.db
      .prepare("UPDATE agent_devices SET revoke_requested_at = COALESCE(revoke_requested_at, ?) WHERE device_id = ? AND removed_at IS NULL")
      .run(this.now(), deviceId);
    this.db.prepare("DELETE FROM sessions WHERE device_id = ?").run(deviceId);
  }
  revocationFailed(deviceId: string) {
    this.db.prepare("UPDATE agent_devices SET revoke_attempts = revoke_attempts + 1 WHERE device_id = ?").run(deviceId);
  }
  pendingRevocations() {
    return (this.db.prepare("SELECT device_id FROM agent_devices WHERE revoke_requested_at IS NOT NULL AND removed_at IS NULL").all() as { device_id: string }[]).map(
      (r) => r.device_id,
    );
  }
  /** Devices whose bridge sessions all expired, with no removal asked yet. */
  expiredDevices() {
    const now = this.now();
    return (
      this.db
        .prepare(
          `SELECT d.device_id FROM agent_devices d
            WHERE d.removed_at IS NULL AND d.revoke_requested_at IS NULL
              AND EXISTS (SELECT 1 FROM sessions s WHERE s.device_id = d.device_id AND s.expires_at < ?)
              AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.device_id = d.device_id AND s.expires_at >= ?)`,
        )
        .all(now, now) as { device_id: string }[]
    ).map((r) => r.device_id);
  }
  addSession(token: string, agentId: string, deviceId: string, days: number) {
    this.db.prepare("INSERT INTO sessions (token_hash, agent_id, device_id, expires_at) VALUES (?, ?, ?, ?)").run(sha256(token), agentId, deviceId, this.now() + days * 86_400_000);
  }
  session(token: string) {
    const s = this.db.prepare("SELECT agent_id, device_id, expires_at FROM sessions WHERE token_hash = ?").get(sha256(token)) as
      | { agent_id: string; device_id: string; expires_at: number }
      | undefined;
    if (!s || s.expires_at < this.now()) return undefined;
    return s;
  }
  deleteSession(token: string) {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  }

  // --- audit
  audit(action: string, opts: { agentId?: string | null; conversationId?: string | null; detail?: string | null } = {}) {
    this.db
      .prepare("INSERT INTO audit (at, agent_id, action, conversation_id, detail) VALUES (?, ?, ?, ?, ?)")
      .run(this.now(), opts.agentId ?? null, action, opts.conversationId ?? null, opts.detail ?? null);
  }
  auditLog(limit = 200) {
    return this.db.prepare("SELECT a.*, g.name AS agent_name FROM audit a LEFT JOIN agents g ON g.id = a.agent_id ORDER BY a.id DESC LIMIT ?").all(limit) as Row[];
  }

  // --- numbers for managers. Counted from bridge records, never from content.
  // newConversations and medianFirstResponseMs cover the window; byStatus and perAgent are the state now.
  stats(sinceMs: number) {
    const since = this.now() - sinceMs;
    const created = this.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE created_at >= ?").get(since) as { n: number };
    const open = this.db.prepare("SELECT status, COUNT(*) AS n FROM conversations GROUP BY status").all() as { status: Status; n: number }[];
    const firsts = (
      this.db.prepare("SELECT first_response_at - created_at AS d FROM conversations WHERE first_response_at IS NOT NULL AND created_at >= ? ORDER BY d").all(since) as { d: number }[]
    ).map((r) => r.d);
    const median = firsts.length ? firsts[Math.floor(firsts.length / 2)]! : null;
    const perAgent = this.db
      .prepare("SELECT a.id, a.name, COUNT(c.id) AS open FROM agents a LEFT JOIN conversations c ON c.assignee_id = a.id AND c.status IN ('open','waiting') WHERE a.active = 1 GROUP BY a.id ORDER BY a.name")
      .all() as Row[];
    return {
      newConversations: created.n,
      byStatus: Object.fromEntries(open.map((r) => [r.status, r.n])),
      medianFirstResponseMs: median,
      perAgent,
    };
  }
}
