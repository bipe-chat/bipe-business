import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { loadConfig } from "./config.js";
import { createApp } from "./http.js";
import { BipeSide } from "./matrix.js";
import { RECONCILE_INTERVAL_MS, reconcileDevices } from "./revoke.js";
import { Bridge } from "./service.js";
import { Store } from "./store.js";

const cfg = loadConfig();
const store = new Store(cfg.dbPath);
const bipe = new BipeSide(cfg.matrix, store);
const bridge = new Bridge(cfg, store, bipe);

if (!cfg.matrix.recoveryKey) console.warn("bridge: BIPE_RECOVERY_KEY is empty. Run `node dist/src/cli.js setup` once, then set it.");
await bipe.start();
// bipe#396: retry removals that Matrix did not confirm, and remove devices whose sessions expired.
const reconcile = () => reconcileDevices(store, bipe).catch(() => console.error("bridge: device reconcile failed"));
await reconcile();
const reconcileTimer = setInterval(reconcile, RECONCILE_INTERVAL_MS);

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
  clearInterval(reconcileTimer);
  server.close();
  await bipe.stop();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
