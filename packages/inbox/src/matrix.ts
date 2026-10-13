// Bipe in the browser: this agent's own device of the company account (ADR 0076).
// The SDK loads on demand, so the sign-in screen and WhatsApp work even when Bipe is slow or down.

import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";
import { api, ApiError, type MatrixCreds } from "./api.ts";
import { POLL_RESPONSE_TYPES, POLL_START_TYPES, readPoll, readPollResponse } from "./lib.ts";

/** connecting: SDK loading or first sync. ready: synced. offline: sync lost, retrying. failed: could not start. */
export type BipeState = "off" | "connecting" | "ready" | "offline" | "failed";
/** History keys: waiting for the bridge to approve this device, ok, none (no backup), failed. */
export type KeyState = "waiting" | "ok" | "none" | "failed";

export type ChatItem = {
  id: string;
  mine: boolean;
  at: number;
  kind: "text" | "question" | "answer" | "locked";
  body: string;
  options?: string[];
  pending?: boolean;
  /** WhatsApp delivery status, in pt-BR. */
  status?: string;
};

const quiet: any = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, getChild: () => quiet };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function dbPrefix(deviceId: string) {
  return `bipe-inbox-${deviceId}`;
}

class BipeConnection {
  state: BipeState = "off";
  keys: KeyState = "waiting";
  /** Bumps on every change the UI may want to show. */
  version = 0;
  private client: MatrixClient | null = null;
  private creds: MatrixCreds | null = null;
  private listeners = new Set<() => void>();
  private run = 0;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;

  private bump() {
    this.version++;
    for (const l of this.listeners) l();
  }
  private set(state: BipeState) {
    if (this.state === state) return;
    this.state = state;
    this.bump();
  }

  get userId(): string | null {
    return this.creds?.userId ?? null;
  }

  async start(creds: MatrixCreds) {
    if (this.client && this.creds?.deviceId === creds.deviceId) return;
    this.stop();
    const run = ++this.run;
    this.creds = creds;
    this.keys = "waiting";
    this.set("connecting");
    try {
      const sdk = await import("matrix-js-sdk");
      if (run !== this.run) return;
      const client = sdk.createClient({ baseUrl: creds.homeserverUrl, userId: creds.userId, deviceId: creds.deviceId, accessToken: creds.accessToken, logger: quiet });
      this.client = client;
      try {
        // IndexedDB keeps this device's keys across reloads. One database per device.
        await client.initRustCrypto({ cryptoDatabasePrefix: dbPrefix(creds.deviceId) });
      } catch (e) {
        console.warn("inbox: crypto store in IndexedDB failed, keys stay in memory:", (e as Error).message);
        await client.initRustCrypto({ useIndexedDB: false });
      }
      if (run !== this.run) return;
      client.on(sdk.ClientEvent.Sync, (state) => {
        if (state === "PREPARED" || state === "SYNCING") this.set("ready");
        else if (state === "ERROR" || state === "RECONNECTING") this.set(this.state === "connecting" ? "connecting" : "offline");
        else if (state === "STOPPED") this.set("off");
      });
      const changed = () => this.bump();
      client.on(sdk.RoomEvent.Timeline, changed);
      client.on(sdk.RoomEvent.LocalEchoUpdated, changed);
      client.on(sdk.MatrixEventEvent.Decrypted, changed);
      await client.startClient({ initialSyncLimit: 30, lazyLoadMembers: true });
      await this.firstSync(client, run);
      if (run !== this.run) return;
      void this.fetchHistoryKeys(client, run);
    } catch (e) {
      if (run !== this.run) return;
      console.warn("inbox: Bipe did not start:", (e as Error).message);
      this.set("failed");
    }
  }

  private firstSync(client: MatrixClient, run: number) {
    return new Promise<void>((resolve) => {
      const check = () => {
        if (run !== this.run || client.isInitialSyncComplete()) {
          resolve();
          return true;
        }
        return false;
      };
      if (check()) return;
      const t = setInterval(() => check() && clearInterval(t), 300);
    });
  }

  /** The bridge signs this device and hands over the key-backup key, so old chats open here. */
  private async fetchHistoryKeys(client: MatrixClient, run: number) {
    const end = Date.now() + 30_000;
    let backup: { key: string; version: string } | null | undefined;
    while (run === this.run) {
      try {
        backup = (await api.deviceReady()).backup;
        break;
      } catch (e) {
        // 409: this device has not uploaded its keys yet.
        if (!(e instanceof ApiError && e.status === 409) || Date.now() > end) {
          this.keys = "failed";
          this.bump();
          return;
        }
        await sleep(1000);
      }
    }
    if (run !== this.run) return;
    if (!backup) {
      this.keys = "none";
      this.bump();
      return;
    }
    try {
      const crypto = client.getCrypto()!;
      const bytes = Uint8Array.from(atob(backup.key), (c) => c.charCodeAt(0));
      await crypto.storeSessionBackupPrivateKey(bytes, backup.version);
      void crypto
        .restoreKeyBackup()
        .then(() => this.retryDecryption())
        .catch((e) => console.warn("inbox: key backup restore failed:", (e as Error).message));
      await crypto.checkKeyBackupAndEnable();
      this.keys = "ok";
    } catch (e) {
      console.warn("inbox: key backup failed:", (e as Error).message);
      this.keys = "failed";
    }
    this.bump();
  }

  private retryDecryption() {
    const c = this.client;
    if (!c) return;
    for (const room of c.getRooms()) {
      for (const ev of room.getLiveTimeline().getEvents()) {
        if (ev.isDecryptionFailure()) void c.decryptEventIfNeeded(ev, { isRetry: true });
      }
    }
    this.bump();
  }

  stop() {
    this.run++;
    this.client?.stopClient();
    this.client?.removeAllListeners();
    this.client = null;
    this.state = "off";
    this.bump();
  }

  /** Stops and deletes this device's local stores (on sign-out). */
  async clear() {
    const c = this.client;
    const creds = this.creds;
    this.stop();
    this.creds = null;
    if (!creds) return;
    try {
      if (c) await c.clearStores({ cryptoDatabasePrefix: dbPrefix(creds.deviceId) });
      else for (const n of ["matrix-sdk-crypto", "matrix-sdk-crypto-meta"]) indexedDB.deleteDatabase(`${dbPrefix(creds.deviceId)}::${n}`);
    } catch {
      // Nothing more to do: the device is already removed on the server.
    }
  }

  private room(roomId: string): Room | null {
    return this.client?.getRoom(roomId) ?? null;
  }

  hasRoom(roomId: string) {
    return !!this.room(roomId);
  }

  /** The chat as the inbox shows it: text, questions, answers. Encrypted events decrypt as they come. */
  items(roomId: string): ChatItem[] {
    const c = this.client;
    const room = this.room(roomId);
    if (!c || !room) return [];
    const me = this.creds?.userId;
    const out: ChatItem[] = [];
    for (const ev of room.getLiveTimeline().getEvents()) {
      const item = this.toItem(c, room, ev, me);
      if (item) out.push(item);
    }
    return out;
  }

  private toItem(c: MatrixClient, room: Room, ev: MatrixEvent, me: string | undefined): ChatItem | null {
    const base = { id: ev.getId() ?? ev.getTxnId() ?? String(ev.getTs()), mine: ev.getSender() === me, at: ev.getTs(), pending: ev.status !== null && ev.status !== "sent" };
    if (ev.isRedacted()) return null;
    if (ev.getType() === "m.room.encrypted" || ev.isDecryptionFailure()) {
      if (ev.getType() === "m.room.encrypted" && !ev.isDecryptionFailure()) void c.decryptEventIfNeeded(ev);
      return { ...base, kind: "locked", body: "Esta mensagem ainda não abriu neste aparelho. A chave chega pelo backup da empresa." };
    }
    const type = ev.getType();
    const content = ev.getContent();
    if (type === "m.room.message" && typeof content.body === "string") return { ...base, kind: "text", body: content.body };
    if (POLL_START_TYPES.includes(type)) {
      const p = readPoll(content);
      if (p) return { ...base, kind: "question", body: p.question, options: p.answers.map((a) => a.title) };
    }
    if (POLL_RESPONSE_TYPES.includes(type)) {
      const r = readPollResponse(content);
      if (!r) return null;
      const start = room.findEventById(r.pollId);
      const poll = start ? readPoll(start.getContent()) : null;
      const titles = r.answers.map((id) => poll?.answers.find((a) => a.id === id)?.title ?? id);
      return { ...base, kind: "answer", body: `Cliente escolheu: ${titles.join(", ")}` };
    }
    return null;
  }

  canLoadOlder(roomId: string) {
    const room = this.room(roomId);
    return !!room && room.getLiveTimeline().getPaginationToken("b" as any) !== null;
  }

  async loadOlder(roomId: string) {
    const room = this.room(roomId);
    if (!room || !this.client) return;
    await this.client.scrollback(room, 30);
    this.bump();
  }

  /** Sends text from this agent's device. Returns the event ID. */
  async sendText(roomId: string, text: string): Promise<string> {
    if (!this.client || this.state !== "ready") throw new Error("bipe not ready");
    const r = await this.client.sendTextMessage(roomId, text);
    return r.event_id;
  }
}

export const bipe = new BipeConnection();
