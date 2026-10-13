import { z } from "zod";

// The WhatsApp Cloud API request shape, as checked in bipe/docs/business-messaging.md (11 October 2026).
// A company that already sends to WhatsApp changes the base URL and the token, not its code.

const Text = z.object({ body: z.string().min(1).max(4096), preview_url: z.boolean().optional() });

const TemplateParam = z.object({ type: z.literal("text"), text: z.string().max(1024) });
const Template = z.object({
  name: z.string().min(1).max(512),
  language: z.object({ code: z.string().min(2).max(15) }),
  components: z
    .array(z.object({ type: z.enum(["header", "body", "button"]), parameters: z.array(TemplateParam).optional(), sub_type: z.string().optional(), index: z.union([z.string(), z.number()]).optional() }))
    .optional(),
});

const ReplyButton = z.object({ type: z.literal("reply"), reply: z.object({ id: z.string().min(1).max(256), title: z.string().min(1).max(20) }) });
const ListRow = z.object({ id: z.string().min(1).max(200), title: z.string().min(1).max(24), description: z.string().max(72).optional() });

/** Structured questions (ADR 0081): reply buttons (up to 3) or a list (up to 10 rows). */
export const Interactive = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("button"),
    header: z.object({ type: z.literal("text"), text: z.string().max(60) }).optional(),
    body: z.object({ text: z.string().min(1).max(1024) }),
    footer: z.object({ text: z.string().max(60) }).optional(),
    action: z.object({ buttons: z.array(ReplyButton).min(1).max(3) }),
  }),
  z.object({
    type: z.literal("list"),
    header: z.object({ type: z.literal("text"), text: z.string().max(60) }).optional(),
    body: z.object({ text: z.string().min(1).max(4096) }),
    footer: z.object({ text: z.string().max(60) }).optional(),
    action: z.object({
      button: z.string().min(1).max(20),
      sections: z.array(z.object({ title: z.string().max(24).optional(), rows: z.array(ListRow).min(1).max(10) })).min(1).max(10),
    }),
  }),
]);

const Base = z.object({
  messaging_product: z.enum(["whatsapp", "bipe"]),
  recipient_type: z.literal("individual").optional(),
  to: z.string().min(1).max(255),
  context: z.object({ message_id: z.string() }).optional(),
});

export const SendRequest = z.discriminatedUnion("type", [
  Base.extend({ type: z.literal("text"), text: Text }),
  Base.extend({ type: z.literal("template"), template: Template }),
  Base.extend({ type: z.literal("interactive"), interactive: Interactive }),
]);
export type SendRequest = z.infer<typeof SendRequest>;
export type InteractiveMsg = z.infer<typeof Interactive>;

export type Option = { id: string; title: string; description?: string };

/** The options of a question, in order. List rows across sections count together (max 10). */
export function questionOptions(i: InteractiveMsg): Option[] {
  if (i.type === "button") return i.action.buttons.map((b) => ({ id: b.reply.id, title: b.reply.title }));
  const rows = i.action.sections.flatMap((s) => s.rows);
  return rows.map((r) => ({ id: r.id, title: r.title, ...(r.description ? { description: r.description } : {}) }));
}

export function questionText(i: InteractiveMsg): string {
  return [i.header?.text, i.body.text].filter(Boolean).join("\n");
}

/** Validates a question beyond the shape: unique IDs, at most 10 options. */
export function questionProblem(i: InteractiveMsg): string | null {
  const opts = questionOptions(i);
  if (opts.length < 1) return "a question needs at least one option";
  if (opts.length > 10) return "a question has at most 10 options";
  if (new Set(opts.map((o) => o.id)).size !== opts.length) return "option ids must be unique";
  return null;
}

/** Fills `{{1}}`, `{{2}}` in a template body from the body component's parameters. */
export type TemplateMsg = z.infer<typeof Template>;

export function renderTemplate(body: string, components: TemplateMsg["components"]): string {
  const params = components?.find((c) => c.type === "body")?.parameters ?? [];
  return body.replace(/\{\{(\d+)\}\}/g, (all, n: string) => params[Number(n) - 1]?.text ?? all);
}

/** Error body in the Cloud API shape. */
export function apiError(code: number, message: string, details?: string) {
  return { error: { message, type: "OAuthException", code, ...(details ? { error_data: { details } } : {}) } };
}

/** Inbound message as the Cloud API webhook shows it, for the company's own systems. */
export type InboundMessage =
  | { from: string; id: string; timestamp: string; type: "text"; text: { body: string } }
  | { from: string; id: string; timestamp: string; type: "interactive"; context?: { id: string }; interactive: { type: "button_reply"; button_reply: { id: string; title: string } } | { type: "list_reply"; list_reply: { id: string; title: string; description?: string } } };

export function webhookEnvelope(phoneNumberId: string, displayPhone: string, product: "whatsapp" | "bipe", contact: { wa_id: string; name?: string }, message: InboundMessage) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: phoneNumberId,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: product,
              metadata: { display_phone_number: displayPhone, phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: contact.name ?? "" }, wa_id: contact.wa_id }],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}
