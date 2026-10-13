# bipe-business

One inbox for Bipe and WhatsApp, run by the company. Decisions: ADRs 0069, 0078, 0079 and 0081 in `bipe-chat/bipe` (`docs/adr/`). Plan: `bipe/docs/business-track.md`.

Status (13 October 2026): pilot slice. Not deployed anywhere.

## Parts

| Package | What it does |
|---|---|
| `packages/bridge` | Runs on the company's server. Holds the company's Bipe account, signs agent devices, receives WhatsApp webhooks, accepts the Cloud API request shape, serves the inbox and its API. |
| `packages/inbox` | Web app for agents and managers. Each signed-in browser is a Matrix device of the company account, so Bipe chats are decrypted in the browser, never on Bipe's servers. |

## How the keys work (ADR 0078)

1. The company has one Bipe account. `cli setup` creates its cross-signing keys, secret storage and key backup, and shows the recovery key once.
2. The bridge starts a fresh device of that account at each start. It unlocks cross-signing and the backup key with the recovery key.
3. An agent signs in to the inbox. The bridge logs in a new device for that browser. The browser uploads its keys. The bridge signs the device and gives the browser the backup key, so the agent can read past chats.
4. Removing an agent deletes that agent's devices.

Bipe chat content is never written to the bridge's database. WhatsApp messages are, because WhatsApp keeps no history the inbox could read later.

## The API for the company's own systems

Same shape as Meta's Cloud API. Change the base URL and the token.

```
POST https://<bridge>/v23.0/<phone-number-id>/messages
Authorization: Bearer <one of BRIDGE_API_TOKENS>
```

- `<phone-number-id>` = your WhatsApp number ID: passed to Meta as is.
- `<phone-number-id>` = `bipe` (`BIPE_PHONE_NUMBER_ID`): sent on Bipe. `to` is the customer's @handle, Matrix ID, room ID or inbox conversation ID. The customer must have written first (error `131047` otherwise).
- Types: `text`, `template` (from the bridge's template registry: utility and authentication only), `interactive` (`button` with up to 3 reply buttons, or `list` with up to 10 rows).
- On Bipe an `interactive` message becomes a single-choice poll (ADR 0081). The customer's tap comes back to `BRIDGE_WEBHOOK_URL` as a Cloud API `button_reply` or `list_reply` message, with `context.id` set to the question's message ID.

Inbound messages from both channels go to `BRIDGE_WEBHOOK_URL` in the Cloud API webhook shape, signed with `X-Hub-Signature-256` (HMAC-SHA256 of the body with `BRIDGE_WEBHOOK_SECRET`). On Bipe, `messaging_product` is `bipe` and `wa_id` is the customer's Matrix ID.

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

Put HTTPS in front of port 8080. Point Meta's webhook at `https://<bridge>/webhooks/whatsapp` with `WA_VERIFY_TOKEN`.

Other CLI commands: `agent list`, `saved-replies import <file.csv>` (columns `shortcut,text`), `templates import <file.json>` (Meta's `message_templates` export; marketing is refused), `templates list`.

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
