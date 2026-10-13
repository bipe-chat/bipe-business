import { Hono, type Context } from "hono";
import { z } from "zod";
import { apiError, Content, SendRequest } from "./api.js";
import { checkPassword, hashPassword, newToken, safeEqual } from "./secrets.js";
import { Bridge, SendError } from "./service.js";
import type { Agent, Status } from "./store.js";

type Env = { Variables: { agent: Agent; deviceId: string; token: string } };

/** Small in-memory limiter: `max` hits per `windowMs` per key. One bridge instance only. */
class Limiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  ok(key: string): boolean {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    list.push(now);
    this.hits.set(key, list);
    return list.length <= this.max;
  }
}

const Login = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(512) });
const Patch = z.object({
  status: z.enum(["open", "waiting", "solved"]).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
});
const Note = z.object({ body: z.string().min(1).max(4000) });
const SavedReply = z.object({ shortcut: z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/), body: z.string().min(1).max(4096) });
const NewAgent = z.object({ email: z.string().email().max(254), name: z.string().min(1).max(80), role: z.enum(["agent", "manager"]), password: z.string().min(12).max(512) });

function sendErr(c: Context, e: unknown) {
  if (e instanceof SendError) return c.json(apiError(e.code, e.message), e.status as any);
  if (e instanceof z.ZodError) return c.json(apiError("invalid_request", e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")), 400);
  if (e instanceof SyntaxError) return c.json(apiError("invalid_request", "body is not JSON"), 400);
  console.error("bridge: request failed:", (e as Error).message);
  return c.json(apiError("internal", "internal error"), 500);
}

export function createApp(bridge: Bridge) {
  const { cfg, store } = bridge;
  const app = new Hono<Env>();
  const loginLimit = new Limiter(10, 15 * 60_000);
  // A read is logged once per agent and conversation per 10 minutes, not on every refresh.
  const lastRead = new Map<string, number>();

  app.get("/health", (c) => c.json({ ok: true }));

  // ------------------------------------------------------------ API for the company's own systems (ADR 0082)
  app.post("/v1/messages", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token || !cfg.apiTokens.some((t) => safeEqual(t, token))) return c.json(apiError("unauthorized", "invalid access token"), 401);
    try {
      const req = SendRequest.parse(await c.req.json());
      return c.json(await bridge.send(req));
    } catch (e) {
      return sendErr(c, e);
    }
  });

  // ------------------------------------------------------------ inbox: sign-in
  app.post("/inbox/login", async (c) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    let body: z.infer<typeof Login>;
    try {
      body = Login.parse(await c.req.json());
    } catch {
      return c.json({ error: "invalid" }, 400);
    }
    if (!loginLimit.ok(`ip:${ip}`) || !loginLimit.ok(`email:${body.email.toLowerCase()}`)) return c.json({ error: "rate_limited" }, 429);
    const agent = store.agentByEmail(body.email);
    if (!agent || !agent.active || !checkPassword(body.password, agent.password_hash)) return c.json({ error: "wrong_credentials" }, 401);
    if (!bridge.bipe) return c.json({ error: "bipe_unavailable" }, 503);
    const m = await bridge.bipe.login(`Inbox: ${agent.name}`);
    const token = newToken();
    store.addDevice(m.deviceId, agent.id);
    store.addSession(token, agent.id, m.deviceId, cfg.sessionDays);
    store.audit("agent.login", { agentId: agent.id, detail: m.deviceId });
    return c.json({
      token,
      agent: { id: agent.id, name: agent.name, email: agent.email, role: agent.role },
      matrix: { homeserverUrl: cfg.matrix.homeserverUrl, userId: m.userId, deviceId: m.deviceId, accessToken: m.accessToken },
      company: { handle: cfg.matrix.handle },
    });
  });

  // Everything below needs a session.
  app.use("/inbox/*", async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const s = token ? store.session(token) : undefined;
    const agent = s ? store.agent(s.agent_id) : undefined;
    if (!s || !agent || !agent.active) return c.json({ error: "unauthorized" }, 401);
    c.set("agent", agent);
    c.set("deviceId", s.device_id);
    c.set("token", token);
    await next();
  });

  const manager = async (c: Context<Env>, next: () => Promise<void>) => {
    if (c.get("agent").role !== "manager") return c.json({ error: "forbidden" }, 403);
    await next();
  };

  /** The browser uploaded its device keys: the bridge signs the device and hands over the backup key. */
  app.post("/inbox/device/ready", async (c) => {
    if (!bridge.bipe) return c.json({ error: "bipe_unavailable" }, 503);
    const signed = await bridge.bipe!.signDevice(c.get("deviceId"));
    if (!signed) return c.json({ error: "device_keys_missing" }, 409);
    store.audit("device.signed", { agentId: c.get("agent").id, detail: c.get("deviceId") });
    return c.json({ backup: await bridge.bipe!.backupKey() });
  });

  app.post("/inbox/logout", async (c) => {
    const deviceId = c.get("deviceId");
    await bridge.bipe?.deleteDevice(deviceId).catch(() => {});
    store.markDeviceRemoved(deviceId);
    store.deleteSession(c.get("token"));
    store.audit("agent.logout", { agentId: c.get("agent").id, detail: deviceId });
    return c.json({ ok: true });
  });

  app.get("/inbox/me", (c) => {
    const a = c.get("agent");
    return c.json({ agent: { id: a.id, name: a.name, email: a.email, role: a.role }, company: { handle: cfg.matrix.handle } });
  });

  // ------------------------------------------------------------ inbox: conversations
  app.get("/inbox/conversations", (c) => {
    const q = c.req.query();
    const statuses = (q.status ?? "").split(",").filter((x): x is Status => ["open", "waiting", "solved"].includes(x));
    const assigneeId = q.assignee === "me" ? c.get("agent").id : q.assignee === "none" ? null : q.assignee || undefined;
    return c.json({ conversations: store.listConversations({ statuses, assigneeId }) });
  });

  app.get("/inbox/conversations/:id", (c) => {
    const conv = store.conversation(c.req.param("id"));
    if (!conv) return c.json({ error: "not_found" }, 404);
    const key = `${c.get("agent").id}:${conv.id}`;
    if ((lastRead.get(key) ?? 0) < Date.now() - 10 * 60_000) {
      lastRead.set(key, Date.now());
      store.audit("conversation.read", { agentId: c.get("agent").id, conversationId: conv.id });
    }
    return c.json({
      conversation: conv,
      notes: store.notes(conv.id),
      sameCustomer: store.listConversations({ customerId: conv.customer_id }).filter((x) => x.id !== conv.id),
    });
  });

  app.patch("/inbox/conversations/:id", async (c) => {
    try {
      const p = Patch.parse(await c.req.json());
      if (p.assigneeId) {
        const a = store.agent(p.assigneeId);
        if (!a || !a.active) return c.json({ error: "unknown_agent" }, 400);
      }
      const conv = store.updateConversation(c.req.param("id"), { status: p.status, assignee_id: p.assigneeId, tags: p.tags });
      if (!conv) return c.json({ error: "not_found" }, 404);
      store.audit("conversation.update", { agentId: c.get("agent").id, conversationId: conv.id, detail: JSON.stringify(p) });
      return c.json({ conversation: conv });
    } catch (e) {
      return sendErr(c, e);
    }
  });

  app.post("/inbox/conversations/:id/take", (c) => {
    const conv = store.updateConversation(c.req.param("id"), { assignee_id: c.get("agent").id });
    if (!conv) return c.json({ error: "not_found" }, 404);
    store.audit("conversation.take", { agentId: c.get("agent").id, conversationId: conv.id });
    return c.json({ conversation: conv });
  });

  app.post("/inbox/conversations/:id/notes", async (c) => {
    try {
      const n = Note.parse(await c.req.json());
      const conv = store.conversation(c.req.param("id"));
      if (!conv) return c.json({ error: "not_found" }, 404);
      store.addNote(conv.id, c.get("agent").id, n.body);
      store.audit("note.add", { agentId: c.get("agent").id, conversationId: conv.id });
      return c.json({ notes: store.notes(conv.id) });
    } catch (e) {
      return sendErr(c, e);
    }
  });

  app.post("/inbox/conversations/:id/messages", async (c) => {
    try {
      const m = Content.parse(await c.req.json());
      const out = await bridge.agentSend(c.req.param("id"), c.get("agent").id, m);
      return c.json(out);
    } catch (e) {
      return sendErr(c, e);
    }
  });

  /** The agent's device sent a Bipe message: record who answered (attribution and response times). */
  app.post("/inbox/conversations/:id/sent", (c) => {
    const conv = store.conversation(c.req.param("id"));
    if (!conv) return c.json({ error: "not_found" }, 404);
    store.markOutbound(conv.id);
    store.audit("message.send", { agentId: c.get("agent").id, conversationId: conv.id });
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ inbox: saved replies, templates
  app.get("/inbox/saved-replies", (c) => c.json({ savedReplies: store.savedReplies() }));
  app.put("/inbox/saved-replies", manager, async (c) => {
    try {
      const r = SavedReply.parse(await c.req.json());
      store.putSavedReply(r.shortcut, r.body);
      return c.json({ savedReplies: store.savedReplies() });
    } catch (e) {
      return sendErr(c, e);
    }
  });
  app.delete("/inbox/saved-replies/:id", manager, (c) => {
    store.deleteSavedReply(Number(c.req.param("id")));
    return c.json({ savedReplies: store.savedReplies() });
  });
  app.get("/inbox/templates", (c) => c.json({ templates: store.templates() }));

  // ------------------------------------------------------------ inbox: team (managers)
  app.get("/inbox/agents", (c) => c.json({ agents: store.agents() }));
  app.post("/inbox/agents", manager, async (c) => {
    try {
      const a = NewAgent.parse(await c.req.json());
      if (store.agentByEmail(a.email)) return c.json({ error: "email_taken" }, 409);
      const made = store.addAgent({ email: a.email, name: a.name, role: a.role, password_hash: hashPassword(a.password) });
      store.audit("agent.add", { agentId: c.get("agent").id, detail: made.id });
      return c.json({ agents: store.agents() });
    } catch (e) {
      return sendErr(c, e);
    }
  });
  /** Removes an agent: deactivates the account and deletes every device it has (ADR 0078). */
  app.delete("/inbox/agents/:id", manager, async (c) => {
    const id = c.req.param("id")!;
    if (!store.agent(id)) return c.json({ error: "not_found" }, 404);
    store.setAgentActive(id, false);
    for (const d of store.liveDevices(id)) {
      await bridge.bipe?.deleteDevice(d.device_id).catch(() => {});
      store.markDeviceRemoved(d.device_id);
    }
    store.audit("agent.remove", { agentId: c.get("agent").id, detail: id });
    return c.json({ agents: store.agents() });
  });
  app.get("/inbox/devices", manager, (c) => c.json({ devices: store.liveDevices() }));
  app.delete("/inbox/devices/:deviceId", manager, async (c) => {
    const d = c.req.param("deviceId")!;
    if (!store.deviceAgent(d)) return c.json({ error: "not_found" }, 404);
    await bridge.bipe?.deleteDevice(d).catch(() => {});
    store.markDeviceRemoved(d);
    store.audit("device.remove", { agentId: c.get("agent").id, detail: d });
    return c.json({ devices: store.liveDevices() });
  });
  app.get("/inbox/stats", manager, (c) => {
    const days = Math.min(Math.max(Math.trunc(Number(c.req.query("days") ?? 7)) || 7, 1), 365);
    return c.json({ days, ...store.stats(days * 86_400_000) });
  });
  app.get("/inbox/audit", manager, (c) => c.json({ audit: store.auditLog(Number(c.req.query("limit") ?? 200)) }));

  return app;
}
