import type { Config } from "./config.js";
import type { SendRequest } from "./cloudapi.js";

// WhatsApp side (ADR 0069): the company's own Cloud API number, through the company's own bridge.
// Only the official Cloud API. No WhatsApp Web bridges: they break Meta's terms.

export type WaConfig = NonNullable<Config["whatsapp"]>;

export class WhatsApp {
  constructor(readonly cfg: WaConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  /** Sends a message in the Cloud API shape. Returns Meta's answer as is. */
  async send(body: Record<string, unknown>): Promise<{ status: number; json: any }> {
    const res = await this.fetchImpl(`${this.cfg.graphUrl}/${this.cfg.graphVersion}/${this.cfg.phoneNumberId}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.cfg.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ ...body, messaging_product: "whatsapp" }),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }

  sendRequest(r: SendRequest) {
    const { messaging_product: _p, ...rest } = r;
    return this.send(rest);
  }
}

/** What the bridge reads from one Meta webhook POST. */
export type WaInbound = {
  messages: { from: string; name: string | null; id: string; at: number; type: string; text: string | null; reply: { id: string; title: string } | null; contextId: string | null }[];
  statuses: { id: string; status: string }[];
};

export function parseWaWebhook(payload: any): WaInbound {
  const out: WaInbound = { messages: [], statuses: [] };
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== "messages") continue;
      const v = change.value ?? {};
      const names = new Map<string, string>();
      for (const c of v.contacts ?? []) if (c?.wa_id) names.set(String(c.wa_id), String(c.profile?.name ?? ""));
      for (const m of v.messages ?? []) {
        const from = String(m.from ?? "");
        if (!from || !m.id) continue;
        const i = m.interactive;
        const reply = i?.button_reply ?? i?.list_reply ?? (m.button ? { id: m.button.payload, title: m.button.text } : null);
        out.messages.push({
          from,
          name: names.get(from) || null,
          id: String(m.id),
          at: Number(m.timestamp ?? 0) * 1000 || Date.now(),
          type: String(m.type ?? "unknown"),
          text: m.text?.body ?? (reply ? String(reply.title) : null),
          reply: reply ? { id: String(reply.id), title: String(reply.title) } : null,
          contextId: m.context?.id ? String(m.context.id) : null,
        });
      }
      for (const s of v.statuses ?? []) if (s?.id && s?.status) out.statuses.push({ id: String(s.id), status: String(s.status) });
    }
  }
  return out;
}
