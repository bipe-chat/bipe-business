import { Hono, type Context } from "hono";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ErrorCode, isInitializeRequest, ListToolsRequestSchema, McpError, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import registry from "./mcp-tools.json" with { type: "json" };
import { SendRequest } from "./api.js";
import { findToken, type ApiToken, type Config, type Scope } from "./config.js";
import { sha256 } from "./secrets.js";
import { Bridge, SendError } from "./service.js";
import { MCP_AGENT_ID, type Conversation } from "./store.js";

// The bridge's MCP endpoint (ADR 0130 surface 1, bipe-chat/bipe#437).
// - Tools: only the `surface: bridge` rows of bipe-shared `registries/mcp-tools.json` (copied to mcp-tools.json).
// - A tool whose scope the token lacks is not listed, and a call to it is refused (HTTP 403, JSON-RPC FORBIDDEN).
// - Every call goes to the audit table with the tool name and the conversation and event IDs. Never text.
// - Message text comes from the bridge's live Matrix client for one answer. The bridge never stores it.

export type ToolRow = {
  name: string;
  surface: "bridge";
  class: "metadata" | "content";
  writes: "none" | "send" | "state";
  scope: Scope;
  en: string;
  pt: string;
};

export const BRIDGE_TOOLS = registry.tools as ToolRow[];

/** JSON-RPC error code for a call that the token's scopes do not allow. In the server-defined range. */
export const FORBIDDEN = -32003;

/** The marker of a message that an assistant sent, as on the personal surface (bipe-shared mcp-tools.json personalSend). */
export const ASSISTANT_MARKER = "chat.bipe.assistant";
const CLIENT_MAX_LENGTH = 64;

const Status = z.enum(["open", "waiting", "solved"]);
const ConversationRef = z.string().min(1).max(255).describe("Conversation ID, room ID or the customer's Matrix ID");
const To = z.string().min(1).max(255).describe("The customer's @handle, Matrix ID, room ID or the conversation ID. The customer must have written first.");

/** Input of each bridge tool. The names must match mcp-tools.json (test/mcp.test.ts). */
export const TOOL_INPUT = {
  list_conversations: z
    .object({
      status: z.array(Status).max(3).optional().describe("Only these statuses"),
      assignee: z.string().min(1).max(254).optional().describe('"none" for unassigned, or an agent ID or email'),
      limit: z.number().int().min(1).max(200).optional(),
    })
    .strict(),
  read_conversation: z.object({ conversation: ConversationRef, limit: z.number().int().min(1).max(100).optional().describe("Newest messages to read, default 30") }).strict(),
  send_message: z
    .object({
      to: To,
      text: z.string().min(1).max(4000).optional(),
      template: z.object({ name: z.string().min(1).max(100), language: z.string().min(2).max(15), params: z.array(z.string().max(1000)).max(20).optional() }).strict().optional(),
    })
    .strict()
    .describe("Send exactly one of text or template"),
  send_question: z
    .object({
      to: To,
      text: z.string().min(1).max(2000),
      options: z
        .array(z.object({ id: z.string().min(1).max(100), label: z.string().min(1).max(40), detail: z.string().max(80).optional() }).strict())
        .min(2)
        .max(10),
    })
    .strict(),
  assign: z.object({ conversation: ConversationRef, agent: z.string().min(1).max(254).nullable().describe("Agent ID or email; null removes the assignee") }).strict(),
  set_status: z.object({ conversation: ConversationRef, status: Status }).strict(),
  tag: z.object({ conversation: ConversationRef, tag: z.string().min(1).max(40), remove: z.boolean().optional() }).strict(),
  add_note: z.object({ conversation: ConversationRef, text: z.string().min(1).max(4000) }).strict(),
} as const;
type ToolName = keyof typeof TOOL_INPUT;

/** The tools a token may use, in registry order. */
export function toolsFor(scopes: ReadonlySet<Scope>): ToolRow[] {
  return BRIDGE_TOOLS.filter((t) => scopes.has(t.scope));
}

/** The startup line of ADR 0130 when a content scope is on, or null. */
export function contentWarning(cfg: Pick<Config, "apiTokens" | "mcp">): string | null {
  if (cfg.mcp.mode === "off") return null;
  if (!cfg.apiTokens.some((t) => [...t.scopes].some((s) => s.startsWith("content:")))) return null;
  return "bridge: MCP has a content scope on: message text and notes can leave this server to the model that the MCP client uses.";
}

function toolDefinition(t: ToolRow): Tool {
  const { $schema: _drop, ...schema } = z.toJSONSchema(TOOL_INPUT[t.name as ToolName]) as Record<string, unknown>;
  return {
    name: t.name,
    description: t.en,
    inputSchema: schema as Tool["inputSchema"],
    annotations: { readOnlyHint: t.writes === "none", destructiveHint: false, openWorldHint: t.writes === "send" },
  };
}

/** Names of the tools/call requests in a JSON-RPC message (or batch) that the scopes do not allow. */
export function deniedCalls(body: unknown, scopes: ReadonlySet<Scope>): { id: unknown; name: string }[] {
  const out: { id: unknown; name: string }[] = [];
  for (const m of Array.isArray(body) ? body : [body]) {
    if (!m || typeof m !== "object" || (m as any).method !== "tools/call") continue;
    const name = String((m as any).params?.name ?? "");
    const row = BRIDGE_TOOLS.find((t) => t.name === name);
    if (row && !scopes.has(row.scope)) out.push({ id: (m as any).id ?? null, name });
  }
  return out;
}

export function forbiddenMessage(name: string): string {
  const row = BRIDGE_TOOLS.find((t) => t.name === name);
  return `this token lacks the scope ${row?.scope ?? "?"} for ${name}`;
}

function result(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data as Record<string, unknown> };
}

function toolError(code: string, message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }] };
}

function iso(ms: number | null): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

/** Metadata only: no message text. */
function conversationMeta(bridge: Bridge, c: Conversation) {
  const a = c.assignee_id ? bridge.store.agent(c.assignee_id) : undefined;
  return {
    id: c.id,
    customer: { id: c.contact, name: c.contact_name },
    status: c.status,
    assignee: a ? { id: a.id, name: a.name } : null,
    tags: c.tags,
    created_at: iso(c.created_at),
    last_inbound_at: iso(c.last_inbound_at),
    last_outbound_at: iso(c.last_outbound_at),
  };
}

type Call = { data: unknown; conversationId?: string | null; eventId?: string | null };

/** Runs one tool. Throws SendError for a refusal the client can act on. */
async function runTool(bridge: Bridge, name: ToolName, args: any, clientName: string): Promise<Call> {
  const { store } = bridge;
  const conv = (ref: string) => {
    const c = bridge.conversationFor(ref);
    if (!c) throw new SendError(404, "not_found", "conversation not found");
    return c;
  };
  switch (name) {
    case "list_conversations": {
      let assigneeId: string | null | undefined;
      if (args.assignee === "none") assigneeId = null;
      else if (args.assignee) {
        const a = store.agent(args.assignee) ?? store.agentByEmail(args.assignee);
        if (!a) throw new SendError(404, "not_found", "agent not found");
        assigneeId = a.id;
      }
      const list = store.listConversations({ statuses: args.status, assigneeId, limit: args.limit ?? 50 });
      return { data: { conversations: list.map((c) => conversationMeta(bridge, c)) } };
    }
    case "read_conversation": {
      const c = conv(args.conversation);
      if (!bridge.bipe) throw new SendError(503, "internal", "the bridge has no Matrix client running");
      const messages = await bridge.bipe.recentMessages(c.room_id, args.limit ?? 30);
      return { data: { conversation: c.id, customer: { id: c.contact, name: c.contact_name }, messages }, conversationId: c.id };
    }
    case "send_message":
    case "send_question": {
      const body =
        name === "send_question"
          ? { to: args.to, question: { text: args.text, options: args.options } }
          : { to: args.to, ...(args.text !== undefined ? { text: args.text } : {}), ...(args.template ? { template: args.template } : {}) };
      const req = SendRequest.parse(body);
      // ADR 0035 and ADR 0210: the customer sees that a program answers. The apps label a message with this marker.
      const out = await bridge.send(req, null, { [ASSISTANT_MARKER]: { client: clientName } });
      return { data: out, conversationId: out.conversation, eventId: out.id };
    }
    case "assign": {
      const c = conv(args.conversation);
      let assigneeId: string | null = null;
      if (args.agent) {
        const a = store.agent(args.agent) ?? store.agentByEmail(args.agent);
        if (!a || !a.active) throw new SendError(404, "not_found", "agent not found");
        assigneeId = a.id;
      }
      const next = store.updateConversation(c.id, { assignee_id: assigneeId })!;
      return { data: { conversation: conversationMeta(bridge, next) }, conversationId: c.id };
    }
    case "set_status": {
      const c = conv(args.conversation);
      const next = store.updateConversation(c.id, { status: args.status })!;
      return { data: { conversation: conversationMeta(bridge, next) }, conversationId: c.id };
    }
    case "tag": {
      const c = conv(args.conversation);
      const t = String(args.tag).trim().replace(/\s+/g, " ");
      if (!t) throw new SendError(400, "invalid_request", "the tag is empty");
      const others = c.tags.filter((x) => x.toLowerCase() !== t.toLowerCase());
      if (!args.remove && others.length >= 20) throw new SendError(400, "invalid_request", "a conversation has at most 20 tags");
      const next = store.updateConversation(c.id, { tags: args.remove ? others : [...others, t] })!;
      return { data: { conversation: conversationMeta(bridge, next) }, conversationId: c.id };
    }
    case "add_note": {
      const c = conv(args.conversation);
      store.addNote(c.id, MCP_AGENT_ID, args.text);
      return { data: { ok: true, conversation: c.id }, conversationId: c.id };
    }
  }
}

/**
 * One MCP server for one client connection. `scopes`: the token's scopes.
 * The SDK's low-level Server is used, so the bridge decides listing and refusal per scope.
 */
export function createMcpServer(bridge: Bridge, scopes: ReadonlySet<Scope>): Server {
  const server = new Server({ name: "bipe-business-bridge", version: "1.0.0" }, { capabilities: { tools: { listChanged: false } } });
  const clientName = () => (server.getClientVersion()?.name || "MCP").slice(0, CLIENT_MAX_LENGTH);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolsFor(scopes).map(toolDefinition) }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const row = BRIDGE_TOOLS.find((t) => t.name === name);
    if (!row) throw new McpError(ErrorCode.InvalidParams, `unknown tool ${name}`);
    if (!scopes.has(row.scope)) {
      bridge.store.audit("mcp.denied", { detail: name });
      throw new McpError(FORBIDDEN, forbiddenMessage(name));
    }
    const parsed = TOOL_INPUT[name as ToolName].safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      bridge.store.audit(`mcp.${name}`, { detail: "failed:invalid_request" });
      throw new McpError(ErrorCode.InvalidParams, parsed.error.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; "));
    }
    try {
      const call = await runTool(bridge, name as ToolName, parsed.data, clientName());
      // ADR 0078: IDs only. Never the text that was read or sent.
      bridge.store.audit(`mcp.${name}`, { conversationId: call.conversationId ?? null, detail: call.eventId ?? null });
      return result(call.data);
    } catch (e) {
      if (e instanceof SendError) {
        bridge.store.audit(`mcp.${name}`, { detail: `failed:${e.code}` });
        return toolError(e.code, e.message);
      }
      if (e instanceof z.ZodError) {
        bridge.store.audit(`mcp.${name}`, { detail: "failed:invalid_request" });
        return toolError("invalid_request", e.issues.map((i) => i.message).join("; "));
      }
      bridge.store.audit(`mcp.${name}`, { detail: "failed:internal" });
      console.error(`bridge: MCP tool ${name} failed:`, (e as Error).message);
      return toolError("internal", "internal error");
    }
  });
  return server;
}

// ---------------------------------------------------------------- Streamable HTTP

type Session = { transport: WebStandardStreamableHTTPServerTransport; server: Server; tokenHash: string; lastUsed: number };

const SESSION_IDLE_MS = 30 * 60_000;
const MAX_SESSIONS = 100;

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** `local`: the request came to 127.0.0.1 by name, not through a rebinding domain, and not from a web page elsewhere. */
function localRequest(c: Context): boolean {
  const host = (c.req.header("host") ?? "").replace(/:\d+$/, "");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) return false;
  const origin = c.req.header("origin");
  if (!origin) return true;
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * Adds `/mcp` to `app`. Each client session is bound to the token that opened it.
 * `localOnly`: refuse requests that do not name the local host (the local listener binds 127.0.0.1 only).
 */
export function mountMcp(app: Hono<any>, bridge: Bridge, opts: { localOnly: boolean }) {
  const sessions = new Map<string, Session>();
  const sweep = () => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.lastUsed > SESSION_IDLE_MS) (sessions.delete(id), void s.transport.close());
    while (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]!;
      sessions.delete(oldest[0]);
      void oldest[1].transport.close();
    }
  };
  const open = async (token: ApiToken): Promise<Session> => {
    sweep();
    const server = createMcpServer(bridge, token.scopes);
    const session: Session = { server, tokenHash: sha256(token.token), lastUsed: Date.now(), transport: null as any };
    session.transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => void sessions.set(id, session),
      onsessionclosed: (id) => void sessions.delete(id),
    });
    await server.connect(session.transport);
    return session;
  };

  app.all("/mcp", async (c) => {
    c.header("cache-control", "no-store");
    if (opts.localOnly && !localRequest(c)) return c.json(rpcError(null, FORBIDDEN, "this MCP endpoint is local only"), 403);
    const auth = c.req.header("authorization") ?? "";
    const token = findToken(bridge.cfg.apiTokens, auth.startsWith("Bearer ") ? auth.slice(7) : "");
    if (!token) {
      c.header("www-authenticate", 'Bearer realm="bipe-bridge"');
      return c.json(rpcError(null, -32001, "invalid access token"), 401);
    }
    let body: unknown;
    if (c.req.method === "POST") {
      try {
        body = await c.req.json();
      } catch {
        return c.json(rpcError(null, ErrorCode.ParseError, "body is not JSON"), 400);
      }
      const denied = deniedCalls(body, token.scopes);
      if (denied.length) {
        for (const d of denied) bridge.store.audit("mcp.denied", { detail: d.name });
        return c.json(rpcError(denied[0]!.id, FORBIDDEN, forbiddenMessage(denied[0]!.name)), 403);
      }
    }
    const sid = c.req.header("mcp-session-id");
    let session: Session | undefined;
    if (sid) {
      session = sessions.get(sid);
      if (!session || session.tokenHash !== sha256(token.token)) return c.json(rpcError(null, -32001, "session not found"), 404);
    } else if (c.req.method === "POST" && isInitializeRequest(body)) {
      session = await open(token);
    } else {
      return c.json(rpcError(null, ErrorCode.InvalidRequest, "no session: send initialize first"), 400);
    }
    session.lastUsed = Date.now();
    return session.transport.handleRequest(c.req.raw, body === undefined ? undefined : { parsedBody: body });
  });
  return app;
}

/** The `local` listener: `/mcp` only, for 127.0.0.1. */
export function createMcpApp(bridge: Bridge) {
  return mountMcp(new Hono(), bridge, { localOnly: true });
}
