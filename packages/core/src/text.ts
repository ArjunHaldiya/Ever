/**
 * Normalize free text for keyword matching: lowercase, strip diacritics
 * (so "khó thở" matches "kho tho"), drop apostrophes ("can't" -> "cant"),
 * collapse whitespace. Matching only; never store or display the result.
 */
export function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/['’‘`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
