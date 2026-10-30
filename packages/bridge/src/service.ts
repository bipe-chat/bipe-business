import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { questionFallback, questionProblem, renderTemplate, type Content, type ErrorCode, type Question, type SendRequest, type WebhookEvent } from "./api.js";
import type { BipeInbound, BipeSide, ExtraContent } from "./matrix.js";
import { OutboundWebhook } from "./outbound.js";
import type { Conversation, Store } from "./store.js";

export class SendError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The bridge: the company's Bipe inbox and its API (ADR 0069, ADR 0082). */
export class Bridge {
  readonly outbound: OutboundWebhook | null;

  constructor(
    readonly cfg: Config,
    readonly store: Store,
    readonly bipe: BipeSide | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.outbound = cfg.outboundWebhook ? new OutboundWebhook(cfg.outboundWebhook.url, cfg.outboundWebhook.secret, fetchImpl) : null;
    bipe?.onEvent((e) => this.onBipe(e));
  }

  // ---------------------------------------------------------------- inbound

  async onBipe(e: BipeInbound) {
    if (e.kind === "invite") {
      // A customer wrote first: that is the opt-in. Join, and open a conversation.
      await this.bipe!.join(e.roomId);
      const { created, conv } = this.store.upsertConversation(e.roomId, e.sender, e.senderName);
      if (created) this.store.audit("conversation.open", { conversationId: conv.id });
      return;
    }
    const known = this.store.conversationByRoom(e.roomId);
    if (!known) return;
    // The customer's display name can change after the first invite: keep the newest one.
    const conv = e.kind === "text" && e.fromCompany ? known : this.store.upsertConversation(e.roomId, known.contact, e.senderName).conv;
    if (e.kind === "text") {
      if (e.fromCompany) {
        // An agent answered from the inbox, on the agent's own device.
        this.store.markOutbound(conv.id);
        return;
      }
      this.store.markInbound(conv.id);
      await this.forward(conv, { id: e.eventId, type: "message", at: new Date(e.at).toISOString(), text: e.body });
      return;
    }
    // A tap on a structured question.
    const options = this.bipe!.questionOptions(e.questionId);
    const opt = options?.find((o) => o.id === e.optionIds[0]);
    if (!options || !opt) return;
    this.store.markInbound(conv.id);
    await this.forward(conv, { id: e.eventId, type: "answer", at: new Date(e.at).toISOString(), answer: { question: e.questionId, option: opt.id, label: opt.label } });
  }

  private async forward(conv: Conversation, ev: Omit<WebhookEvent, "conversation" | "customer">) {
    if (!this.outbound) return;
    await this.outbound.post({ ...ev, conversation: conv.id, customer: { id: conv.contact, name: conv.contact_name } });
  }

  // ---------------------------------------------------------------- outbound

  /**
   * Sends one API request on Bipe. The customer must have written first.
   * `extra`: fields added to the Matrix event, such as the MCP assistant marker (bipe#437).
   */
  async send(req: SendRequest, agentId: string | null = null, extra: ExtraContent = {}) {
    const conv = this.conversationFor(await this.resolveHandle(req.to));
    // No cold messages: a company writes only to a customer who wrote first (ADR 0016, ADR 0037).
    if (!conv) throw new SendError(400, "customer_must_write_first", "no conversation with this customer: the customer must write first");
    const id = await this.sendContent(conv, req.content, extra);
    this.store.markOutbound(conv.id);
    if (agentId) this.store.audit("message.send", { agentId, conversationId: conv.id });
    return { id, conversation: conv.id, customer: conv.contact };
  }

  private async sendContent(conv: Conversation, c: Content, extra: ExtraContent): Promise<string> {
    if ("text" in c) return this.bipe!.sendText(conv.room_id, c.text, extra);
    if ("template" in c) {
      const t = this.store.template(c.template.name, c.template.language);
      if (!t) throw new SendError(404, "unknown_template", `template ${c.template.name} (${c.template.language}) does not exist`);
      return this.bipe!.sendText(conv.room_id, renderTemplate(t.body, c.template.params), extra);
    }
    return this.sendQuestion(conv, c.question, extra);
  }

  private async sendQuestion(conv: Conversation, q: Question, extra: ExtraContent) {
    const p = questionProblem(q);
    if (p) throw new SendError(400, "invalid_question", p);
    return this.bipe!.sendQuestion(conv.room_id, q.text, q.options, questionFallback(q), extra);
  }

  /** `@handle` (no server part) becomes the Matrix ID through the Bipe API, with the company account's token. */
  async resolveHandle(to: string): Promise<string> {
    if (!/^@[a-z0-9._]{2,30}$/i.test(to) || !this.bipe) return to;
    const res = await this.fetchImpl(`${this.cfg.apiUrl}/v1/handles/${encodeURIComponent(to.slice(1).toLowerCase())}`, {
      headers: { authorization: `Bearer ${this.bipe.accessToken}` },
    }).catch(() => null);
    if (!res?.ok) throw new SendError(404, "unknown_handle", `no Bipe account with the handle ${to}`);
    const body = (await res.json().catch(() => ({}))) as { user_id?: string };
    if (!body.user_id) throw new SendError(404, "unknown_handle", `no Bipe account with the handle ${to}`);
    return body.user_id;
  }

  /** `to`: a Matrix ID, a room ID, or a conversation ID. */
  conversationFor(to: string): Conversation | undefined {
    if (to.startsWith("!")) return this.store.conversationByRoom(to);
    if (to.startsWith("@") && to.includes(":")) return this.store.listConversations({ limit: 500 }).find((c) => c.contact === to);
    return this.store.conversation(to);
  }

  /** An agent sends a template or a question from the inbox. Plain text goes from the agent's own device. */
  async agentSend(conversationId: string, agentId: string, content: Content) {
    const conv = this.store.conversation(conversationId);
    if (!conv) throw new SendError(404, "not_found", "conversation not found");
    if ("text" in content) throw new SendError(400, "invalid_request", "text is sent by the agent's own device");
    return this.send({ to: conv.id, content }, agentId);
  }

  id() {
    return randomUUID();
  }
}
