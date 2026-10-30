import { safeEqual } from "./secrets.js";

// Bridge settings. Every value comes from the environment of the company's own server.
// Secrets are never logged.

/**
 * Token scopes (bipe#437). The names are the bridge scopes of bipe-shared `registries/mcp-tools.json`.
 * `content:send` is the old "send": `POST /v1/messages` needs it.
 */
export const SCOPES = ["conversations:read", "conversations:write", "content:read", "content:send", "content:notes"] as const;
export type Scope = (typeof SCOPES)[number];
/** A token with no scope list keeps what every token could do before scopes: send (bipe#437). */
export const LEGACY_SCOPES: readonly Scope[] = ["content:send"];

export type ApiToken = { token: string; scopes: ReadonlySet<Scope> };

/** MCP endpoint (ADR 0130): off, local (stdio and 127.0.0.1 only) or remote (on the public port). */
export type McpMode = "off" | "local" | "remote";

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
  /** Bearer tokens that the company's own systems use on `/v1/messages` and `/mcp`, each with its scopes. */
  apiTokens: ApiToken[];
  mcp: {
    mode: McpMode;
    /** `local`: the MCP listener's port on 127.0.0.1. */
    port: number;
    /** `bridge mcp` (stdio): the token whose scopes the stdio client gets. Must be one of `apiTokens`. */
    stdioToken: string;
    /** `bridge mcp` (stdio): the bridge's MCP URL. Default: the local listener, or the main port for `remote`. */
    url: string;
  };
  /** Where the bridge sends inbound events for the company's own systems, signed with `Bipe-Signature`. */
  outboundWebhook: null | { url: string; secret: string };
  sessionDays: number;
};

function req(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`missing setting ${name}`);
  return v;
}

/**
 * `BRIDGE_API_TOKENS=token:scope1+scope2,token2,...` (bipe#437). The text after the first `:` is the scope list
 * (scope names contain `:`, so a token cannot). A token with no `:` keeps `content:send` only, so setups from
 * before scopes keep working.
 * An unknown scope stops the bridge: a typo must not give a token less, or more, than intended.
 */
export function parseApiTokens(raw: string): ApiToken[] {
  const out: ApiToken[] = [];
  for (const item of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const at = item.indexOf(":");
    if (at < 0) {
      out.push({ token: item, scopes: new Set(LEGACY_SCOPES) });
      continue;
    }
    const token = item.slice(0, at);
    const names = item.slice(at + 1).split("+").map((s) => s.trim()).filter(Boolean);
    if (!token) throw new Error("BRIDGE_API_TOKENS: a token is empty");
    if (!names.length) throw new Error("BRIDGE_API_TOKENS: a token has `:` but no scopes");
    for (const n of names) if (!(SCOPES as readonly string[]).includes(n)) throw new Error(`BRIDGE_API_TOKENS: unknown scope "${n}" (known: ${SCOPES.join(", ")})`);
    out.push({ token, scopes: new Set(names as Scope[]) });
  }
  return out;
}

/** The configured token that matches a Bearer value, compared in constant time. */
export function findToken(tokens: readonly ApiToken[], bearer: string): ApiToken | undefined {
  if (!bearer) return undefined;
  let found: ApiToken | undefined;
  for (const t of tokens) if (safeEqual(t.token, bearer)) found = t;
  return found;
}

export function parseMcpMode(raw: string | undefined): McpMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "off") return "off";
  if (v === "local" || v === "remote") return v;
  throw new Error(`BRIDGE_MCP must be off, local or remote, not "${raw}"`);
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
    apiTokens: parseApiTokens(env.BRIDGE_API_TOKENS ?? ""),
    mcp: mcpConfig(env),
    outboundWebhook: env.BRIDGE_WEBHOOK_URL
      ? { url: env.BRIDGE_WEBHOOK_URL, secret: req(env, "BRIDGE_WEBHOOK_SECRET") }
      : null,
    sessionDays: Number(env.BRIDGE_SESSION_DAYS ?? 7),
  };
}

function mcpConfig(env: NodeJS.ProcessEnv): Config["mcp"] {
  const mode = parseMcpMode(env.BRIDGE_MCP);
  const port = Number(env.BRIDGE_MCP_PORT ?? 8081);
  const mainPort = Number(env.PORT ?? 8080);
  return {
    mode,
    port,
    stdioToken: env.BRIDGE_MCP_TOKEN ?? "",
    url: (env.BRIDGE_MCP_URL ?? `http://127.0.0.1:${mode === "remote" ? mainPort : port}/mcp`).replace(/\/$/, ""),
  };
}
