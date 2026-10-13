import type { Store } from "./store.js";

/** Imports WhatsApp templates. Returns what was imported and what was refused. */
export function importTemplates(s: Store, json: any) {
  const list: any[] = Array.isArray(json) ? json : (json?.data ?? []);
  const done: string[] = [];
  const refused: string[] = [];
  for (const t of list) {
    const category = String(t.category ?? "").toLowerCase();
    const body = (t.components ?? []).find((c: any) => String(c.type).toUpperCase() === "BODY")?.text;
    const label = `${t.name} (${t.language})`;
    if ((category !== "utility" && category !== "authentication") || !body || !t.name || !t.language) {
      refused.push(`${label}: ${category === "marketing" ? "marketing is not allowed" : "not a utility or authentication template"}`);
      continue;
    }
    s.putTemplate({ name: String(t.name), language: String(t.language), category, body: String(body) });
    done.push(label);
  }
  return { done, refused };
}
