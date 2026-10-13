// Pure helpers. No imports, no DOM: the tests run this file directly with Node.

export type Channel = "bipe" | "whatsapp";
export type Status = "open" | "waiting" | "solved" | "moved";

export const STATUS_LABEL: Record<Status, string> = {
  open: "Aberta",
  waiting: "Esperando cliente",
  solved: "Resolvida",
  moved: "Continuou no Bipe",
};

export const CHANNEL_LABEL: Record<Channel, string> = { bipe: "Bipe", whatsapp: "WhatsApp" };

// ------------------------------------------------------------------ structured questions

/** Limits from the Cloud API shape the bridge checks (packages/bridge/src/cloudapi.ts). */
export const QUESTION = {
  minOptions: 2,
  maxOptions: 10,
  maxButtons: 3,
  buttonTitle: 20,
  rowTitle: 24,
  buttonBody: 1024,
  listBody: 4096,
  idMax: 200,
  listButton: "Ver opções",
} as const;

/** Max option title length for a question with `count` options. */
export function titleLimit(count: number): number {
  return count <= QUESTION.maxButtons ? QUESTION.buttonTitle : QUESTION.rowTitle;
}

/** "Outro dia!" -> "outro-dia". Accents go, anything else becomes a dash. */
export function slugify(title: string): string {
  const s = title
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, QUESTION.idMax - 4);
  return s || "opcao";
}

/** Option IDs from titles: slugified and unique ("sim", "sim-2"). */
export function optionIds(titles: string[]): string[] {
  const seen = new Map<string, number>();
  return titles.map((t) => {
    const base = slugify(t);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}

/** Problems with a question, in pt-BR, for the dialog. Empty when the question is good to send. */
export function questionProblems(text: string, options: string[]): string[] {
  const out: string[] = [];
  const opts = options.map((o) => o.trim());
  const body = text.trim();
  const limit = titleLimit(opts.length);
  const bodyMax = opts.length <= QUESTION.maxButtons ? QUESTION.buttonBody : QUESTION.listBody;
  if (!body) out.push("Escreva a pergunta.");
  else if (body.length > bodyMax) out.push(`A pergunta tem mais de ${bodyMax} caracteres.`);
  if (opts.length < QUESTION.minOptions) out.push(`Coloque pelo menos ${QUESTION.minOptions} opções.`);
  if (opts.length > QUESTION.maxOptions) out.push(`Coloque no máximo ${QUESTION.maxOptions} opções.`);
  if (opts.some((o) => !o)) out.push("Tem uma opção vazia.");
  opts.forEach((o, i) => {
    if (o.length > limit) out.push(`A opção ${i + 1} tem mais de ${limit} caracteres.`);
  });
  const lower = opts.filter(Boolean).map((o) => o.toLocaleLowerCase("pt-BR"));
  if (new Set(lower).size !== lower.length) out.push("Duas opções têm o mesmo texto.");
  return out;
}

export type InteractiveButton = {
  type: "button";
  body: { text: string };
  action: { buttons: { type: "reply"; reply: { id: string; title: string } }[] };
};
export type InteractiveList = {
  type: "list";
  body: { text: string };
  action: { button: string; sections: { rows: { id: string; title: string }[] }[] };
};
export type Interactive = InteractiveButton | InteractiveList;

/** The Cloud API interactive object: reply buttons for 2 to 3 options, a list for 4 to 10. */
export function buildInteractive(text: string, options: string[]): Interactive {
  const titles = options.map((o) => o.trim());
  const ids = optionIds(titles);
  const body = { text: text.trim() };
  if (titles.length <= QUESTION.maxButtons) {
    return { type: "button", body, action: { buttons: titles.map((title, i) => ({ type: "reply", reply: { id: ids[i]!, title } })) } };
  }
  return { type: "list", body, action: { button: QUESTION.listButton, sections: [{ rows: titles.map((title, i) => ({ id: ids[i]!, title })) }] } };
}

// ------------------------------------------------------------------ saved replies

export function firstName(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? "";
}

/** Fills `{nome}` (and any other `{var}` given). A variable with no value stays, so the agent sees it. */
export function fillVariables(body: string, vars: Record<string, string | null | undefined>): string {
  return body.replace(/\{([a-z_]+)\}/gi, (all, key: string) => {
    const v = vars[key.toLowerCase()];
    return v ? v : all;
  });
}

/** The saved-reply query when the text before the caret ends with "/shortcut" at a word start. */
export function slashQuery(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)\/([a-z0-9_-]*)$/i.exec(before);
  if (!m) return null;
  return { query: m[2]!.toLowerCase(), start: caret - m[2]!.length - 1 };
}

export function matchReplies<T extends { shortcut: string }>(replies: T[], query: string): T[] {
  const q = query.toLowerCase();
  return replies.filter((r) => r.shortcut.toLowerCase().startsWith(q)).concat(replies.filter((r) => !r.shortcut.toLowerCase().startsWith(q) && r.shortcut.toLowerCase().includes(q)));
}

// ------------------------------------------------------------------ time

const DAY = 86_400_000;

function dayKey(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

/** Short time for lists: "14:30" today, "ontem", "13 out" this year, "13/10/2025" before. */
export function formatWhen(ms: number | null | undefined, now: number = Date.now(), timeZone?: string): string {
  if (!ms) return "";
  const k = dayKey(ms, timeZone);
  if (k === dayKey(now, timeZone)) return new Intl.DateTimeFormat("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit" }).format(ms);
  if (k === dayKey(now - DAY, timeZone)) return "ontem";
  if (k.slice(0, 4) === dayKey(now, timeZone).slice(0, 4)) {
    return new Intl.DateTimeFormat("pt-BR", { timeZone, day: "numeric", month: "short" }).format(ms).replace(".", "").replace(" de ", " ");
  }
  return new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit", year: "numeric" }).format(ms);
}

/** Full date and time for tables and tooltips: "13/10/2026 14:30". */
export function formatDateTime(ms: number | null | undefined, timeZone?: string): string {
  if (!ms) return "";
  return new Intl.DateTimeFormat("pt-BR", { timeZone, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(ms).replace(",", "");
}

/** A duration for people: "40 s", "12 min", "2 h 5 min", "3 d 4 h". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** WhatsApp takes free text only within 24 hours of the customer's last message. */
export function waWindowOpen(lastInboundAt: number | null | undefined, now: number = Date.now()): boolean {
  return !!lastInboundAt && now - lastInboundAt < DAY;
}

// ------------------------------------------------------------------ contacts

/**
 * What the inbox shows as the contact. A Bipe contact is a Matrix ID, never a phone number
 * (ADR 0063): anything else on the Bipe channel is hidden.
 */
export function contactLabel(channel: Channel, contact: string): string {
  if (channel === "bipe") return /^@[^:\s]+:[^\s]+$/.test(contact) ? contact : "";
  const d = contact.replace(/\D/g, "");
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4);
    const rest = d.slice(4);
    return `+55 ${ddd} ${rest.slice(0, rest.length - 4)}-${rest.slice(-4)}`;
  }
  return d ? `+${d}` : contact;
}

export function displayName(c: { channel: Channel; contact: string; contact_name: string | null }): string {
  return c.contact_name?.trim() || contactLabel(c.channel, c.contact) || "Cliente";
}

// ------------------------------------------------------------------ Bipe polls (structured questions)

export type Poll = { question: string; answers: { id: string; title: string }[] };

function extText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const plain = v.find((x) => x && typeof x === "object" && (!("mimetype" in x) || x.mimetype === "text/plain"));
    return typeof plain?.body === "string" ? plain.body : "";
  }
  return "";
}

function textOf(o: Record<string, unknown> | undefined): string {
  if (!o) return "";
  return extText(o["org.matrix.msc1767.text"]) || extText(o["m.text"]) || (typeof o.body === "string" ? o.body : "");
}

/** Reads a poll start event's content (stable `m.poll.start` or unstable MSC3381). */
export function readPoll(content: Record<string, any>): Poll | null {
  const start = content["m.poll.start"] ?? content["org.matrix.msc3381.poll.start"] ?? content["m.poll"];
  if (!start || typeof start !== "object") return null;
  const question = textOf(start.question);
  const answers = Array.isArray(start.answers)
    ? start.answers.map((a: any) => ({ id: String(a?.id ?? a?.["m.id"] ?? ""), title: textOf(a) })).filter((a: { id: string }) => a.id)
    : [];
  return { question, answers };
}

/** Answer IDs and the poll start event ID from a poll response event. */
export function readPollResponse(content: Record<string, any>): { pollId: string; answers: string[] } | null {
  const rel = content["m.relates_to"];
  const r = content["m.poll.response"] ?? content["org.matrix.msc3381.poll.response"] ?? content["m.selections"];
  const answers = Array.isArray(r?.answers) ? r.answers : Array.isArray(r) ? r : null;
  if (!rel?.event_id || !answers) return null;
  return { pollId: String(rel.event_id), answers: answers.map(String) };
}

export const POLL_START_TYPES = ["m.poll.start", "org.matrix.msc3381.poll.start"];
export const POLL_RESPONSE_TYPES = ["m.poll.response", "org.matrix.msc3381.poll.response"];

// ------------------------------------------------------------------ manager screens

const AUDIT_LABEL: Record<string, string> = {
  "agent.login": "Entrou num aparelho",
  "agent.logout": "Saiu",
  "agent.add": "Adicionou pessoa",
  "agent.remove": "Removeu pessoa",
  "device.signed": "Aparelho aprovado",
  "device.remove": "Removeu aparelho",
  "conversation.open": "Conversa nova",
  "conversation.read": "Abriu a conversa",
  "conversation.update": "Mudou a conversa",
  "conversation.take": "Assumiu a conversa",
  "note.add": "Nota interna",
  "message.send": "Respondeu",
  "linkcode.create": "Convite para o Bipe",
  "linkcode.used": "Cliente continuou no Bipe",
};

export function auditLabel(action: string): string {
  return AUDIT_LABEL[action] ?? action;
}

/** Normalizes a tag typed by an agent: trimmed, single spaces, at most 40 characters. */
export function cleanTag(t: string): string {
  return t.trim().replace(/\s+/g, " ").slice(0, 40);
}

export function addTag(tags: string[], t: string): string[] {
  const c = cleanTag(t);
  if (!c || tags.some((x) => x.toLowerCase() === c.toLowerCase()) || tags.length >= 20) return tags;
  return [...tags, c];
}
