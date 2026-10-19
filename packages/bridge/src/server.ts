import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { loadConfig } from "./config.js";
import { createApp, inboxCsp } from "./http.js";
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
const reconcile = () =>
  reconcileDevices(store, bipe)
    .then(() => store.forgetExpiredMatrixTokens())
    .catch(() => console.error("bridge: device reconcile failed"));
await reconcile();
const reconcileTimer = setInterval(reconcile, RECONCILE_INTERVAL_MS);

const app = createApp(bridge);
// The inbox web app, built into INBOX_DIR, from the same origin as its API.
const inboxDir = process.env.INBOX_DIR;
if (inboxDir) {
  // bipe#407: an enforced CSP on the page and its files. A reverse proxy in front must pass it on, not replace it.
  const csp = inboxCsp(cfg.matrix.homeserverUrl);
  app.use("/*", async (c, next) => {
    await next();
    if (!c.req.path.startsWith("/inbox/") && !c.req.path.startsWith("/v1/")) {
      c.header("content-security-policy", csp);
      // index.html changes with each build; the hashed asset files can be cached.
      if (!c.req.path.startsWith("/assets/")) c.header("cache-control", "no-cache");
    }
  });
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
