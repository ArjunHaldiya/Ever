import { escapeRegExp, normalizeText } from "./text";
import type { Language } from "./types";

/**
 * Phrases are written in normalized form (lowercase, no diacritics, no
 * apostrophes) and matched at a word start. Over-triggering is the safe
 * direction: a false positive costs one extra "call 911" line.
 */
const EMERGENCY_PHRASES: readonly string[] = [
  // English
  "cant breathe",
  "cannot breathe",
  "can not breathe",
  "unable to breathe",
  "trouble breathing",
  "difficulty breathing",
  "hard to breathe",
  "shortness of breath",
  "not breathing",
  "isnt breathing",
  "stopped breathing",
  "stop breathing",
  "chest pain",
  "chest tightness",
  "pain in my chest",
  "heart attack",
  "unconscious",
  "unresponsive",
  "passed out",
  "overdos",
  "seizure",
  "stroke",
  "choking",
  "severe bleeding",
  "bleeding heavily",
  "suicid",
  "kill myself",
  // Spanish
  "no puedo respirar",
  "no respira",
  "dolor de pecho",
  "dolor en el pecho",
  "inconsciente",
  "sobredosis",
  "ataque al corazon",
  "ataque cardiaco",
  // Vietnamese
  "kho tho",
  "dau nguc",
  "bat tinh",
  "qua lieu",
  "ngung tho",
];

const EMERGENCY_RE = new RegExp(
  EMERGENCY_PHRASES.map((p) => `\\b${escapeRegExp(p)}`).join("|"),
);

/** FR-2: runs first, before any AI. Pure and synchronous. */
export function detectEmergency(text: string): boolean {
  return EMERGENCY_RE.test(normalizeText(text));
}

const EMERGENCY_TEXT: Record<Language, string> = {
  en: "This sounds like an emergency. Call 911 now.",
  es: "Esto parece una emergencia. Llame al 911 ahora.",
  vi: "Đây có vẻ là tình huống khẩn cấp. Hãy gọi 911 ngay.",
};

export function emergencyReply(language: Language = "en"): string {
  return EMERGENCY_TEXT[language];
}
