import { webhookSignature } from "./secrets.js";
import type { WebhookEvent } from "./api.js";

// Sends inbound events to the company's own system, signed with `Bipe-Signature` (ADR 0082).
// The receiver checks the signature and rejects a timestamp older than a few minutes.

export class OutboundWebhook {
  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly delays = [1_000, 5_000, 30_000],
  ) {}

  async post(event: WebhookEvent): Promise<boolean> {
    const body = JSON.stringify(event);
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.fetchImpl(this.url, {
          method: "POST",
          headers: { "content-type": "application/json", "bipe-signature": webhookSignature(this.secret, body, Math.floor(Date.now() / 1000)) },
          body,
        });
        if (res.ok) return true;
        if (res.status < 500 && res.status !== 429) return false;
      } catch {
        // network error: retry
      }
      const d = this.delays[attempt];
      if (d === undefined) return false;
      await new Promise((r) => setTimeout(r, d));
    }
  }
}
