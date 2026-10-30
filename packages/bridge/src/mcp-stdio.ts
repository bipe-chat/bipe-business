import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { findToken, type Config } from "./config.js";
import { deniedCalls, FORBIDDEN, forbiddenMessage } from "./mcp.js";

/**
 * `bridge mcp` (bipe#437): an MCP server on stdin and stdout for a client on the bridge host.
 * It passes each message to the running bridge's `/mcp` with `BRIDGE_MCP_TOKEN`. The bridge process holds the
 * Matrix client and the database, so this command does not start a second Matrix device.
 * Nothing but MCP messages goes to stdout. Errors go to stderr, without message text or tokens.
 */
export async function runStdioRelay(cfg: Config, io: { stdin?: Readable; stdout?: Writable } = {}): Promise<{ close(): Promise<void> }> {
  if (cfg.mcp.mode === "off") throw new Error("MCP is off: set BRIDGE_MCP=local (or remote) on the bridge");
  const token = findToken(cfg.apiTokens, cfg.mcp.stdioToken);
  if (!token) throw new Error("set BRIDGE_MCP_TOKEN to one of the tokens in BRIDGE_API_TOKENS");

  const down = new StdioServerTransport(io.stdin, io.stdout);
  const up = new StreamableHTTPClientTransport(new URL(cfg.mcp.url), { requestInit: { headers: { authorization: `Bearer ${token.token}` } } });
  const answer = (id: unknown, code: number, message: string) =>
    id === undefined || id === null ? Promise.resolve() : down.send({ jsonrpc: "2.0", id: id as string | number, error: { code, message } });

  down.onmessage = (m: JSONRPCMessage) => {
    const id = (m as { id?: unknown }).id;
    // The same refusal as the HTTP endpoint, without a round trip.
    const denied = deniedCalls(m, token.scopes);
    if (denied.length) return void answer(id, FORBIDDEN, forbiddenMessage(denied[0]!.name));
    up.send(m).catch((e: Error) => {
      console.error("bridge mcp: the bridge did not answer:", e.message.slice(0, 200));
      void answer(id, ErrorCode.InternalError, "the bridge did not answer");
    });
  };
  up.onmessage = (m) => void down.send(m);
  up.onerror = (e) => console.error("bridge mcp:", e.message.slice(0, 200));
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await up.close().catch(() => {});
    await down.close().catch(() => {});
  };
  down.onclose = () => void close();
  await up.start();
  await down.start();
  return { close };
}
