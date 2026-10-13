import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { loadConfig } from "./config.js";
import { createApp } from "./http.js";
import { BipeSide } from "./matrix.js";
import { Bridge } from "./service.js";
import { Store } from "./store.js";
import { WhatsApp } from "./whatsapp.js";

const cfg = loadConfig();
const store = new Store(cfg.dbPath);
const bipe = new BipeSide(cfg.matrix, store);
const wa = cfg.whatsapp ? new WhatsApp(cfg.whatsapp) : null;
const bridge = new Bridge(cfg, store, bipe, wa);

if (!cfg.matrix.recoveryKey) console.warn("bridge: BIPE_RECOVERY_KEY is empty. Run `node dist/src/cli.js setup` once, then set it.");
await bipe.start();

const app = createApp(bridge);
// The inbox web app, built into INBOX_DIR, from the same origin as its API.
const inboxDir = process.env.INBOX_DIR;
if (inboxDir) {
  app.use("/*", serveStatic({ root: inboxDir }));
  app.get("/*", serveStatic({ path: `${inboxDir}/index.html` }));
}

const server = serve({ fetch: app.fetch, port: cfg.port });
console.log(`bridge: listening on ${cfg.port}`);

async function shutdown() {
  server.close();
  await bipe.stop();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
