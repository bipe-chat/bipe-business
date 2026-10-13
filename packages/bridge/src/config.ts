// Bridge settings. Every value comes from the environment of the company's own server.
// Secrets are never logged.

export type Config = {
  port: number;
  dbPath: string;
  /** Public base URL of this bridge (the company's own domain). */
  publicUrl: string;
  /** Bipe public site, for link-code pages. */
  siteUrl: string;
  /** Bipe API, to resolve @handles on the Cloud API paths. */
  apiUrl: string;
  matrix: {
    homeserverUrl: string;
    /** The company account: full Matrix ID. */
    userId: string;
    password: string;
    /** Secret storage recovery key from `cli setup`. Unlocks cross-signing and key backup. */
    recoveryKey: string;
    /** The company's @handle, for link-code URLs. */
    handle: string;
  };
  /** Bearer tokens that the company's own systems use on the Cloud API paths. */
  apiTokens: string[];
  /** The phone-number-id the Cloud API paths use for the Bipe channel. */
  bipePhoneNumberId: string;
  whatsapp: null | {
    phoneNumberId: string;
    accessToken: string;
    appSecret: string;
    verifyToken: string;
    graphUrl: string;
    graphVersion: string;
  };
  /** Where the bridge forwards inbound messages for the company's own systems, Cloud API webhook shape. */
  outboundWebhook: null | { url: string; secret: string };
  sessionDays: number;
};

function req(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`missing setting ${name}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const wa = env.WA_PHONE_NUMBER_ID
    ? {
        phoneNumberId: env.WA_PHONE_NUMBER_ID,
        accessToken: req(env, "WA_ACCESS_TOKEN"),
        appSecret: req(env, "WA_APP_SECRET"),
        verifyToken: req(env, "WA_VERIFY_TOKEN"),
        graphUrl: (env.WA_GRAPH_URL ?? "https://graph.facebook.com").replace(/\/$/, ""),
        graphVersion: env.WA_GRAPH_VERSION ?? "v23.0",
      }
    : null;
  return {
    port: Number(env.PORT ?? 8080),
    dbPath: env.BRIDGE_DB ?? "bridge.sqlite",
    publicUrl: req(env, "BRIDGE_PUBLIC_URL").replace(/\/$/, ""),
    siteUrl: (env.BIPE_SITE_URL ?? "https://bipe.chat").replace(/\/$/, ""),
    apiUrl: (env.BIPE_API_URL ?? "https://api.bipe.net.br").replace(/\/$/, ""),
    matrix: {
      homeserverUrl: req(env, "BIPE_HOMESERVER_URL").replace(/\/$/, ""),
      userId: req(env, "BIPE_USER_ID"),
      password: req(env, "BIPE_PASSWORD"),
      recoveryKey: env.BIPE_RECOVERY_KEY ?? "",
      handle: req(env, "BIPE_HANDLE").replace(/^@/, ""),
    },
    apiTokens: (env.BRIDGE_API_TOKENS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    bipePhoneNumberId: env.BIPE_PHONE_NUMBER_ID ?? "bipe",
    whatsapp: wa,
    outboundWebhook: env.BRIDGE_WEBHOOK_URL
      ? { url: env.BRIDGE_WEBHOOK_URL, secret: req(env, "BRIDGE_WEBHOOK_SECRET") }
      : null,
    sessionDays: Number(env.BRIDGE_SESSION_DAYS ?? 7),
  };
}
