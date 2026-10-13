import { hubSignature } from "./secrets.js";

// Forwards inbound messages to the company's own system, signed like Meta's webhooks
// (`X-Hub-Signature-256`), so a receiver built for WhatsApp works unchanged.

export class OutboundWebhook {
  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly delays = [1_000, 5_000, 30_000],
  ) {}

  async post(payload: unknown): Promise<boolean> {
    const body = JSON.stringify(payload);
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.fetchImpl(this.url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-hub-signature-256": hubSignature(this.secret, body) },
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
