import { z } from "zod";

// The bridge's API for the company's own systems (ADR 0082). Bipe's own design.
// POST /v1/messages sends one message. Inbound events go to the company's webhook (outbound.ts).

/** One option of a structured question (ADR 0081). */
export const Option = z.object({
  id: z.string().min(1).max(100),
  label: z.string().min(1).max(40),
  detail: z.string().max(80).optional(),
});
export type Option = z.infer<typeof Option>;

/** A structured question: the customer taps one option. */
export const Question = z.object({
  text: z.string().min(1).max(2000),
  options: z.array(Option).min(2).max(10),
});
export type Question = z.infer<typeof Question>;

/** A message from the template registry. `params` fill `{1}`, `{2}` in order. */
export const TemplateRef = z.object({
  name: z.string().min(1).max(100),
  language: z.string().min(2).max(15),
  params: z.array(z.string().max(1000)).max(20).default([]),
});
export type TemplateRef = z.infer<typeof TemplateRef>;

/** Exactly one of `text`, `template`, `question`. */
export const Content = z.union([
  z.object({ text: z.string().min(1).max(4000) }).strict(),
  z.object({ template: TemplateRef }).strict(),
  z.object({ question: Question }).strict(),
]);
export type Content = z.infer<typeof Content>;

/** `to`: the customer's @handle, Matrix ID, room ID, or the inbox conversation ID. */
export const SendRequest = z.object({ to: z.string().min(1).max(255), reply_to: z.string().max(255).optional() }).loose().transform((v, ctx) => {
  const { to, reply_to, ...rest } = v;
  const c = Content.safeParse(rest);
  if (!c.success) {
    ctx.addIssue({ code: "custom", message: "send exactly one of text, template or question" });
    return z.NEVER;
  }
  return { to, ...(reply_to ? { reply_to } : {}), content: c.data };
});
export type SendRequest = z.output<typeof SendRequest>;

export type ErrorCode =
  | "unauthorized"
  | "invalid_request"
  | "unknown_handle"
  | "customer_must_write_first"
  | "unknown_template"
  | "invalid_question"
  | "not_found"
  | "internal";

export function apiError(code: ErrorCode, message: string) {
  return { error: { code, message } };
}

/** Validates a question beyond the shape: option IDs are unique. */
export function questionProblem(q: Question): string | null {
  if (new Set(q.options.map((o) => o.id)).size !== q.options.length) return "option ids must be unique";
  return null;
}

/** Fills `{1}`, `{2}` in a template body. A missing parameter leaves its placeholder. */
export function renderTemplate(body: string, params: string[]): string {
  return body.replace(/\{(\d+)\}/g, (all, n: string) => params[Number(n) - 1] ?? all);
}

/** The text form of a question, for message previews and clients without polls. */
export function questionFallback(q: Question): string {
  return [q.text, ...q.options.map((o, i) => `${i + 1}. ${o.label}`)].join("\n");
}

/** An event for the company's webhook. */
export type WebhookEvent = {
  id: string;
  type: "message" | "answer";
  at: string;
  conversation: string;
  customer: { id: string; name: string | null };
  text?: string;
  answer?: { question: string; option: string; label: string };
};
