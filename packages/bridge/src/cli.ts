import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { BipeSide } from "./matrix.js";
import { hashPassword } from "./secrets.js";
import { Store } from "./store.js";
import { importTemplates } from "./templates.js";

// Company-side admin commands. Run inside the bridge container: `node dist/src/cli.js <command>`.

const USAGE = `commands:
  setup [--reset]                         cross-signing, secret storage, key backup; prints the recovery key once
  agent add <email> <name> <agent|manager>  reads the password from BRIDGE_NEW_PASSWORD
  agent list
  saved-replies import <file.csv>         columns: shortcut,text (header row)
  templates import <file.json>            WhatsApp message_templates JSON; marketing is refused (ADR 0037)
  templates list`;

const [cmd, sub, ...rest] = process.argv.slice(2);
const cfg = loadConfig();
const store = new Store(cfg.dbPath);

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") row.push(cell), (cell = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell), rows.push(row), (row = []), (cell = "");
    } else cell += ch;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows.filter((r) => r.some((c) => c.trim()));
}

async function main() {
  if (cmd === "setup") {
    const bipe = new BipeSide({ ...cfg.matrix, recoveryKey: "" }, store);
    await bipe.start();
    const key = await bipe.setup({ reset: sub === "--reset" });
    console.log("Recovery key (store it as BIPE_RECOVERY_KEY; it is shown once):");
    console.log(key);
    await bipe.stop();
    process.exit(0);
  }
  if (cmd === "agent" && sub === "add") {
    const [email, name, role] = rest;
    const pw = process.env.BRIDGE_NEW_PASSWORD ?? "";
    if (!email || !name || (role !== "agent" && role !== "manager") || pw.length < 12) throw new Error("agent add <email> <name> <agent|manager>, with BRIDGE_NEW_PASSWORD of 12+ characters");
    const a = store.addAgent({ email, name, role, password_hash: hashPassword(pw) });
    store.audit("agent.add", { detail: a.id });
    console.log(`added ${a.email} (${a.role})`);
    return;
  }
  if (cmd === "agent" && sub === "list") {
    for (const a of store.agents()) console.log(`${a.email}\t${a.name}\t${a.role}\t${a.active ? "active" : "removed"}`);
    return;
  }
  if (cmd === "saved-replies" && sub === "import" && rest[0]) {
    const rows = parseCsv(readFileSync(rest[0], "utf8"));
    const [header, ...data] = rows;
    if (!header || header[0]?.trim().toLowerCase() !== "shortcut") throw new Error("the first row must be: shortcut,text");
    let n = 0;
    for (const r of data) {
      const shortcut = (r[0] ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      const text = (r[1] ?? "").trim();
      if (shortcut && text) store.putSavedReply(shortcut, text), n++;
    }
    console.log(`imported ${n} saved replies`);
    return;
  }
  if (cmd === "templates" && sub === "import" && rest[0]) {
    const r = importTemplates(store, JSON.parse(readFileSync(rest[0], "utf8")));
    for (const d of r.done) console.log(`imported ${d}`);
    for (const d of r.refused) console.log(`refused ${d}`);
    return;
  }
  if (cmd === "templates" && sub === "list") {
    for (const t of store.templates()) console.log(`${t.name}\t${t.language}\t${t.category}`);
    return;
  }
  console.log(USAGE);
  process.exitCode = 1;
}

if (process.argv[1]?.endsWith("cli.js")) {
  main().catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
