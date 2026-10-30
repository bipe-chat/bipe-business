import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig, LEGACY_SCOPES, parseApiTokens, parseMcpMode } from "../src/config.js";
import { createApp } from "../src/http.js";
import { BRIDGE_TOOLS, contentWarning, createMcpApp, FORBIDDEN, TOOL_INPUT, toolsFor } from "../src/mcp.js";
import { runStdioRelay } from "../src/mcp-stdio.js";
import { Bridge } from "../src/service.js";
import { hashPassword } from "../src/secrets.js";
import { Store } from "../src/store.js";

// bipe#437: the bridge's MCP endpoint. A fake Bipe side, no Matrix.

const SECRET = "Meu pedido 4471 não chegou";
const REPLY = "Já vamos ver o pedido";

const BASE_ENV = {
  BRIDGE_PUBLIC_URL: "https://atende.loja.com.br",
  BIPE_HOMESERVER_URL: "http://hs",
  BIPE_USER_ID: "@loja:bipe.net.br",
  BIPE_PASSWORD: "pw",
  BIPE_HANDLE: "loja",
  BIPE_API_URL: "http://api.test",
};

const TOKENS = "legacy,meta:conversations:read+conversations:write,content:conversations:read+content:read+content:send+content:notes";

function setup(env: Record<string, string> = {}) {
  const cfg = loadConfig({
    ...BASE_ENV,
    BRIDGE_API_TOKENS: TOKENS,
    BRIDGE_MCP: "remote",
    ...env,
  });
  const sent: { room: string; body: string; extra: Record<string, unknown> }[] = [];
  let n = 0;
  const bipe = {
    accessToken: "bridge-token",
    handler: null as null | ((e: any) => Promise<void>),
    onEvent(h: (e: any) => Promise<void>) {
      this.handler = h;
    },
    async join() {},
    async sendText(room: string, body: string, extra: Record<string, unknown> = {}) {
      sent.push({ room, body, extra });
      return `$ev${++n}`;
    },
    async sendQuestion(room: string, _q: string, _o: unknown, fallback: string, extra: Record<string, unknown> = {}) {
      sent.push({ room, body: fallback, extra });
      return `$poll${++n}`;
    },
    questionOptions() {
      return null;
    },
    async recentMessages(roomId: string, limit: number) {
      return [{ id: "$in1", at: new Date(0).toISOString(), from: "customer", sender: "@ana:bipe.net.br", text: SECRET }].slice(-limit).map((m) => ({ ...m, room: roomId }));
    },
  } as any;
  const store = new Store(":memory:");
  const bridge = new Bridge(cfg, store, bipe, (async () => new Response("{}", { status: 404 })) as any);
  const app = createApp(bridge);
  const bia = store.addAgent({ email: "bia@loja.com", name: "Bia", role: "agent", password_hash: hashPassword("123456789012") });
  return { cfg, store, bridge, bipe, app, sent, bia };
}

async function customerWrites(bipe: any) {
  await bipe.handler({ kind: "invite", roomId: "!r:bipe.net.br", sender: "@ana:bipe.net.br", senderName: "Ana" });
  await bipe.handler({ kind: "text", roomId: "!r:bipe.net.br", eventId: "$in1", sender: "@ana:bipe.net.br", senderName: "Ana", at: 1, body: SECRET, fromCompany: false, deviceId: null });
}

/** A raw JSON-RPC session over app.request. */
async function rpcSession(app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }, token: string, path = "/mcp", host?: string) {
  const headers = (sid?: string) => ({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(host ? { host } : {}),
    ...(sid ? { "mcp-session-id": sid, "mcp-protocol-version": "2025-06-18" } : {}),
  });
  const init = await app.request(path, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Test Client", version: "1" } } }),
  });
  const sid = init.headers.get("mcp-session-id") ?? "";
  let id = 1;
  const call = async (method: string, params: unknown = {}) => {
    const r = await app.request(path, { method: "POST", headers: headers(sid), body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }) });
    return { status: r.status, body: (await r.json()) as any };
  };
  return { init, sid, call };
}

test("token scopes: parsing, legacy tokens, unknown scopes", () => {
  const t = parseApiTokens(" old , a:conversations:read+content:read ,b:content:send");
  assert.equal(t.length, 3);
  assert.equal(t[0]!.token, "old");
  assert.deepEqual([...t[0]!.scopes], [...LEGACY_SCOPES]);
  assert.deepEqual([...t[0]!.scopes], ["content:send"]);
  assert.equal(t[1]!.token, "a");
  assert.deepEqual([...t[1]!.scopes].sort(), ["content:read", "conversations:read"]);
  // The first `:` splits: scope names contain `:`.
  assert.equal(t[2]!.token, "b");
  assert.deepEqual([...t[2]!.scopes], ["content:send"]);
  assert.deepEqual(parseApiTokens(""), []);
  assert.throws(() => parseApiTokens("x:send"), /unknown scope "send"/);
  assert.throws(() => parseApiTokens("x:conversations:read+typo"), /unknown scope "typo"/);
  assert.throws(() => parseApiTokens(":content:read"), /token is empty/);
  assert.throws(() => parseApiTokens("x:"), /no scopes/);
});

test("BRIDGE_MCP: off by default, no /mcp route when off", async () => {
  assert.equal(parseMcpMode(undefined), "off");
  assert.equal(parseMcpMode(""), "off");
  assert.equal(parseMcpMode("LOCAL"), "local");
  assert.throws(() => parseMcpMode("public"));
  const cfg = loadConfig({ ...BASE_ENV, BRIDGE_API_TOKENS: "a:content:read" });
  assert.equal(cfg.mcp.mode, "off");
  assert.equal(cfg.mcp.port, 8081);
  assert.equal(cfg.mcp.url, "http://127.0.0.1:8081/mcp");
  assert.equal(contentWarning(cfg), null);
  const { app } = setup({ BRIDGE_MCP: "" });
  const r = await app.request("/mcp", { method: "POST", headers: { authorization: "Bearer content", "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 404);
  // `local` keeps /mcp off the public port.
  const local = setup({ BRIDGE_MCP: "local" });
  assert.equal((await local.app.request("/mcp", { method: "POST", headers: { authorization: "Bearer content" }, body: "{}" })).status, 404);
});

test("content warning: one line when MCP is on and a content scope is set", () => {
  const meta = loadConfig({ ...BASE_ENV, BRIDGE_MCP: "local", BRIDGE_API_TOKENS: "m:conversations:read" });
  assert.equal(contentWarning(meta), null);
  const content = loadConfig({ ...BASE_ENV, BRIDGE_MCP: "local", BRIDGE_API_TOKENS: "m:conversations:read,c:content:read" });
  assert.match(contentWarning(content)!, /content can leave|can leave this server to the model/);
});

test("registry copy: same bridge rows as bipe-shared, one input schema per tool", () => {
  assert.deepEqual(BRIDGE_TOOLS.map((t) => t.name).sort(), Object.keys(TOOL_INPUT).sort());
  for (const t of BRIDGE_TOOLS) assert.equal(t.surface, "bridge");
  const shared = new URL("../../../../../bipe-shared/registries/mcp-tools.json", import.meta.url);
  if (!existsSync(shared)) return;
  const reg = JSON.parse(readFileSync(shared, "utf8"));
  assert.deepEqual(BRIDGE_TOOLS, reg.tools.filter((t: any) => t.surface === "bridge"), "packages/bridge/src/mcp-tools.json differs from bipe-shared: copy the bridge rows again");
});

test("/v1/messages: legacy token sends; a token without content:send gets 403", async () => {
  const { app, bipe } = setup();
  await customerWrites(bipe);
  const send = (token: string) =>
    app.request("/v1/messages", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ to: "!r:bipe.net.br", text: "oi" }) });
  assert.equal((await send("legacy")).status, 200);
  assert.equal((await send("content")).status, 200);
  const meta = await send("meta");
  assert.equal(meta.status, 403);
  assert.equal(((await meta.json()) as any).error.code, "unauthorized");
});

test("MCP: tools listed per scope, 403 on a missing scope, audit has no text", async () => {
  const { app, bipe, store, sent, bia } = setup();
  await customerWrites(bipe);

  assert.equal((await app.request("/mcp", { method: "POST", body: "{}" })).status, 401);

  const meta = await rpcSession(app, "meta");
  assert.equal(meta.init.status, 200);
  assert.ok(meta.sid);
  const metaTools = (await meta.call("tools/list")).body.result.tools.map((t: any) => t.name);
  assert.deepEqual(metaTools, toolsFor(new Set(["conversations:read", "conversations:write"])).map((t) => t.name));
  assert.deepEqual(metaTools, ["list_conversations", "assign", "set_status", "tag"]);

  const list = await meta.call("tools/call", { name: "list_conversations", arguments: {} });
  const convs = list.body.result.structuredContent.conversations;
  assert.equal(convs.length, 1);
  assert.equal(convs[0].customer.id, "@ana:bipe.net.br");
  assert.ok(!JSON.stringify(list.body).includes(SECRET));
  const convId = convs[0].id;

  // A metadata token cannot read text.
  const denied = await meta.call("tools/call", { name: "read_conversation", arguments: { conversation: convId } });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, FORBIDDEN);
  assert.match(denied.body.error.message, /content:read/);
  assert.equal((await meta.call("tools/call", { name: "send_message", arguments: { to: convId, text: "x" } })).status, 403);

  assert.equal((await meta.call("tools/call", { name: "assign", arguments: { conversation: convId, agent: "bia@loja.com" } })).status, 200);
  assert.equal(store.conversation(convId)!.assignee_id, bia.id);
  await meta.call("tools/call", { name: "set_status", arguments: { conversation: convId, status: "waiting" } });
  await meta.call("tools/call", { name: "tag", arguments: { conversation: convId, tag: "entrega" } });
  assert.deepEqual(store.conversation(convId)!.tags, ["entrega"]);
  assert.equal(store.conversation(convId)!.status, "waiting");

  // The legacy token has content:send only.
  const legacy = await rpcSession(app, "legacy");
  assert.deepEqual((await legacy.call("tools/list")).body.result.tools.map((t: any) => t.name), ["send_message", "send_question"]);

  // A session belongs to the token that opened it.
  const stolen = await app.request("/mcp", {
    method: "POST",
    headers: { authorization: "Bearer content", "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": meta.sid },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
  });
  assert.equal(stolen.status, 404);

  const content = await rpcSession(app, "content");
  const all = (await content.call("tools/list")).body.result.tools.map((t: any) => t.name);
  assert.deepEqual(all, ["list_conversations", "read_conversation", "send_message", "send_question", "add_note"]);
  const read = await content.call("tools/call", { name: "read_conversation", arguments: { conversation: convId } });
  assert.equal(read.body.result.structuredContent.messages[0].text, SECRET);

  const reply = await content.call("tools/call", { name: "send_message", arguments: { to: convId, text: REPLY } });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const out = reply.body.result.structuredContent;
  assert.equal(sent.at(-1)!.body, REPLY);
  // The customer sees that a program answers (ADR 0035): the assistant marker names the MCP client.
  assert.deepEqual(sent.at(-1)!.extra, { "chat.bipe.assistant": { client: "Test Client" } });

  const q = await content.call("tools/call", { name: "send_question", arguments: { to: convId, text: "Confirma?", options: [{ id: "s", label: "Sim" }, { id: "n", label: "Não" }] } });
  assert.equal(q.body.result.isError, undefined);
  await content.call("tools/call", { name: "add_note", arguments: { conversation: convId, text: "Cliente VIP" } });
  assert.equal(store.notes(convId).at(-1)!.agent_name, "Assistente (MCP)");

  // No cold messages through MCP either.
  const cold = await content.call("tools/call", { name: "send_message", arguments: { to: "@zoe:bipe.net.br", text: "oi" } });
  assert.equal(cold.body.result.isError, true);
  assert.match(cold.body.result.content[0].text, /customer_must_write_first/);

  const audit = store.auditLog(100).filter((r) => String(r.action).startsWith("mcp."));
  const actions = audit.map((r) => r.action);
  for (const a of ["mcp.list_conversations", "mcp.read_conversation", "mcp.send_message", "mcp.send_question", "mcp.assign", "mcp.set_status", "mcp.tag", "mcp.add_note", "mcp.denied"]) {
    assert.ok(actions.includes(a), `audit has ${a}`);
  }
  const sendRow = audit.find((r) => r.action === "mcp.send_message" && r.detail === out.id)!;
  assert.equal(sendRow.conversation_id, convId);
  const dump = JSON.stringify(store.db.prepare("SELECT * FROM audit").all());
  for (const text of [SECRET, REPLY, "Confirma?", "Cliente VIP", "entrega"]) assert.ok(!dump.includes(text), `audit has no "${text}"`);
});

test("MCP local listener: refuses a request that does not name the local host", async () => {
  const { bridge } = setup({ BRIDGE_MCP: "local" });
  const local = createMcpApp(bridge);
  const ok = await rpcSession(local, "meta", "/mcp", "127.0.0.1:8081");
  assert.equal(ok.init.status, 200);
  const rebound = await rpcSession(local, "meta", "/mcp", "evil.example:8081");
  assert.equal(rebound.init.status, 403);
});

test("MCP: an SDK client over HTTP and the stdio relay (bridge mcp)", async () => {
  const { app, bipe, sent } = setup();
  await customerWrites(bipe);
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  const relays: { close(): Promise<void> }[] = [];
  try {
    const client = new Client({ name: "sdk-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: "Bearer meta" } } }));
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["list_conversations", "assign", "set_status", "tag"]);
    await assert.rejects(client.callTool({ name: "read_conversation", arguments: { conversation: "x" } }));
    await client.close();

    // stdio: a client writes JSON lines, the relay passes them to /mcp with BRIDGE_MCP_TOKEN. Same settings as the bridge.
    const env = { ...BASE_ENV, BRIDGE_API_TOKENS: TOKENS, BRIDGE_MCP: "remote", BRIDGE_MCP_URL: `http://127.0.0.1:${port}/mcp` };
    const stdioClient = async (token: string) => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      relays.push(await runStdioRelay(loadConfig({ ...env, BRIDGE_MCP_TOKEN: token }), { stdin, stdout }));
      const lines: any[] = [];
      let buf = "";
      stdout.on("data", (d) => {
        buf += String(d);
        let i;
        while ((i = buf.indexOf("\n")) >= 0) (lines.push(JSON.parse(buf.slice(0, i))), (buf = buf.slice(i + 1)));
      });
      let id = 1;
      const rpc = async (method: string, params?: unknown) => {
        const my = id++;
        stdin.write(JSON.stringify({ jsonrpc: "2.0", id: my, method, ...(params ? { params } : {}) }) + "\n");
        for (let i = 0; i < 300 && !lines.some((l) => l.id === my); i++) await new Promise((r) => setTimeout(r, 10));
        return lines.find((l) => l.id === my);
      };
      assert.ok((await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Stdio Client", version: "1" } })).result);
      stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      return rpc;
    };
    const meta = await stdioClient("meta");
    assert.deepEqual((await meta("tools/list")).result.tools.map((t: any) => t.name), ["list_conversations", "assign", "set_status", "tag"]);
    assert.equal((await meta("tools/call", { name: "read_conversation", arguments: { conversation: "x" } })).error.code, FORBIDDEN);
    const content = await stdioClient("content");
    assert.equal((await content("tools/list")).result.tools.length, 5);
    assert.ok((await content("tools/call", { name: "send_message", arguments: { to: "!r:bipe.net.br", text: REPLY } })).result.structuredContent.id);
    assert.deepEqual(sent.at(-1)!.extra, { "chat.bipe.assistant": { client: "Stdio Client" } });
  } finally {
    for (const r of relays) await r.close();
    (server as any).closeAllConnections?.();
    server.close();
  }
});

test("bridge mcp: refuses when MCP is off or the token is unknown", async () => {
  const off = loadConfig({ ...BASE_ENV, BRIDGE_API_TOKENS: "a:content:read", BRIDGE_MCP_TOKEN: "a" });
  await assert.rejects(runStdioRelay(off, { stdin: new PassThrough(), stdout: new PassThrough() }), /MCP is off/);
  const bad = loadConfig({ ...BASE_ENV, BRIDGE_API_TOKENS: "a:content:read", BRIDGE_MCP: "local", BRIDGE_MCP_TOKEN: "b" });
  await assert.rejects(runStdioRelay(bad, { stdin: new PassThrough(), stdout: new PassThrough() }), /BRIDGE_MCP_TOKEN/);
});
