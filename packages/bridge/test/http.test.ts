import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/http.js";
import { checkWebhookSignature, hashPassword, newToken } from "../src/secrets.js";
import { Bridge } from "../src/service.js";
import { Store } from "../src/store.js";

// HTTP routes with a fake Bipe side, a fake Bipe API and a fake company webhook receiver. No Matrix here.

function setup() {
  const cfg = loadConfig({
    BRIDGE_PUBLIC_URL: "https://atende.loja.com.br",
    BIPE_HOMESERVER_URL: "http://hs",
    BIPE_USER_ID: "@loja:bipe.net.br",
    BIPE_PASSWORD: "pw",
    BIPE_HANDLE: "loja",
    BIPE_API_URL: "http://api.test",
    BRIDGE_API_TOKENS: "tok-1",
    BRIDGE_WEBHOOK_URL: "http://company.test/hook",
    BRIDGE_WEBHOOK_SECRET: "hook-secret",
  });
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url) === "http://api.test/v1/handles/caionasc") return new Response(JSON.stringify({ handle: "caionasc", user_id: "@abc123:bipe.net.br" }));
    if (String(url).startsWith("http://api.test")) return new Response("{}", { status: 404 });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const sent: string[] = [];
  const polls = new Map<string, { id: string; label: string }[]>();
  let n = 0;
  const bipe = {
    accessToken: "bridge-token",
    handler: null as null | ((e: any) => Promise<void>),
    onEvent(h: (e: any) => Promise<void>) {
      this.handler = h;
    },
    async join() {},
    async sendText(room: string, body: string) {
      sent.push(`${room} ${body}`);
      return `$ev${++n}`;
    },
    async sendQuestion(room: string, _q: string, options: { id: string; label: string }[], fallback: string) {
      sent.push(`${room} ${fallback}`);
      const id = `$poll${++n}`;
      polls.set(id, options);
      return id;
    },
    questionOptions(id: string) {
      return polls.get(id) ?? null;
    },
  } as any;
  const store = new Store(":memory:");
  const bridge = new Bridge(cfg, store, bipe, fakeFetch);
  const app = createApp(bridge);
  const manager = store.addAgent({ email: "gerente@loja.com", name: "Gê", role: "manager", password_hash: hashPassword("123456789012") });
  const agent = store.addAgent({ email: "bia@loja.com", name: "Bia", role: "agent", password_hash: hashPassword("123456789012") });
  const mt = newToken();
  const at = newToken();
  store.addDevice("DEVM", manager.id);
  store.addDevice("DEVA", agent.id);
  store.addSession(mt, manager.id, "DEVM", 1);
  store.addSession(at, agent.id, "DEVA", 1);
  const req = (path: string, init: RequestInit & { token?: string; json?: unknown } = {}) =>
    app.request(path, {
      ...init,
      headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.json !== undefined ? { "content-type": "application/json" } : {}), ...(init.headers as any) },
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    });
  return { cfg, store, bridge, bipe, app, calls, sent, req, manager, agent, mt, at };
}

const customerWrites = async (bipe: any, room: string, user: string, body: string) => {
  await bipe.handler({ kind: "invite", roomId: room, sender: user, senderName: "Ana" });
  await bipe.handler({ kind: "text", roomId: room, eventId: "$in1", sender: user, senderName: "Ana", at: 1_700_000_000_000, body, fromCompany: false, deviceId: null });
};

test("API: token, customer must write first, text, question, answer to the webhook", async () => {
  const { req, bipe, sent, calls } = setup();
  const text = { to: "@ana:bipe.net.br", text: "Oi Ana" };
  assert.equal((await req("/v1/messages", { method: "POST", json: text })).status, 401);
  assert.equal((await req("/v1/messages", { method: "POST", json: text, token: "nope" })).status, 401);
  const cold = await req("/v1/messages", { method: "POST", json: text, token: "tok-1" });
  assert.equal(cold.status, 400);
  assert.equal((await cold.json()).error.code, "customer_must_write_first");

  await customerWrites(bipe, "!r:bipe.net.br", "@ana:bipe.net.br", "Meu pedido não chegou");
  await new Promise((r) => setTimeout(r, 10));
  const hook = calls.find((c) => c.url === "http://company.test/hook")!;
  const ev = JSON.parse(String(hook.init.body));
  assert.equal(ev.type, "message");
  assert.equal(ev.text, "Meu pedido não chegou");
  assert.deepEqual(ev.customer, { id: "@ana:bipe.net.br", name: "Ana" });
  assert.ok(checkWebhookSignature("hook-secret", String(hook.init.body), (hook.init.headers as any)["bipe-signature"], Math.floor(Date.now() / 1000)));

  const ok = await req("/v1/messages", { method: "POST", json: text, token: "tok-1" });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.customer, "@ana:bipe.net.br");
  assert.deepEqual(sent, ["!r:bipe.net.br Oi Ana"]);

  const q = { to: "!r:bipe.net.br", question: { text: "Confirma?", options: [{ id: "sim", label: "Sim" }, { id: "nao", label: "Não" }] } };
  const qr = await (await req("/v1/messages", { method: "POST", json: q, token: "tok-1" })).json();
  assert.equal(sent.at(-1), "!r:bipe.net.br Confirma?\n1. Sim\n2. Não");
  await bipe.handler({ kind: "answer", roomId: "!r:bipe.net.br", eventId: "$ans", sender: "@ana:bipe.net.br", senderName: "Ana", at: 1_700_000_100_000, questionId: qr.id, optionIds: ["nao"] });
  await new Promise((r) => setTimeout(r, 10));
  const answer = JSON.parse(String(calls.filter((c) => c.url === "http://company.test/hook").at(-1)!.init.body));
  assert.deepEqual(answer.answer, { question: qr.id, option: "nao", label: "Não" });

  const bad = await req("/v1/messages", { method: "POST", json: { to: "!r:bipe.net.br", audio: "x" }, token: "tok-1" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, "invalid_request");
  const noTpl = await req("/v1/messages", { method: "POST", json: { to: "!r:bipe.net.br", template: { name: "nada", language: "pt-BR" } }, token: "tok-1" });
  assert.equal((await noTpl.json()).error.code, "unknown_template");
});

test("API: @handle resolves through the Bipe API", async () => {
  const { req, store, sent, calls } = setup();
  store.upsertConversation("!room:bipe.net.br", "@abc123:bipe.net.br", "Caio");
  const r = await req("/v1/messages", { method: "POST", json: { to: "@CaioNasc", text: "Oi Caio" }, token: "tok-1" });
  assert.equal(r.status, 200);
  assert.deepEqual(sent, ["!room:bipe.net.br Oi Caio"]);
  assert.equal((calls[0]!.init.headers as any).authorization, "Bearer bridge-token");
  const missing = await req("/v1/messages", { method: "POST", json: { to: "@ninguem", text: "x" }, token: "tok-1" });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "unknown_handle");
});

test("inbox: queue, take, notes, template from the inbox, roles", async () => {
  const { req, store, at, mt, agent, bipe, sent } = setup();
  await customerWrites(bipe, "!q:bipe.net.br", "@rui:bipe.net.br", "Quero trocar");
  assert.equal((await req("/inbox/conversations")).status, 401);
  const list = await (await req("/inbox/conversations?assignee=none", { token: at })).json();
  assert.equal(list.conversations.length, 1);
  const id = list.conversations[0].id;
  const took = await (await req(`/inbox/conversations/${id}/take`, { method: "POST", token: at })).json();
  assert.equal(took.conversation.assignee_id, agent.id);
  await req(`/inbox/conversations/${id}/notes`, { method: "POST", json: { body: "Cliente VIP" }, token: at });
  const detail = await (await req(`/inbox/conversations/${id}`, { token: at })).json();
  assert.equal(detail.notes[0].body, "Cliente VIP");
  store.putTemplate({ name: "pedido_saiu", language: "pt-BR", category: "utility", body: "Seu pedido {1} saiu." });
  const tr = await req(`/inbox/conversations/${id}/messages`, { method: "POST", json: { template: { name: "pedido_saiu", language: "pt-BR", params: ["123"] } }, token: at });
  assert.equal(tr.status, 200);
  assert.equal(sent.at(-1), "!q:bipe.net.br Seu pedido 123 saiu.");
  assert.ok(store.conversation(id)!.first_response_at);
  assert.equal((await req(`/inbox/conversations/${id}/messages`, { method: "POST", json: { text: "oi" }, token: at })).status, 400);
  const patch = await req(`/inbox/conversations/${id}`, { method: "PATCH", json: { status: "solved" }, token: at });
  assert.equal((await patch.json()).conversation.status, "solved");
  const closed = await (await req("/inbox/conversations?status=solved", { token: at })).json();
  assert.equal(closed.conversations.length, 1);
  // Roles: agents cannot manage the team or read the audit log.
  assert.equal((await req("/inbox/agents", { method: "POST", json: { email: "x@y.com", name: "X", role: "agent", password: "123456789012" }, token: at })).status, 403);
  assert.equal((await req("/inbox/audit", { token: at })).status, 403);
  assert.equal((await req("/inbox/agents", { method: "POST", json: { email: "x@y.com", name: "X", role: "agent", password: "123456789012" }, token: mt })).status, 200);
  const audit = await (await req("/inbox/audit", { token: mt })).json();
  assert.ok(audit.audit.some((a: any) => a.action === "conversation.take"));
  const stats = await (await req("/inbox/stats?days=abc", { token: mt })).json();
  assert.equal(stats.days, 7);
  assert.equal(stats.newConversations, 1);
  // Reads are logged once per agent and conversation, not on every refresh.
  for (let i = 0; i < 3; i++) await req(`/inbox/conversations/${id}`, { token: at });
  assert.equal(store.auditLog().filter((a: any) => a.action === "conversation.read").length, 1);
  // Removing an agent ends the agent's sessions.
  await req(`/inbox/agents/${agent.id}`, { method: "DELETE", token: mt });
  assert.equal((await req("/inbox/me", { token: at })).status, 401);
});

test("inbox: saved replies are managed by managers", async () => {
  const { req, at, mt } = setup();
  assert.equal((await req("/inbox/saved-replies", { method: "PUT", json: { shortcut: "oi", body: "Oi! Como posso ajudar?" }, token: at })).status, 403);
  const r = await (await req("/inbox/saved-replies", { method: "PUT", json: { shortcut: "oi", body: "Oi! Como posso ajudar?" }, token: mt })).json();
  assert.equal(r.savedReplies[0].shortcut, "oi");
  assert.equal((await (await req("/inbox/saved-replies", { token: at })).json()).savedReplies.length, 1);
});
