import { createHash } from "node:crypto";

/**
 * Server-only (uses node:crypto); import from "@ever/core/hash", not the index,
 * so the dashboard bundle never pulls it in.
 */

/**
 * iMessage handles are phone numbers or emails. Phone numbers are normalized to
 * E.164-ish (+1 assumed for 10 digits) so the same person always hashes the same.
 */
export function normalizeHandle(raw: string): string {
  const s = raw.trim();
  if (s.includes("@")) return s.toLowerCase();
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 8 && s.startsWith("+")) return `+${digits}`;
  return s;
}

/** SHA-256(salt + normalized handle), hex. Refuses to hash without a salt. */
export function hashHandle(raw: string, salt: string): string {
  if (!salt) throw new Error("PHONE_HASH_SALT is required to hash identifiers");
  return createHash("sha256").update(`${salt}:${normalizeHandle(raw)}`).digest("hex");
}
