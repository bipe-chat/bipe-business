import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/http.js";
import { hashPassword, hubSignature, newToken } from "../src/secrets.js";
import { Bridge } from "../src/service.js";
import { Store } from "../src/store.js";
import { WhatsApp } from "../src/whatsapp.js";

// HTTP routes with a fake Meta Graph API and a fake company webhook receiver. No Matrix here.

function setup() {
  const cfg = loadConfig({
    BRIDGE_PUBLIC_URL: "https://atende.loja.com.br",
    BIPE_HOMESERVER_URL: "http://hs",
    BIPE_USER_ID: "@loja:bipe.net.br",
    BIPE_PASSWORD: "pw",
    BIPE_HANDLE: "loja",
    BRIDGE_API_TOKENS: "tok-1",
    WA_PHONE_NUMBER_ID: "1055",
    WA_ACCESS_TOKEN: "meta-token",
    WA_APP_SECRET: "app-secret",
    WA_VERIFY_TOKEN: "verify-me",
    WA_GRAPH_URL: "http://graph.test",
    BRIDGE_WEBHOOK_URL: "http://company.test/hook",
    BRIDGE_WEBHOOK_SECRET: "hook-secret",
  });
  const calls: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("http://graph.test")) {
      const body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ messaging_product: "whatsapp", contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: "wamid.OUT" + calls.length }] }), { status: 200 });
    }
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const store = new Store(":memory:");
  const wa = new WhatsApp(cfg.whatsapp!, fakeFetch);
  const bridge = new Bridge(cfg, store, null, wa, fakeFetch);
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
  return { cfg, store, bridge, app, calls, req, manager, agent, mt, at };
}

const waInbound = (from: string, id: string, text: string) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "1055", changes: [{ field: "messages", value: { contacts: [{ wa_id: from, profile: { name: "Ana" } }], messages: [{ from, id, timestamp: "1700000000", type: "text", text: { body: text } }] } }] }],
});

test("Meta webhook: verification, signature, inbound message, forward to company", async () => {
  const { req, store, calls } = setup();
  assert.equal(await (await req("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42")).text(), "42");
  assert.equal((await req("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=no&hub.challenge=42")).status, 403);
  const body = JSON.stringify(waInbound("5511999", "wamid.1", "Meu pedido não chegou"));
  assert.equal((await req("/webhooks/whatsapp", { method: "POST", body, headers: { "x-hub-signature-256": "sha256=bad" } })).status, 401);
  const ok = await req("/webhooks/whatsapp", { method: "POST", body, headers: { "x-hub-signature-256": hubSignature("app-secret", body) } });
  assert.equal(ok.status, 200);
  const conv = store.conversationByExternal("whatsapp", "5511999")!;
  assert.equal(conv.contact_name, "Ana");
  assert.equal(store.waMessages(conv.id)[0]!.body, "Meu pedido não chegou");
  await new Promise((r) => setTimeout(r, 10));
  const fwd = calls.find((c) => c.url === "http://company.test/hook")!;
  assert.equal((fwd.init.headers as any)["x-hub-signature-256"], hubSignature("hook-secret", String(fwd.init.body)));
});

test("Cloud API: token, WhatsApp pass-through, buttons, Bipe needs the customer to write first", async () => {
  const { req, calls, store } = setup();
  const text = { messaging_product: "whatsapp", to: "5511999", type: "text", text: { body: "Oi Ana" } };
  assert.equal((await req("/v23.0/1055/messages", { method: "POST", json: text })).status, 401);
  assert.equal((await req("/v23.0/1055/messages", { method: "POST", json: text, token: "nope" })).status, 401);
  const r = await req("/v23.0/1055/messages", { method: "POST", json: text, token: "tok-1" });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).messages[0].id.startsWith("wamid.OUT"), true);
  const graph = calls.find((c) => c.url === "http://graph.test/v23.0/1055/messages")!;
  assert.equal((graph.init.headers as any).authorization, "Bearer meta-token");
  const q = {
    messaging_product: "whatsapp",
    to: "5511999",
    type: "interactive",
    interactive: { type: "button", body: { text: "Confirma?" }, action: { buttons: [{ type: "reply", reply: { id: "sim", title: "Sim" } }, { type: "reply", reply: { id: "nao", title: "Não" } }] } },
  };
  assert.equal((await req("/v23.0/1055/messages", { method: "POST", json: q, token: "tok-1" })).status, 200);
  const conv = store.conversationByExternal("whatsapp", "5511999")!;
  assert.match(String(store.waMessages(conv.id).at(-1)!.body), /Confirma\?\n1\. Sim\n2\. Não/);
  const bipe = await req("/v1/bipe/messages", { method: "POST", json: { ...text, messaging_product: "bipe", to: "@ana:bipe.net.br" }, token: "tok-1" });
  assert.equal(bipe.status, 400);
  assert.equal((await bipe.json()).error.code, 131047);
  const bad = await req("/v23.0/1055/messages", { method: "POST", json: { ...text, type: "audio" }, token: "tok-1" });
  assert.equal(bad.status, 400);
});

test("inbox: queue, take, notes, reply on WhatsApp, link code, roles", async () => {
  const { req, store, at, mt, agent, cfg, bridge } = setup();
  const body = JSON.stringify(waInbound("5521888", "wamid.9", "Quero trocar"));
  await req("/webhooks/whatsapp", { method: "POST", body, headers: { "x-hub-signature-256": hubSignature("app-secret", body) } });
  assert.equal((await req("/inbox/conversations")).status, 401);
  const list = await (await req("/inbox/conversations?assignee=none", { token: at })).json();
  assert.equal(list.conversations.length, 1);
  const id = list.conversations[0].id;
  const took = await (await req(`/inbox/conversations/${id}/take`, { method: "POST", token: at })).json();
  assert.equal(took.conversation.assignee_id, agent.id);
  await req(`/inbox/conversations/${id}/notes`, { method: "POST", json: { body: "Cliente VIP" }, token: at });
  const detail = await (await req(`/inbox/conversations/${id}`, { token: at })).json();
  assert.equal(detail.notes[0].body, "Cliente VIP");
  assert.equal(detail.whatsappMessages.length, 1);
  const sent = await req(`/inbox/conversations/${id}/messages`, { method: "POST", json: { text: "Oi! Vou ver." }, token: at });
  assert.equal(sent.status, 200);
  assert.ok(store.conversation(id)!.first_response_at);
  const code = await (await req(`/inbox/conversations/${id}/link-code`, { method: "POST", token: at })).json();
  assert.match(code.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(code.url, `${cfg.siteUrl}/@loja/continuar/${code.code}`);
  // Customer continues on Bipe: the bridge sees "continuar CODE" in the new chat.
  const bp = store.upsertConversation("bipe", "!new:bipe.net.br", "@ana:bipe.net.br", "Ana").conv;
  assert.equal(bridge.redeemLinkCode(code.code, bp.id), true);
  assert.equal(bridge.redeemLinkCode(code.code, bp.id), false);
  const joined = await (await req(`/inbox/conversations/${bp.id}`, { token: at })).json();
  assert.equal(joined.conversation.assignee_id, agent.id);
  assert.equal(joined.sameCustomer[0].status, "moved");
  const patch = await req(`/inbox/conversations/${bp.id}`, { method: "PATCH", json: { status: "solved" }, token: at });
  assert.equal((await patch.json()).conversation.status, "solved");
  // Roles: agents cannot manage the team or read the audit log.
  assert.equal((await req("/inbox/agents", { method: "POST", json: { email: "x@y.com", name: "X", role: "agent", password: "123456789012" }, token: at })).status, 403);
  assert.equal((await req("/inbox/audit", { token: at })).status, 403);
  assert.equal((await req("/inbox/agents", { method: "POST", json: { email: "x@y.com", name: "X", role: "agent", password: "123456789012" }, token: mt })).status, 200);
  const audit = await (await req("/inbox/audit", { token: mt })).json();
  assert.ok(audit.audit.some((a: any) => a.action === "conversation.take"));
  const stats = await (await req("/inbox/stats", { token: mt })).json();
  assert.equal(stats.linkCodes.made, 1);
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

test("inbox: templates from the inbox, status lists, link codes only for WhatsApp, stats window", async () => {
  const { req, store, at, mt, calls } = setup();
  store.putTemplate({ name: "pedido_saiu", language: "pt_BR", category: "utility", body: "Seu pedido {{1}} saiu." });
  const wa = store.upsertConversation("whatsapp", "5531777", "5531777", "Rui").conv;
  const r = await req(`/inbox/conversations/${wa.id}/messages`, { method: "POST", json: { template: { name: "pedido_saiu", language: "pt_BR", params: ["123"] } }, token: at });
  assert.equal(r.status, 200);
  const sent = JSON.parse(String(calls.find((c) => c.url.startsWith("http://graph.test"))!.init.body));
  assert.equal(sent.type, "template");
  assert.deepEqual(sent.template.components[0].parameters, [{ type: "text", text: "123" }]);
  const bp = store.upsertConversation("bipe", "!r:x", "@rui:x", "Rui").conv;
  store.updateConversation(bp.id, { status: "solved" });
  store.updateConversation(wa.id, { status: "moved" });
  const closed = await (await req("/inbox/conversations?status=solved,moved", { token: at })).json();
  assert.equal(closed.conversations.length, 2);
  assert.equal((await req(`/inbox/conversations/${bp.id}/link-code`, { method: "POST", token: at })).status, 400);
  assert.equal((await req("/inbox/device/ready", { method: "POST", token: at })).status, 503);
  const st = await (await req("/inbox/stats?days=abc", { token: mt })).json();
  assert.equal(st.days, 7);
  // Reads are logged once per agent and conversation, not on every refresh.
  for (let i = 0; i < 3; i++) await req(`/inbox/conversations/${wa.id}`, { token: at });
  assert.equal(store.auditLog().filter((a: any) => a.action === "conversation.read").length, 1);
});

test("Cloud API on Bipe: @handle resolves through the Bipe API", async () => {
  const cfg = loadConfig({ BRIDGE_PUBLIC_URL: "https://x", BIPE_HOMESERVER_URL: "http://hs", BIPE_USER_ID: "@loja:bipe.net.br", BIPE_PASSWORD: "pw", BIPE_HANDLE: "loja", BRIDGE_API_TOKENS: "tok", BIPE_API_URL: "http://api.test" });
  const seen: string[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen.push(`${url} ${(init.headers as any)?.authorization}`);
    if (String(url) === "http://api.test/v1/handles/caionasc") return new Response(JSON.stringify({ handle: "caionasc", user_id: "@abc123:bipe.net.br" }));
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const sent: string[] = [];
  const bipe = { accessToken: "bridge-token", onEvent() {}, async sendText(room: string, body: string) { sent.push(`${room} ${body}`); return "$ev1"; } } as any;
  const store = new Store(":memory:");
  const app = createApp(new Bridge(cfg, store, bipe, null, fakeFetch));
  store.upsertConversation("bipe", "!room:bipe.net.br", "@abc123:bipe.net.br", "Caio");
  const body = (to: string) => JSON.stringify({ messaging_product: "bipe", to, type: "text", text: { body: "Oi Caio" } });
  const r = await app.request("/v1/bipe/messages", { method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: body("@CaioNasc") });
  assert.equal(r.status, 200);
  assert.deepEqual(sent, ["!room:bipe.net.br Oi Caio"]);
  assert.equal(seen[0], "http://api.test/v1/handles/caionasc Bearer bridge-token");
  const missing = await app.request("/v1/bipe/messages", { method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: body("@ninguem") });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 131026);
});
