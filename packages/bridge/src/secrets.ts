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

/** Meta's webhook signature: `sha256=` + HMAC-SHA256 of the raw body with the app secret. */
export function hubSignature(secret: string, rawBody: string | Buffer): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function checkHubSignature(secret: string, rawBody: string | Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const want = Buffer.from(hubSignature(secret, rawBody));
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// Link codes: 8 characters of Crockford base32, shown as XXXX-XXXX. No I, L, O, U.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newLinkCode(): string {
  const bytes = randomBytes(8);
  let s = "";
  for (const b of bytes) s += ALPHABET[b & 31];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Normalise what a person typed: case, separators, and the letters people confuse. */
export function normaliseLinkCode(input: string): string | null {
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (!/^[0-9A-HJKMNP-TV-Z]{8}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Finds `continuar XXXX-XXXX` in a customer's message (the link page pre-fills it). */
export function findLinkCode(text: string): string | null {
  const m = /continuar\s+([0-9a-z]{4}[\s-]?[0-9a-z]{4})\b/i.exec(text);
  return m?.[1] ? normaliseLinkCode(m[1]) : null;
}
