import * as sdk from "matrix-js-sdk";
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/index.js";
const HS = "http://127.0.0.1:8008";
const rnd = Math.random().toString(36).slice(2, 7);
async function register(u, p) {
  const c = sdk.createClient({ baseUrl: HS });
  try { await c.registerRequest({ username: u, password: p, auth: { type: "m.login.dummy" } }); } catch (e) { if (!String(e).includes("M_USER_IN_USE")) throw e; }
}
async function login(u, p, name, cbs) {
  const c0 = sdk.createClient({ baseUrl: HS });
  const r = await c0.loginRequest({ type: "m.login.password", identifier: { type: "m.id.user", user: u }, password: p, initial_device_display_name: name });
  const c = sdk.createClient({ baseUrl: HS, accessToken: r.access_token, userId: r.user_id, deviceId: r.device_id, cryptoCallbacks: cbs });
  await c.initRustCrypto({ useIndexedDB: false });
  await c.startClient({ initialSyncLimit: 10 });
  await new Promise((res) => c.once(sdk.ClientEvent.Sync, (s) => res(s)));
  return c;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const co = "loja" + rnd, pw = "pw-" + rnd, cu = "ana" + rnd;
await register(co, pw); await register(cu, pw);
// bridge device
let ssKey;
const bridge = await login(co, pw, "Bipe bridge", { getSecretStorageKey: async ({ keys }) => [Object.keys(keys)[0], ssKey.privateKey] , cacheSecretStorageKey: (id, info, k) => {} });
const bc = bridge.getCrypto();
await bc.bootstrapCrossSigning({ authUploadDeviceSigningKeys: async (f) => f({ type: "m.login.password", identifier: { type: "m.id.user", user: co }, password: pw }) });
await bc.bootstrapSecretStorage({ createSecretStorageKey: async () => (ssKey = await bc.createRecoveryKeyFromPassphrase()), setupNewKeyBackup: true });
console.log("cross-signing ready", await bc.isCrossSigningReady(), "recovery key", ssKey.encodedPrivateKey.slice(0, 9) + "…");
// customer writes
const cust = await login(cu, pw, "Ana phone");
const { room_id } = await cust.createRoom({ is_direct: true, invite: [bridge.getUserId()], initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } }] });
bridge.on(sdk.RoomMemberEvent.Membership, (ev, m) => { if (m.userId === bridge.getUserId() && m.membership === "invite") bridge.joinRoom(m.roomId).catch(() => {}); });
await sleep(1500);
await bridge.joinRoom(room_id).catch(()=>{});
await sleep(1000);
await cust.sendTextMessage(room_id, "Oi, meu pedido 123 não chegou");
await sleep(2500);
// agent device logs in later
const agent = await login(co, pw, "Inbox: Bia");
const agentId = agent.getDeviceId();
await sleep(1000);
await bc.getUserDeviceInfo([bridge.getUserId()], true);
await bc.crossSignDevice(agentId);
await sleep(1500);
const st = await agent.getCrypto().getDeviceVerificationStatus(bridge.getUserId(), agentId);
console.log("agent cross-signed by bridge:", st?.crossSigningVerified, "bridge view:", (await bc.getDeviceVerificationStatus(bridge.getUserId(), agentId))?.signedByOwner);
// wait for bridge backup upload
for (let i=0;i<30;i++){ const n = await bc.getActiveSessionBackupVersion(); const cnt = (await bridge.http.authedRequest('GET','/room_keys/keys',{version:n},undefined,{prefix:'/_matrix/client/v3'})); const k=Object.keys(cnt.rooms||{}).length; if(k) {console.log('backup rooms',k);break;} await sleep(1000);}
// hand backup key to agent
const bk = await bc.getSessionBackupPrivateKey();
const info = await bc.getKeyBackupInfo();
await agent.getCrypto().storeSessionBackupPrivateKey(bk, info.version);
const res = await agent.getCrypto().restoreKeyBackup();
console.log("restored", res.imported, "of", res.total);
await sleep(1000);
const room = agent.getRoom(room_id);
const evs = room?.getLiveTimeline().getEvents().filter(e => e.getType() === "m.room.message" || e.isEncrypted()) ?? [];
for (const e of evs) { await agent.decryptEventIfNeeded(e); console.log("agent reads:", e.getContent().body); }
// new message after agent exists: customer must see agent device
await cust.sendTextMessage(room_id, "Alguém aí?");
await sleep(2500);
const evs2 = agent.getRoom(room_id).getLiveTimeline().getEvents().filter(e => e.getType()==="m.room.message");
for (const e of agent.getRoom(room_id).getLiveTimeline().getEvents()) { if (e.isEncrypted()||e.getType()==="m.room.message"){ await agent.decryptEventIfNeeded(e); console.log("agent live:", e.getType(), e.getContent().body);} }
// agent replies, customer reads
await agent.sendTextMessage(room_id, "Oi Ana, vou ver agora.");
await sleep(2500);
console.log("customer sees:", JSON.stringify(cust.getRoom(room_id).getLiveTimeline().getEvents().filter(e=>e.getType()==="m.room.message").map(e=>e.getContent().body)));
// customer's view of agent device trust
const cst = await cust.getCrypto().getUserDeviceInfo([bridge.getUserId()]);
console.log("company devices seen by customer:", [...cst.get(bridge.getUserId()).keys()].length);
const cdev = await cust.getCrypto().getDeviceVerificationStatus(bridge.getUserId(), agentId); console.log("customer view signedByOwner:", cdev?.signedByOwner);
process.exit(0);
