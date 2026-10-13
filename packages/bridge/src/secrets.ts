import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** Agent passwords: scrypt, stored as `scrypt1$salt$hash`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt1$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function checkPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt1" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64");
  const got = scryptSync(password, Buffer.from(salt, "base64"), want.length, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(want, got);
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export const newToken = () => randomBytes(32).toString("base64url");

/**
 * Signature for the company's webhook: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`.
 * The timestamp lets the receiver refuse replays.
 */
export function webhookSignature(secret: string, body: string, t: number): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

/** Checks a `Bipe-Signature` header. `maxAgeS` limits replays. */
export function checkWebhookSignature(secret: string, body: string, header: string | undefined, nowS: number, maxAgeS = 300): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(nowS - t) > maxAgeS) return false;
  return safeEqual(webhookSignature(secret, body, t), header!);
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
