import * as sdk from "matrix-js-sdk";
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/index.js";
import type { Config } from "./config.js";
import type { Option } from "./api.js";

// The Bipe side of the bridge (ADR 0035, ADR 0078).
// One company account. The bridge is one device of it. Each inbox agent is another device.
// The bridge holds the cross-signing keys (unlocked from secret storage with the recovery key),
// signs agent devices, and hands the key-backup key to them so they can read past chats.
// Crypto state is in memory: the bridge logs in a fresh device at each start and removes the old one.

const BRIDGE_DEVICE_NAME = "Bipe bridge";

export type BipeInbound =
  | { kind: "text"; roomId: string; eventId: string; sender: string; senderName: string | null; at: number; body: string; fromCompany: boolean; deviceId: string | null }
  | { kind: "answer"; roomId: string; eventId: string; sender: string; senderName: string | null; at: number; questionId: string; optionIds: string[] }
  | { kind: "invite"; roomId: string; sender: string; senderName: string | null; at: number };

export type Persist = { get(k: string): string | undefined; set(k: string, v: string): void };

export class BipeSide {
  client!: sdk.MatrixClient;
  private handlers: ((e: BipeInbound) => void | Promise<void>)[] = [];
  /** The new secret storage key during `setup`, before it is shown to the company. */
  private newKey: Uint8Array<ArrayBuffer> | null = null;
  private startedAt = 0;

  constructor(
    private readonly cfg: Config["matrix"],
    private readonly persist: Persist,
  ) {}

  onEvent(h: (e: BipeInbound) => void | Promise<void>) {
    this.handlers.push(h);
  }

  get userId() {
    return this.cfg.userId;
  }

  /** The bridge device's access token, for the Bipe API (handle lookups). */
  get accessToken(): string {
    return this.client?.getAccessToken() ?? "";
  }

  private passwordAuth(session?: string) {
    return { type: "m.login.password", identifier: { type: "m.id.user", user: this.cfg.userId }, password: this.cfg.password, ...(session ? { session } : {}) };
  }

  /** Logs in a new device of the company account. Used for the bridge and for each inbox agent. */
  async login(displayName: string): Promise<{ accessToken: string; deviceId: string; userId: string }> {
    const c = sdk.createClient({ baseUrl: this.cfg.homeserverUrl });
    const r = await c.loginRequest({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: this.cfg.userId },
      password: this.cfg.password,
      initial_device_display_name: displayName,
    });
    return { accessToken: r.access_token, deviceId: r.device_id, userId: r.user_id };
  }

  /** Deletes a device of the company account (user-interactive auth with the account password). */
  async deleteDevice(deviceId: string) {
    try {
      await this.client.deleteDevice(deviceId, this.passwordAuth());
    } catch (e: any) {
      const session = e?.data?.session;
      if (e?.httpStatus === 401 && session) await this.client.deleteDevice(deviceId, this.passwordAuth(session));
      else if (e?.httpStatus !== 404) throw e;
    }
  }

  private cryptoCallbacks(): sdk.ICreateClientOpts["cryptoCallbacks"] {
    const key = this.cfg.recoveryKey;
    return {
      getSecretStorageKey: async ({ keys }) => {
        const id = Object.keys(keys)[0];
        if (!id) return null;
        if (this.newKey) return [id, this.newKey];
        return key ? [id, decodeRecoveryKey(key)] : null;
      },
    };
  }

  /** Starts the bridge device and its sync loop. */
  async start(): Promise<void> {
    const login = await this.login(BRIDGE_DEVICE_NAME);
    this.client = sdk.createClient({
      baseUrl: this.cfg.homeserverUrl,
      accessToken: login.accessToken,
      userId: login.userId,
      deviceId: login.deviceId,
      cryptoCallbacks: this.cryptoCallbacks(),
      logger: quietLogger,
    });
    // Remove bridge devices left by earlier runs.
    const old: string[] = JSON.parse(this.persist.get("bridge_devices") ?? "[]");
    for (const d of old) await this.deleteDevice(d).catch(() => {});
    this.persist.set("bridge_devices", JSON.stringify([login.deviceId]));

    await this.client.initRustCrypto({ useIndexedDB: false });
    this.startedAt = Date.now();
    this.client.on(sdk.RoomMemberEvent.Membership, (_ev, m) => {
      if (m.userId !== this.cfg.userId || m.membership !== "invite") return;
      const room = this.client.getRoom(m.roomId);
      const inviter = m.events.member?.getSender() ?? "";
      const name = room?.getMember(inviter)?.name ?? null;
      void this.emit({ kind: "invite", roomId: m.roomId, sender: inviter, senderName: name, at: Date.now() });
    });
    this.client.on(sdk.RoomEvent.Timeline, (ev, room, toStart, _removed, data) => {
      if (toStart || !data?.liveEvent || !room) return;
      void this.handleTimeline(ev, room);
    });
    await this.client.startClient({ initialSyncLimit: 20, lazyLoadMembers: true });
    await new Promise<void>((res) => {
      if (this.client.isInitialSyncComplete()) return res();
      const on = (state: string) => {
        if (state === "PREPARED" || state === "SYNCING") {
          this.client.off(sdk.ClientEvent.Sync, on);
          res();
        }
      };
      this.client.on(sdk.ClientEvent.Sync, on);
    });
    if (this.cfg.recoveryKey) await this.unlock();
    // Invites that arrived while the bridge was down.
    for (const room of this.client.getRooms()) {
      if (room.getMyMembership() === "invite") {
        const inviter = room.getMember(this.cfg.userId)?.events.member?.getSender() ?? "";
        void this.emit({ kind: "invite", roomId: room.roomId, sender: inviter, senderName: room.getMember(inviter)?.name ?? null, at: Date.now() });
      }
    }
  }

  /** Loads cross-signing and the backup key from secret storage, and signs the bridge device. */
  private async unlock() {
    const crypto = this.client.getCrypto()!;
    // The new device must know the account's public cross-signing keys before it imports the private ones.
    if (!(await crypto.userHasCrossSigningKeys(this.cfg.userId, true))) throw new Error("the company account has no cross-signing keys: run setup");
    await crypto.bootstrapCrossSigning({});
    await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
    await crypto.checkKeyBackupAndEnable();
  }

  /** First-time setup: cross-signing, secret storage and key backup. Returns the recovery key once. */
  async setup(opts: { reset: boolean }): Promise<string> {
    const crypto = this.client.getCrypto()!;
    let recoveryKey = "";
    await crypto.bootstrapCrossSigning({
      setupNewCrossSigning: opts.reset,
      authUploadDeviceSigningKeys: async (make) => {
        await make(this.passwordAuth() as any);
      },
    });
    await crypto.bootstrapSecretStorage({
      setupNewSecretStorage: opts.reset,
      setupNewKeyBackup: true,
      createSecretStorageKey: async () => {
        const k = await crypto.createRecoveryKeyFromPassphrase();
        recoveryKey = k.encodedPrivateKey ?? "";
        this.newKey = new Uint8Array(k.privateKey);
        return k;
      },
    });
    this.newKey = null;
    if (!recoveryKey) throw new Error("secret storage already exists: run setup --reset to make a new recovery key");
    return recoveryKey;
  }

  async stop() {
    this.client?.stopClient();
  }

  /** Signs an agent device with the company's self-signing key. Call after the device uploaded its keys. */
  async signDevice(deviceId: string): Promise<boolean> {
    const crypto = this.client.getCrypto()!;
    const devices = await crypto.getUserDeviceInfo([this.cfg.userId], true);
    if (!devices.get(this.cfg.userId)?.has(deviceId)) return false;
    await crypto.crossSignDevice(deviceId);
    return true;
  }

  /** The key-backup key and version, for an agent device (ADR 0078). */
  async backupKey(): Promise<{ key: string; version: string } | null> {
    const crypto = this.client.getCrypto()!;
    const key = await crypto.getSessionBackupPrivateKey();
    const version = await crypto.getActiveSessionBackupVersion();
    if (!key || !version) return null;
    return { key: Buffer.from(key).toString("base64"), version };
  }

  async join(roomId: string) {
    await this.client.joinRoom(roomId);
  }

  async sendText(roomId: string, body: string): Promise<string> {
    const r = await this.client.sendEvent(roomId, sdk.EventType.RoomMessage, { msgtype: sdk.MsgType.Text, body });
    return r.event_id;
  }

  /** A structured question as a single-choice poll (ADR 0081), with a numbered text fallback. */
  async sendQuestion(roomId: string, question: string, options: Option[], fallback: string): Promise<string> {
    const start = {
      kind: "org.matrix.msc3381.poll.disclosed",
      max_selections: 1,
      question: { "org.matrix.msc1767.text": question, body: question, msgtype: "m.text" },
      answers: options.map((o) => ({ id: o.id, "org.matrix.msc1767.text": o.label })),
    };
    const content = { "org.matrix.msc3381.poll.start": start, "org.matrix.msc1767.text": fallback, body: fallback };
    const r = await this.client.sendEvent(roomId, "org.matrix.msc3381.poll.start" as any, content as any);
    this.persist.set(`poll:${r.event_id}`, JSON.stringify(options));
    return r.event_id;
  }

  questionOptions(eventId: string): Option[] | null {
    const s = this.persist.get(`poll:${eventId}`);
    return s ? JSON.parse(s) : null;
  }

  displayName(roomId: string, userId: string): string | null {
    return this.client.getRoom(roomId)?.getMember(userId)?.name ?? null;
  }

  private async handleTimeline(ev: sdk.MatrixEvent, room: sdk.Room) {
    await this.client.decryptEventIfNeeded(ev);
    const lastTs = Number(this.persist.get("last_ts") ?? 0);
    const ts = ev.getTs();
    if (ts <= lastTs && ts < this.startedAt) return;
    if (ts > lastTs) this.persist.set("last_ts", String(ts));
    const sender = ev.getSender() ?? "";
    const type = ev.getType();
    const content = ev.getContent();
    const base = { roomId: room.roomId, eventId: ev.getId() ?? "", sender, senderName: room.getMember(sender)?.name ?? null, at: ts };
    if (type === "m.room.message" && typeof content.body === "string") {
      const fromCompany = sender === this.cfg.userId;
      const deviceId = fromCompany ? ((ev.getWireContent() as any)?.device_id ?? null) : null;
      if (fromCompany && deviceId === this.client.getDeviceId()) return;
      await this.emit({ kind: "text", ...base, body: content.body, fromCompany, deviceId });
      return;
    }
    if (type === "m.poll.response" || type === "org.matrix.msc3381.poll.response") {
      if (sender === this.cfg.userId) return;
      const rel = content["m.relates_to"];
      const answers = content["m.poll.response"]?.answers ?? content["org.matrix.msc3381.poll.response"]?.answers;
      if (rel?.event_id && Array.isArray(answers)) await this.emit({ kind: "answer", ...base, questionId: rel.event_id, optionIds: answers.map(String) });
    }
  }

  private async emit(e: BipeInbound) {
    for (const h of this.handlers) {
      try {
        await h(e);
      } catch (err) {
        console.error("bridge: event handler failed:", (err as Error).message);
      }
    }
  }
}

// matrix-js-sdk logs every request at debug level. The bridge keeps warnings and errors only.
const noop = () => {};
const quietLogger: any = {
  trace: noop,
  debug: noop,
  info: noop,
  warn: (...a: unknown[]) => console.warn(...a),
  error: (...a: unknown[]) => console.error(...a),
  getChild: () => quietLogger,
};
