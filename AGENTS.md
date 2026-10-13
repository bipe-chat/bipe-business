# bipe-business: agent notes

The business bridge and inbox (ADRs 0069, 0078, 0079, 0081, 0082 in `../bipe/docs/adr/`). It runs at the company, not at Bipe.

- Stack: Node 24 (22.13+ works), TypeScript, Hono, Zod, matrix-js-sdk with Rust crypto, `node:sqlite`. pnpm only. Exact versions in package.json.
- Green gate: `pnpm build && pnpm test`. The bridge's end-to-end test runs only with `BIPE_TEST_HS` set (README).
- Never store chat content in the bridge database. Store only what the inbox needs to route: IDs, times, assignee, status, tags, notes, audit (event IDs, never text).
- Never log message text, tokens, passwords, the recovery key or the backup key.
- The company writes only to customers who wrote first (no cold messages). Templates are utility or authentication only; marketing is refused (ADR 0037).
- The API for the company's own systems (`POST /v1/messages`, the signed webhook) is Bipe's own design (ADR 0082). Change it only with an ADR.
- No closed messaging platform's API, SDK, login or tracking pixel, and no claim of compatibility with one, in code, comments, docs or commit messages (ADR 0082). This repo will be opened.
- Bipe contacts are shown by name and Matrix ID, never by phone number (ADR 0015, ADR 0063).
- pt-BR copy follows `../bipe/docs/design/linguagem.md`.
- Write docs in ASD-STE100 style.

## Decisions

Product and architecture decisions for all Bipe repos are ADRs in the umbrella repo: `../bipe/docs/adr/` (index: `README.md`). Check them before changing a decided behaviour. A new decision gets an ADR there, not a note in this repo.
