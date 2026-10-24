import { detectEmergency } from "./emergency";
import { extractZip } from "./geo";
import { ExtractedNeedSchema } from "./schemas";
import { normalizeText } from "./text";
import type { ExtractedNeed, Language, NeedType, Tier } from "./types";

type Rule = { needType: Exclude<NeedType, "info">; pattern: RegExp; weight: number };

/** Patterns run against normalizeText() output. Higher weight = stronger signal. */
const RULES: readonly Rule[] = [
  // refrigeration
  { needType: "refrigeration", pattern: /\bfridge/, weight: 3 },
  { needType: "refrigeration", pattern: /\brefrigerat/, weight: 3 },
  { needType: "refrigeration", pattern: /\b(?:keep|keeping|stay|staying|kept)\b.{0,20}\bcold\b/, weight: 3 },
  { needType: "refrigeration", pattern: /\bcold storage/, weight: 3 },
  { needType: "refrigeration", pattern: /\b(?:spoil|going bad|go bad)/, weight: 2 },
  { needType: "refrigeration", pattern: /\bbreast ?milk/, weight: 2 },
  { needType: "refrigeration", pattern: /\binsulin/, weight: 1 },
  { needType: "refrigeration", pattern: /\b(?:refrigerador|nevera)/, weight: 3 },
  { needType: "refrigeration", pattern: /\btu lanh/, weight: 3 },
  // device power
  { needType: "device_power", pattern: /\boxygen/, weight: 3 },
  { needType: "device_power", pattern: /\b(?:cpap|bipap|ventilator|nebulizer|dialysis)/, weight: 3 },
  { needType: "device_power", pattern: /\b(?:medical device|life support)/, weight: 3 },
  { needType: "device_power", pattern: /\b(?:wheelchair|power chair|hospital bed)/, weight: 2 },
  { needType: "device_power", pattern: /\boxigeno/, weight: 3 },
  { needType: "device_power", pattern: /\bmay tho\b/, weight: 3 },
  // pharmacy
  { needType: "pharmacy", pattern: /\bpharmac/, weight: 3 },
  { needType: "pharmacy", pattern: /\b(?:prescription|drugstore)/, weight: 3 },
  { needType: "pharmacy", pattern: /\b(?:medication|medicine|refill|meds\b|inhaler)/, weight: 2 },
  { needType: "pharmacy", pattern: /\bfarmacia/, weight: 3 },
  { needType: "pharmacy", pattern: /\b(?:receta|medicamento)/, weight: 2 },
  { needType: "pharmacy", pattern: /\bhieu thuoc/, weight: 3 },
  { needType: "pharmacy", pattern: /\bthuoc\b/, weight: 2 },
  { needType: "pharmacy", pattern: /\binsulin/, weight: 1 },
  // food
  { needType: "food", pattern: /\b(?:food|hungry|baby formula)/, weight: 3 },
  { needType: "food", pattern: /\b(?:hunger|meal|grocer)/, weight: 2 },
  { needType: "food", pattern: /\beat\b/, weight: 1 },
  { needType: "food", pattern: /\b(?:comida|hambre)/, weight: 3 },
  { needType: "food", pattern: /\bthuc an/, weight: 3 },
  { needType: "food", pattern: /\bdoi\b/, weight: 2 },
  // cooling
  { needType: "cooling", pattern: /\b(?:too hot|heat wave|air condition|cooling|cool down|cool place|stay cool)/, weight: 3 },
  { needType: "cooling", pattern: /\b(?:hot|a\/c|ac)\b/, weight: 2 },
  { needType: "cooling", pattern: /\b(?:calor|aire acondicionado)/, weight: 3 },
  { needType: "cooling", pattern: /\bmay lanh/, weight: 3 },
  { needType: "cooling", pattern: /\bnong\b/, weight: 2 },
  // charging
  { needType: "charging", pattern: /\bcharg/, weight: 3 },
  { needType: "charging", pattern: /\b(?:phone (?:died|is dead)|dead phone)/, weight: 3 },
  { needType: "charging", pattern: /\b(?:battery|outlet)/, weight: 2 },
  { needType: "charging", pattern: /\bcargar|\bcargador/, weight: 3 },
  { needType: "charging", pattern: /\bsac\b/, weight: 2 },
];

/** Tie-break order when two needs score equally: medical first. */
const PRIORITY: readonly Exclude<NeedType, "info">[] = [
  "device_power",
  "refrigeration",
  "pharmacy",
  "food",
  "cooling",
  "charging",
];

const TIER_BY_NEED: Record<NeedType, Tier> = {
  refrigeration: "medical_critical",
  device_power: "medical_critical",
  pharmacy: "medical_critical",
  food: "food",
  cooling: "shelter_cooling",
  charging: "shelter_cooling",
  info: "info",
};

export function tierForNeed(needType: NeedType): Tier {
  return TIER_BY_NEED[needType];
}

function detectNeed(normalized: string): { needType: NeedType; score: number } {
  const scores = new Map<NeedType, number>();
  for (const r of RULES) {
    if (r.pattern.test(normalized)) {
      scores.set(r.needType, (scores.get(r.needType) ?? 0) + r.weight);
    }
  }
  let best: NeedType = "info";
  let bestScore = 0;
  for (const needType of PRIORITY) {
    const s = scores.get(needType) ?? 0;
    if (s > bestScore) {
      best = needType;
      bestScore = s;
    }
  }
  return { needType: best, score: bestScore };
}

const VI_CHARS_RE = /[ăâêôơưđẠ-ỹ]/i;
const VI_WORDS_RE = /\b(?:toi can|toi muon|thuoc|tu lanh|may lanh|thuc an|giup|o dau)\b/;
const ES_WORDS_RE =
  /\b(?:necesito|donde|ayuda|hola|farmacia|comida|hambre|calor|refrigerador|nevera|tengo|puedo|cerca|por favor|gracias|cargar|cargador|medicina|medicamento|sobredosis|pecho|respirar|oxigeno)\b/;

function detectLanguage(original: string, normalized: string): Language {
  if (VI_CHARS_RE.test(original) || VI_WORDS_RE.test(normalized)) return "vi";
  if (ES_WORDS_RE.test(normalized)) return "es";
  return "en";
}

const STREET_SUFFIX =
  "(?:st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|ct|court|pl|place|pkwy|parkway|hwy|highway)";
const STREET = `[A-Za-z0-9.'-]+(?:\\s+[A-Za-z0-9.'-]+){0,2}?\\s+${STREET_SUFFIX}\\b\\.?`;
const CROSS_STREETS_RE = new RegExp(`(${STREET})\\s*(?:and|&|/|at)\\s*(${STREET})`, "i");
const ADDRESS_RE = new RegExp(`\\b(\\d{1,6}\\s+${STREET})`, "i");
/** The street-name pattern is lazy-but-greedy enough to swallow "corner of" / "i'm at" before the first street. */
const LEADING_FILLER_RE =
  /^(?:.*\b)?(?:corner of|intersection of|the corner|the intersection|at|near|by|on)\s+/i;
const PLACE_RE =/\b(?:near|around|close to|by|at)\s+([A-Za-z0-9][A-Za-z0-9 .'&/-]{2,40}?)(?=[.,;!?]|$)/i;
const NOT_A_PLACE_RE =
  /^(?:me|here|there|home|work|my (?:house|home|place|apartment|location|work)|the moment|tonight|today|tomorrow|now|night|noon|\d{1,2} ?(?:am|pm))$/i;

/** ", San Francisco" / ", Oakland CA" right after a street or intersection: needed to place it nationwide. */
const TRAILING_CITY_RE = /^,\s*([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,2})(?:,?\s*([A-Z]{2})\b)?/;

function withTrailingCity(found: string, match: RegExpExecArray): string {
  const tail = match.input.slice(match.index + match[0].length);
  const city = TRAILING_CITY_RE.exec(tail);
  return city ? `${found}, ${city[1]}${city[2] ? `, ${city[2]}` : ""}` : found;
}

/** Pull a location out of the message: ZIP, street address, cross streets, or a "near X" phrase. */
export function extractLocationText(text: string): string | null {
  const zip = extractZip(text);
  if (zip) return zip;
  const address = ADDRESS_RE.exec(text);
  if (address?.[1]) return withTrailingCity(address[1].trim(), address);
  const cross = CROSS_STREETS_RE.exec(text);
  if (cross?.[1] && cross[2]) {
    const found = `${cross[1].replace(LEADING_FILLER_RE, "").trim()} and ${cross[2].trim()}`;
    return withTrailingCity(found, cross);
  }
  const place = PLACE_RE.exec(text)?.[1]?.trim();
  if (place && place.split(/\s+/).length <= 6 && !NOT_A_PLACE_RE.test(place)) return place;
  return null;
}

function confidenceForScore(score: number): number {
  if (score >= 3) return 0.85;
  if (score === 2) return 0.7;
  if (score === 1) return 0.55;
  return 0.3;
}

/** Degraded-mode extractor: keywords + regex, no network. Same contract as the Bedrock extractor. */
export function extractNeedByRules(text: string): ExtractedNeed {
  const normalized = normalizeText(text);
  const emergency = detectEmergency(text);
  const { needType, score } = detectNeed(normalized);
  return ExtractedNeedSchema.parse({
    emergency,
    tier: emergency ? "medical_critical" : tierForNeed(needType),
    needType,
    locationText: extractLocationText(text),
    language: detectLanguage(text, normalized),
    confidence: confidenceForScore(score),
  });
}
