import { z } from "zod";
import type { Store } from "./store.js";

// The template registry file: a JSON list of { name, language, category, body }.
// Placeholders in `body` are `{1}`, `{2}`. Only utility and authentication (ADR 0037).

const Entry = z.object({
  name: z.string().regex(/^[a-z0-9_]{1,100}$/),
  language: z.string().min(2).max(15),
  category: z.string(),
  body: z.string().min(1).max(4000),
});

/** Imports templates. Returns what was imported and what was refused. */
export function importTemplates(s: Store, json: unknown) {
  const list: unknown[] = Array.isArray(json) ? json : [];
  const done: string[] = [];
  const refused: string[] = [];
  for (const raw of list) {
    const p = Entry.safeParse(raw);
    const name = (raw as { name?: unknown })?.name;
    if (!p.success) {
      refused.push(`${String(name ?? "?")}: needs name (a-z, 0-9, _), language, category and body`);
      continue;
    }
    const t = p.data;
    const label = `${t.name} (${t.language})`;
    const category = t.category.toLowerCase();
    if (category !== "utility" && category !== "authentication") {
      refused.push(`${label}: ${category === "marketing" ? "marketing is not allowed" : "not a utility or authentication template"}`);
      continue;
    }
    s.putTemplate({ name: t.name, language: t.language, category, body: t.body });
    done.push(label);
  }
  return { done, refused };
}
