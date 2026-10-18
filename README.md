# bipe-business

The company's Bipe inbox and API, run by the company. Decisions: ADRs 0069, 0078, 0079, 0081 and 0082 in `bipe-chat/bipe` (`docs/adr/`). Plan: `bipe/docs/business-track.md`.

Status (13 October 2026): pilot slice. Not deployed anywhere.

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

- Billing (waits for the pilot, ADR 0075).
- Pix charge cards (ADR 0080).
- A Bipe-styled question card in the apps. Questions show with Element X's poll view for now.
- Delivered and read statuses for Bipe messages in the company webhook.
- Rotation of room keys after an agent is removed is left to the Matrix clients (unverified, 13 October 2026, whether every client rotates on device removal).
- Login with Bipe's account service (MAS) instead of the account password. The bridge uses the password login that MAS offers for compatibility (unverified on bipe.net.br, 13 October 2026).
