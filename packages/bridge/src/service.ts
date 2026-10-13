import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { questionOptions, questionProblem, questionText, renderTemplate, webhookEnvelope, type InteractiveMsg, type SendRequest } from "./cloudapi.js";
import type { BipeInbound, BipeSide } from "./matrix.js";
import { OutboundWebhook } from "./outbound.js";
import { findLinkCode, newLinkCode } from "./secrets.js";
import type { Conversation, Store } from "./store.js";
import { parseWaWebhook, type WhatsApp } from "./whatsapp.js";

export class SendError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** The bridge: one inbox for Bipe and WhatsApp (ADR 0069). */
export class Bridge {
  readonly outbound: OutboundWebhook | null;

  constructor(
    readonly cfg: Config,
    readonly store: Store,
    readonly bipe: BipeSide | null,
    readonly wa: WhatsApp | null,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.outbound = cfg.outboundWebhook ? new OutboundWebhook(cfg.outboundWebhook.url, cfg.outboundWebhook.secret, fetchImpl) : null;
    bipe?.onEvent((e) => this.onBipe(e));
  }

  // ---------------------------------------------------------------- inbound

  async onBipe(e: BipeInbound) {
    if (e.kind === "invite") {
      // A customer wrote first: that is the opt-in. Join, and open a conversation.
      await this.bipe!.join(e.roomId);
      const { created, conv } = this.store.upsertConversation("bipe", e.roomId, e.sender, e.senderName);
      if (created) this.store.audit("conversation.open", { conversationId: conv.id, detail: "bipe" });
      return;
    }
    const known = this.store.conversationByExternal("bipe", e.roomId);
    if (!known) return;
    // The customer's display name can change after the first invite: keep the newest one.
    const conv = e.kind === "text" && e.fromCompany ? known : this.store.upsertConversation("bipe", e.roomId, known.contact, e.senderName).conv;
    if (e.kind === "text") {
      if (e.fromCompany) {
        // An agent answered from the inbox, on the agent's own device.
        this.store.markOutbound(conv.id);
        return;
      }
      this.store.markInbound(conv.id);
      const code = findLinkCode(e.body);
      if (code) this.redeemLinkCode(code, conv.id);
      await this.forward(conv, { from: conv.contact, id: e.eventId, timestamp: String(Math.floor(e.at / 1000)), type: "text", text: { body: e.body } });
      return;
    }
    // A tap on a structured question.
    const options = this.bipe!.questionOptions(e.questionId);
    const opt = options?.find((o) => o.id === e.optionIds[0]);
    if (!options || !opt) return;
    this.store.markInbound(conv.id);
    const kind = options.length > 3 ? "list_reply" : "button_reply";
    await this.forward(conv, {
      from: conv.contact,
      id: e.eventId,
      timestamp: String(Math.floor(e.at / 1000)),
      type: "interactive",
      context: { id: e.questionId },
      interactive: kind === "list_reply" ? { type: "list_reply", list_reply: { id: opt.id, title: opt.title } } : { type: "button_reply", button_reply: { id: opt.id, title: opt.title } },
    } as any);
  }

  /** A Meta webhook POST, already signature-checked. */
  async onWhatsApp(payload: unknown) {
    const parsed = parseWaWebhook(payload);
    for (const m of parsed.messages) {
      const { conv, created } = this.store.upsertConversation("whatsapp", m.from, m.from, m.name);
      if (created) this.store.audit("conversation.open", { conversationId: conv.id, detail: "whatsapp" });
      this.store.addWaMessage({ id: m.id, conversation_id: conv.id, direction: "in", type: m.type, body: m.text, at: m.at });
      if (conv.status !== "moved") this.store.markInbound(conv.id);
    }
    for (const s of parsed.statuses) this.store.setWaStatus(s.id, s.status);
    // The company's own system gets Meta's payload as it came.
    if (this.outbound && (parsed.messages.length || parsed.statuses.length)) void this.outbound.post(payload);
  }

  private async forward(conv: Conversation, message: any) {
    if (!this.outbound) return;
    await this.outbound.post(webhookEnvelope(this.cfg.bipePhoneNumberId, `@${this.cfg.matrix.handle}`, "bipe", { wa_id: conv.contact, ...(conv.contact_name ? { name: conv.contact_name } : {}) }, message));
  }

  // ---------------------------------------------------------------- link codes

  /** Makes a single-use code that moves this chat to Bipe (bipe/docs/business-track.md). */
  makeLinkCode(conversationId: string, agentId: string) {
    const conv = this.store.conversation(conversationId);
    if (!conv) throw new SendError(404, 100, "conversation not found");
    if (conv.channel !== "whatsapp") throw new SendError(400, 100, "link codes move WhatsApp chats to Bipe");
    const code = newLinkCode();
    this.store.addLinkCode(code, conv.id, agentId);
    this.store.audit("linkcode.create", { agentId, conversationId: conv.id });
    const url = `${this.cfg.siteUrl}/@${this.cfg.matrix.handle}/continuar/${code}`;
    return { code, url, text: `Para continuar no Bipe, toque aqui: ${url}` };
  }

  /** The customer sent the code from Bipe. Only the customer links the two chats (ADR 0063). */
  redeemLinkCode(code: string, bipeConversationId: string): boolean {
    const fromId = this.store.useLinkCode(code, bipeConversationId);
    if (!fromId || fromId === bipeConversationId) return false;
    this.store.joinConversations(fromId, bipeConversationId);
    this.store.audit("linkcode.used", { conversationId: bipeConversationId, detail: fromId });
    return true;
  }

  // ---------------------------------------------------------------- outbound

  /**
   * Sends one Cloud API request. `phoneNumberId` picks the channel: the WhatsApp number, or the Bipe id.
   * Returns the Cloud API response body.
   */
  async send(phoneNumberId: string, req: SendRequest, agentId: string | null = null) {
    if (this.wa && phoneNumberId === this.wa.cfg.phoneNumberId) return this.sendWhatsApp(req, agentId);
    if (phoneNumberId === this.cfg.bipePhoneNumberId) return this.sendBipe(req, agentId);
    throw new SendError(400, 100, `unknown phone number id ${phoneNumberId}`);
  }

  private async sendWhatsApp(req: SendRequest, agentId: string | null) {
    if (req.type === "interactive") {
      const p = questionProblem(req.interactive);
      if (p) throw new SendError(400, 131009, p);
    }
    const r = await this.wa!.sendRequest(req);
    if (r.status >= 400) throw Object.assign(new SendError(r.status, r.json?.error?.code ?? 0, r.json?.error?.message ?? "whatsapp error"), { meta: r.json });
    const id: string | undefined = r.json?.messages?.[0]?.id;
    const { conv } = this.store.upsertConversation("whatsapp", req.to, req.to, null);
    if (id) this.store.addWaMessage({ id, conversation_id: conv.id, direction: "out", type: req.type, body: describe(req), agent_id: agentId });
    this.store.markOutbound(conv.id);
    if (agentId) this.store.audit("message.send", { agentId, conversationId: conv.id, detail: "whatsapp" });
    return r.json;
  }

  private async sendBipe(req: SendRequest, agentId: string | null) {
    const conv = this.bipeConversationFor(req.to);
    // No cold messages: a company writes only to a customer who wrote first (ADR 0016, ADR 0037).
    if (!conv) throw new SendError(400, 131047, "no conversation with this customer: the customer must write first");
    let body: string;
    let eventId: string;
    if (req.type === "text") {
      body = req.text.body;
      eventId = await this.bipe!.sendText(conv.external_id, body);
    } else if (req.type === "template") {
      const t = this.store.template(req.template.name, req.template.language.code);
      if (!t) throw new SendError(404, 132001, `template ${req.template.name} (${req.template.language.code}) does not exist`);
      body = renderTemplate(t.body, req.template.components);
      eventId = await this.bipe!.sendText(conv.external_id, body);
    } else {
      eventId = await this.sendQuestion(conv, req.interactive);
      body = questionText(req.interactive);
    }
    this.store.markOutbound(conv.id);
    if (agentId) this.store.audit("message.send", { agentId, conversationId: conv.id, detail: "bipe" });
    return { messaging_product: "bipe", contacts: [{ input: req.to, wa_id: conv.contact }], messages: [{ id: eventId, message_status: "accepted" }] };
  }

  private async sendQuestion(conv: Conversation, i: InteractiveMsg) {
    const p = questionProblem(i);
    if (p) throw new SendError(400, 131009, p);
    return this.bipe!.sendQuestion(conv.external_id, questionText(i), questionOptions(i));
  }

  /** `to` on the Bipe channel: a Matrix ID, a room ID, or a conversation ID. */
  bipeConversationFor(to: string): Conversation | undefined {
    if (to.startsWith("!")) return this.store.conversationByExternal("bipe", to);
    if (to.startsWith("@") && to.includes(":")) return this.store.listConversations({ channel: "bipe", limit: 500 }).find((c) => c.contact === to);
    const c = this.store.conversation(to);
    return c?.channel === "bipe" ? c : undefined;
  }

  /** An agent replies from the inbox to a WhatsApp chat (Bipe chats are sent by the agent's own device). */
  async agentSend(conversationId: string, agentId: string, req: { text?: string; interactive?: InteractiveMsg; template?: { name: string; language: string; params: string[] } }) {
    const conv = this.store.conversation(conversationId);
    if (!conv) throw new SendError(404, 100, "conversation not found");
    const base = { messaging_product: conv.channel, to: conv.channel === "whatsapp" ? conv.contact : conv.external_id } as const;
    const msg: SendRequest = req.template
      ? ({
          ...base,
          type: "template",
          template: { name: req.template.name, language: { code: req.template.language }, components: [{ type: "body", parameters: req.template.params.map((text) => ({ type: "text", text })) }] },
        } as SendRequest)
      : req.interactive
        ? ({ ...base, type: "interactive", interactive: req.interactive } as SendRequest)
        : ({ ...base, type: "text", text: { body: req.text ?? "" } } as SendRequest);
    if (conv.channel === "whatsapp") {
      if (!this.wa) throw new SendError(400, 100, "whatsapp is not set up");
      return this.sendWhatsApp(msg, agentId);
    }
    if (msg.type === "text") throw new SendError(400, 100, "bipe text is sent by the agent's own device");
    return this.sendBipe(msg, agentId);
  }

  id() {
    return randomUUID();
  }
}

function describe(r: SendRequest): string {
  if (r.type === "text") return r.text.body;
  if (r.type === "template") return `[modelo ${r.template.name}]`;
  return [questionText(r.interactive), ...questionOptions(r.interactive).map((o, i) => `${i + 1}. ${o.title}`)].join("\n");
}
