# bipe-business

The company's Bipe inbox and API, run by the company. Decisions: ADRs 0069, 0078, 0079, 0081 and 0082 in `bipe-chat/bipe` (`docs/adr/`). Plan: `bipe/docs/business-track.md`.

Status (13 October 2026): pilot slice. Not deployed anywhere. MCP endpoint added 30 October 2026 (bipe#437).

## Parts

| Package | What it does |
|---|---|
| `packages/bridge` | Runs on the company's server. Holds the company's Bipe account, signs agent devices, serves the inbox, and serves the API for the company's own systems. |
| `packages/inbox` | Web app for agents and managers. Each signed-in browser is a Matrix device of the company account, so Bipe chats are decrypted in the browser, never on Bipe's servers. |

## How the keys work (ADR 0078)

1. The company has one Bipe account. `cli setup` creates its cross-signing keys, secret storage and key backup, and shows the recovery key once.
2. The bridge starts a fresh device of that account at each start. It unlocks cross-signing and the backup key with the recovery key.
3. An agent signs in to the inbox. The bridge logs in a new device for that browser. The browser uploads its keys. The bridge signs the device and gives the browser the backup key, so the agent can read past chats.
4. Removing an agent deletes that agent's devices. A removal, a logout or an expired session ends the bridge session at once. The Matrix device stays in the list as "Remoção pendente" until Matrix confirms the delete; the bridge retries at start and every 5 minutes (bipe#396).

Chat content is never written to the bridge's database. It stays end-to-end encrypted in Matrix.

## The API for the company's own systems

```
POST https://<bridge>/v1/messages
Authorization: Bearer <one of BRIDGE_API_TOKENS>
Content-Type: application/json

{ "to": "@ana", "text": "Seu pedido saiu para entrega." }
```

- The token needs the scope `content:send`. A token with no scope list has it (see Token scopes).
- `to`: the customer's @handle, Matrix ID, room ID, or the inbox conversation ID. The customer must have written first (error `customer_must_write_first` otherwise).
- Send exactly one of:
  - `text`: a string.
  - `template`: `{ "name", "language", "params": [] }`, from the bridge's template registry. Utility and authentication only (ADR 0037). `params` fill `{1}`, `{2}`.
  - `question`: `{ "text", "options": [{ "id", "label", "detail"? }] }`, 2 to 10 options (ADR 0081). The customer sees a single-choice poll.
- Answer: `{ "id": "<event ID>", "conversation": "<conversation ID>", "customer": "<Matrix ID>" }`.
- Errors: `{ "error": { "code", "message" } }`. Codes: `unauthorized`, `invalid_request`, `unknown_handle`, `customer_must_write_first`, `unknown_template`, `invalid_question`, `not_found`, `internal`.

### Webhook

Inbound events go to `BRIDGE_WEBHOOK_URL` as JSON:

```
{ "id": "<event ID>", "type": "message", "at": "2026-10-13T12:00:00.000Z",
  "conversation": "<conversation ID>", "customer": { "id": "@ana:bipe.net.br", "name": "Ana" },
  "text": "Meu pedido não chegou" }
```

A tap on a question has `"type": "answer"` and `"answer": { "question": "<event ID>", "option": "<id>", "label": "<label>" }` instead of `text`.

Each request has the header `Bipe-Signature: t=<unix seconds>,v1=<hex>`. `v1` is HMAC-SHA256 of `<t>.<raw body>` with `BRIDGE_WEBHOOK_SECRET`. Check it, and refuse a `t` more than 5 minutes from your clock. The bridge retries after 1, 5 and 30 seconds on a network error, a 429 or a 5xx.

### Templates

`templates import <file.json>` reads a list of `{ "name", "language", "category", "body" }`. `name` uses a to z, 0 to 9 and `_`. `category` is `utility` or `authentication`; the bridge refuses anything else.

### Token scopes

`BRIDGE_API_TOKENS` is a comma-separated list. Each item is `token` or `token:scope1+scope2`. The text after the first `:` is the scope list, so a token must not contain `:`.

| Scope | Gives |
|---|---|
| `conversations:read` | MCP `list_conversations`: status, assignee, tags, times. No text. |
| `conversations:write` | MCP `assign`, `set_status`, `tag`. |
| `content:read` | MCP `read_conversation`: message text. |
| `content:send` | `POST /v1/messages`, MCP `send_message` and `send_question`. |
| `content:notes` | MCP `add_note`. |

- A token with no scope list gets `content:send` only. Setups from before scopes keep working.
- A token without `content:send` gets 403 on `POST /v1/messages`.
- An unknown scope name stops the bridge at start.

Example: `BRIDGE_API_TOKENS=erp-token,assistant-token:conversations:read+conversations:write`

## MCP for AI assistants (ADR 0130, bipe#437)

The bridge can serve the Model Context Protocol (MCP), so an AI assistant can work the inbox. The tools are the `bridge` rows of bipe-shared `registries/mcp-tools.json`, copied to `packages/bridge/src/mcp-tools.json`.

| Tool | Scope | What it does |
|---|---|---|
| `list_conversations` | `conversations:read` | Lists conversations: status, assignee, tags, times. No text. |
| `read_conversation` | `content:read` | Reads the newest messages of one conversation. |
| `send_message` | `content:send` | Sends text or a template to a customer. |
| `send_question` | `content:send` | Sends a question with answer buttons. |
| `assign` | `conversations:write` | Assigns a conversation to an agent (ID or email), or removes the assignee. |
| `set_status` | `conversations:write` | Sets `open`, `waiting` or `solved`. |
| `tag` | `conversations:write` | Adds or removes one tag. |
| `add_note` | `content:notes` | Adds an internal note. The customer never sees it. |

Rules:

- `BRIDGE_MCP=off` is the default. Then the bridge serves no MCP.
- Choose `BRIDGE_MCP=local`. The bridge then serves `/mcp` on `127.0.0.1:BRIDGE_MCP_PORT` (default 8081) only, and `node dist/src/cli.js mcp` serves MCP on stdin and stdout. The local listener refuses a request whose `Host` is not `127.0.0.1` or `localhost`.
- `BRIDGE_MCP=remote` serves `/mcp` on the public port, next to `/v1/messages`. Use it only when the assistant cannot run on the bridge host. Put HTTPS in front.
- Every MCP request needs `Authorization: Bearer <token>`. The client sees only the tools that the token's scopes allow. A call to another tool gets HTTP 403 (JSON-RPC error `-32003`), and the audit records `mcp.denied`.
- The bridge reads message text from its own Matrix client for each `read_conversation` call. It does not store the text.
- A message from `send_message` or `send_question` carries `"chat.bipe.assistant": {"client": "<MCP client name>"}`, so the customer's app shows that a program answers (ADR 0035). The customer must have written first, as on `POST /v1/messages`.
- The audit records each call as `mcp.<tool>` with the conversation ID and the event ID. It never records text.
- When MCP is on and a token has a `content:` scope, the bridge logs one line at start: content can leave this server to the model that the MCP client uses. That model can be outside Brazil. The company chooses the model and is responsible for that transfer (ADR 0130).

### Connect a client on the bridge host (stdio, recommended)

Settings: `BRIDGE_MCP=local`, a token in `BRIDGE_API_TOKENS` with the scopes you want, and the same token in `BRIDGE_MCP_TOKEN`. The `mcp` command sends each message to the running bridge, so the bridge must run.

```json
{
  "mcpServers": {
    "bipe-inbox": {
      "command": "docker",
      "args": ["exec", "-i", "<bridge container>", "node", "dist/src/cli.js", "mcp"]
    }
  }
}
```

Without Docker, use `"command": "node", "args": ["/path/to/packages/bridge/dist/src/cli.js", "mcp"]` with the same environment as the bridge.

### Connect a client over HTTP

```json
{
  "mcpServers": {
    "bipe-inbox": {
      "type": "http",
      "url": "http://127.0.0.1:8081/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

With `BRIDGE_MCP=remote`, the URL is `https://<bridge>/mcp`.

## Run it

```
cp packages/bridge/.env.example .env      # fill it in
docker build -f packages/bridge/Dockerfile -t bipe-business-bridge .
docker run --rm --env-file .env -v bridge-data:/data bipe-business-bridge node dist/src/cli.js setup
#   put the printed recovery key in .env as BIPE_RECOVERY_KEY
BRIDGE_NEW_PASSWORD='…' docker run --rm --env-file .env -e BRIDGE_NEW_PASSWORD -v bridge-data:/data bipe-business-bridge \
  node dist/src/cli.js agent add gerente@suaempresa.com.br "Nome" manager
docker run -d --env-file .env -v bridge-data:/data -p 8080:8080 bipe-business-bridge
```

Put HTTPS in front of port 8080.

Other CLI commands: `agent list`, `saved-replies import <file.csv>` (columns `shortcut,text`), `templates import <file.json>` (see Templates), `templates list`.

## Inbox session and browser security (bipe#407)

- The bridge session is the cookie `bipe_inbox_session`: HttpOnly, Secure, SameSite=Strict, path `/inbox`. Page scripts cannot read it. Serve the inbox over HTTPS.
- A write with the cookie needs the header `x-bipe-inbox: 1` and, when the browser sends `Origin`, the bridge's own host. Login needs the header too. Behind a reverse proxy, pass `Host` (or `X-Forwarded-Host`) unchanged.
- The inbox's Matrix access token stays in the bridge database with its session. The inbox reads it from `GET /inbox/session` after each page load and keeps it in memory only. An expired session loses its token on the next device reconcile. Logout deletes the session and the cookie.
- The Matrix client needs the token while it runs, so a script that runs in the page can still use it. The CSP lowers that risk; it does not remove it. The device's encrypted crypto store stays in IndexedDB, as before.
- The inbox page and its files carry an enforced Content Security Policy (`inboxCsp()` in `packages/bridge/src/http.ts`): scripts from the bridge only, WebAssembly for the Rust crypto, connections to the bridge and the homeserver only, no frames. A reverse proxy must pass the header on and must not add a weaker one.
- A browser with a session from an older build (in localStorage) loses it once and signs in again.

## Develop

```
pnpm install
pnpm build
pnpm test
```

The bridge's end-to-end test needs a homeserver with open registration:

```
python3 -m venv syn && syn/bin/pip install matrix-synapse
syn/bin/python -m synapse.app.homeserver --server-name localhost -c hs.yaml --generate-config --report-stats=no
# in hs.yaml: enable_registration: true, enable_registration_without_verification: true, high rc_* limits, bind 127.0.0.1 only
syn/bin/python -m synapse.app.homeserver -c hs.yaml &
BIPE_TEST_HS=http://127.0.0.1:8008 pnpm --filter ./packages/bridge test
```

## Not built yet

- The program marker on messages that `POST /v1/messages` sends. Only MCP sends carry `chat.bipe.assistant` now.
- Showing the `chat.bipe.assistant` label in the Bipe apps for business messages (the apps label it for personal assistant sends, bipe-shared `docs/mcp.md`).
- Billing (waits for the pilot, ADR 0075).
- Pix charge cards (ADR 0080).
- A Bipe-styled question card in the apps. Questions show with Element X's poll view for now.
- Delivered and read statuses for Bipe messages in the company webhook.
- Rotation of room keys after an agent is removed is left to the Matrix clients (unverified, 13 October 2026, whether every client rotates on device removal).
- Login with Bipe's account service (MAS) instead of the account password. The bridge uses the password login that MAS offers for compatibility (unverified on bipe.net.br, 13 October 2026).
