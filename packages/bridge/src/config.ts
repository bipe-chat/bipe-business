// Bridge settings. Every value comes from the environment of the company's own server.
// Secrets are never logged.

export type Config = {
  port: number;
  dbPath: string;
  /** Public base URL of this bridge (the company's own domain). */
  publicUrl: string;
  /** Bipe API, to resolve @handles. */
  apiUrl: string;
  matrix: {
    homeserverUrl: string;
    /** The company account: full Matrix ID. */
    userId: string;
    password: string;
    /** Secret storage recovery key from `cli setup`. Unlocks cross-signing and key backup. */
    recoveryKey: string;
    /** The company's @handle. */
    handle: string;
  };
  /** Bearer tokens that the company's own systems use on `/v1/messages`. */
  apiTokens: string[];
  /** Where the bridge sends inbound events for the company's own systems, signed with `Bipe-Signature`. */
  outboundWebhook: null | { url: string; secret: string };
  sessionDays: number;
};

function req(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`missing setting ${name}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 8080),
    dbPath: env.BRIDGE_DB ?? "bridge.sqlite",
    publicUrl: req(env, "BRIDGE_PUBLIC_URL").replace(/\/$/, ""),
    apiUrl: (env.BIPE_API_URL ?? "https://api.bipe.net.br").replace(/\/$/, ""),
    matrix: {
      homeserverUrl: req(env, "BIPE_HOMESERVER_URL").replace(/\/$/, ""),
      userId: req(env, "BIPE_USER_ID"),
      password: req(env, "BIPE_PASSWORD"),
      recoveryKey: env.BIPE_RECOVERY_KEY ?? "",
      handle: req(env, "BIPE_HANDLE").replace(/^@/, ""),
    },
    apiTokens: (env.BRIDGE_API_TOKENS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    outboundWebhook: env.BRIDGE_WEBHOOK_URL
      ? { url: env.BRIDGE_WEBHOOK_URL, secret: req(env, "BRIDGE_WEBHOOK_SECRET") }
      : null,
    sessionDays: Number(env.BRIDGE_SESSION_DAYS ?? 7),
  };
}
