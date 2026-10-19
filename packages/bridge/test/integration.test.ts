import { test } from "node:test";
import assert from "node:assert/strict";
import * as sdk from "matrix-js-sdk";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/http.js";
import { BipeSide } from "../src/matrix.js";
import { hashPassword } from "../src/secrets.js";
import { Bridge } from "../src/service.js";
import { Store } from "../src/store.js";

// End to end against a real homeserver. Runs only with BIPE_TEST_HS set, for example
// BIPE_TEST_HS=http://127.0.0.1:8008 for a local Synapse with open registration (see README).

const HS = process.env.BIPE_TEST_HS;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet: any = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, getChild: () => quiet };

async function waitFor<T>(what: string, fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

async function register(user: string, password: string) {
  const c = sdk.createClient({ baseUrl: HS!, logger: quiet });
  await c.registerRequest({ username: user, password, auth: { type: "m.login.dummy" } });
}

async function client(creds: { userId: string; accessToken: string; deviceId: string }) {
  const c = sdk.createClient({ baseUrl: HS!, ...creds, logger: quiet });
  await c.initRustCrypto({ useIndexedDB: false });
  await c.startClient({ initialSyncLimit: 20 });
  await waitFor("first sync", () => c.isInitialSyncComplete());
  return c;
}

async function loginClient(user: string, password: string) {
  const r = await sdk.createClient({ baseUrl: HS!, logger: quiet }).loginRequest({ type: "m.login.password", identifier: { type: "m.id.user", user }, password });
  return client({ userId: r.user_id, accessToken: r.access_token, deviceId: r.device_id });
}

const texts = (c: sdk.MatrixClient, roomId: string) =>
  (c.getRoom(roomId)?.getLiveTimeline().getEvents() ?? []).filter((e) => e.getType() === "m.room.message").map((e) => e.getContent().body as string);

test("bridge end to end: customer writes, company answers, question and tap, agent device, link code", { skip: !HS, timeout: 180_000 }, async () => {
  const n = Math.random().toString(36).slice(2, 8);
  const company = `loja${n}`;
  const customer = `ana${n}`;
  const pw = `pw-${n}-long-enough`;
  await register(company, pw);
  await register(customer, pw);
  const host = new URL(HS!).hostname === "127.0.0.1" ? "localhost" : new URL(HS!).hostname;
  const env = {
    BRIDGE_PUBLIC_URL: "https://atende.loja.test",
    BIPE_HOMESERVER_URL: HS!,
    BIPE_USER_ID: `@${company}:${host}`,
    BIPE_PASSWORD: pw,
    BIPE_HANDLE: company,
    BRIDGE_API_TOKENS: "tok",
    BRIDGE_WEBHOOK_URL: "http://company.test/hook",
    BRIDGE_WEBHOOK_SECRET: "s",
  };

  // 1. First-time setup prints the recovery key.
  const setupStore = new Store(":memory:");
  const setupSide = new BipeSide({ ...loadConfig(env).matrix, recoveryKey: "" }, setupStore);
  await setupSide.start();
  const recoveryKey = await setupSide.setup({ reset: false });
  assert.ok(recoveryKey.length > 40);
  await setupSide.stop();

  // 2. The bridge starts with the recovery key.
  const cfg = loadConfig({ ...env, BIPE_RECOVERY_KEY: recoveryKey });
  const store = new Store(":memory:");
  const hooks: any[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    if (String(url) === "http://company.test/hook") hooks.push(JSON.parse(String(init.body)));
    return new Response("ok");
  }) as unknown as typeof fetch;
  const side = new BipeSide(cfg.matrix, store);
  const bridge = new Bridge(cfg, store, side, fakeFetch);
  await side.start();
  const app = createApp(bridge);
  const api = (path: string, json?: unknown, token = "tok") =>
    app.request(path, { method: json === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json) });

  try {
    // 3. The customer writes first, in an encrypted DM.
    const ana = await loginClient(customer, pw);
    const { room_id } = await ana.createRoom({
      is_direct: true,
      invite: [cfg.matrix.userId],
      initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }],
    });
    const conv = await waitFor("conversation", () => store.conversationByRoom(room_id));
    await waitFor("bridge joined", () => ana.getRoom(room_id)?.getMember(cfg.matrix.userId)?.membership === "join");
    await ana.sendTextMessage(room_id, "Oi, meu pedido 123 não chegou");
    await waitFor("webhook text", () => hooks.find((h) => h.type === "message" && h.text === "Oi, meu pedido 123 não chegou"));
    assert.ok(store.conversation(conv.id)!.last_inbound_at);

    // 4. The company's system answers through the API.
    const r = await api("/v1/messages", { to: `@${customer}:${host}`, text: "Oi Ana, já vamos ver." });
    assert.equal(r.status, 200, await r.clone().text());
    await waitFor("customer reads reply", () => texts(ana, room_id).includes("Oi Ana, já vamos ver."));

    // 5. A structured question (ADR 0081); the customer taps an option.
    const q = await api("/v1/messages", { to: room_id, question: { text: "Quer receber amanhã?", options: [{ id: "sim", label: "Sim" }, { id: "outro", label: "Outro dia" }] } });
    const qid: string = (await q.json()).id;
    const poll = await waitFor("poll arrives", () => ana.getRoom(room_id)?.getLiveTimeline().getEvents().find((e) => e.getId() === qid && e.getType().endsWith("poll.start")));
    assert.equal(poll.getContent()["org.matrix.msc3381.poll.start"].answers[1].id, "outro");
    await ana.sendEvent(room_id, "org.matrix.msc3381.poll.response" as any, { "m.relates_to": { rel_type: "m.reference", event_id: qid }, "org.matrix.msc3381.poll.response": { answers: ["outro"] } } as any);
    const tap = await waitFor("webhook tap", () => hooks.find((h) => h.type === "answer"));
    assert.deepEqual(tap.answer, { question: qid, option: "outro", label: "Outro dia" });

    // 6. An agent signs in: new device, signed by the bridge, gets the backup key, reads history.
    store.addAgent({ email: "bia@loja.test", name: "Bia", role: "agent", password_hash: hashPassword("123456789012") });
    const loginRes = await app.request("/inbox/login", { method: "POST", headers: { "content-type": "application/json", "x-bipe-inbox": "1" }, body: JSON.stringify({ email: "bia@loja.test", password: "123456789012" }) });
    const login = { ...(await loginRes.json()), token: /bipe_inbox_session=([^;]+)/.exec(loginRes.headers.get("set-cookie") ?? "")?.[1] };
    assert.ok(login.token && login.matrix.deviceId);
    const bia = await client({ userId: login.matrix.userId, accessToken: login.matrix.accessToken, deviceId: login.matrix.deviceId });
    const ready = await waitFor("device ready", async () => {
      const res = await api("/inbox/device/ready", {}, login.token);
      return res.status === 200 ? res.json() : null;
    });
    assert.ok(ready.backup?.key);
    await waitFor("backup has the room", async () => {
      const res = await side.client.http.authedRequest<any>(sdk.Method.Get, "/room_keys/keys", { version: ready.backup.version });
      return Object.keys(res.rooms ?? {}).length > 0;
    }, 30_000);
    await bia.getCrypto()!.storeSessionBackupPrivateKey(Buffer.from(ready.backup.key, "base64"), ready.backup.version);
    const restored = await bia.getCrypto()!.restoreKeyBackup();
    assert.ok(restored.imported > 0);
    const first = await waitFor("agent sees the room", () => bia.getRoom(room_id)?.getLiveTimeline().getEvents().find((e) => e.isEncrypted() || e.getType() === "m.room.message"));
    await bia.decryptEventIfNeeded(first);
    const agentView = await waitFor("agent decrypts history", async () => {
      const evs = bia.getRoom(room_id)?.getLiveTimeline().getEvents() ?? [];
      for (const e of evs) await bia.decryptEventIfNeeded(e);
      return texts(bia, room_id).includes("Oi, meu pedido 123 não chegou") ? texts(bia, room_id) : null;
    }, 30_000);
    assert.ok(agentView.length >= 1);
    const st = await ana.getCrypto()!.getDeviceVerificationStatus(cfg.matrix.userId, login.matrix.deviceId);
    assert.equal(st?.signedByOwner, true);

    // 7. The agent answers from the agent's own device; the customer reads it.
    await bia.sendTextMessage(room_id, "Aqui é a Bia. Seu pedido sai hoje.");
    await waitFor("customer reads agent", () => texts(ana, room_id).includes("Aqui é a Bia. Seu pedido sai hoje."));

    // 8. Signing out deletes the device.
    await api("/inbox/logout", {}, login.token);
    const devices = await side.client.getDevices();
    assert.ok(!devices.devices.some((d) => d.device_id === login.matrix.deviceId));
    bia.stopClient();
    ana.stopClient();
  } finally {
    await side.stop();
  }
});
