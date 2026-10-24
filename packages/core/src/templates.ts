import { formatHours } from "./hours";
import type { Match } from "./matcher";
import type { NeedType, ProcessingMode, Tier } from "./types";

/**
 * Reply templates. Used as-is in degraded mode and as the fallback when the
 * Bedrock reply writer fails. English only for now (FR-20 is P2).
 * Nothing here gives medical advice: only "go here", "bring this", "call 911".
 */

export const BACKUP_MODE_NOTICE =
  "Running in backup mode (no AI right now), so answers may be less flexible.";

const BRING: Record<NeedType, string> = {
  refrigeration: "a cooler bag or container for the items that need to stay cold",
  device_power: "your device, its power cord, and any adapters",
  pharmacy: "your prescription bottle or ID, if you have them",
  food: "a bag or container, and ID if you have it",
  cooling: "water and anything you need to stay comfortable",
  charging: "your phone and charging cable",
  info: "nothing special",
};

export function bringFor(needType: NeedType): string {
  return BRING[needType];
}

/** FR-1: sent within 3 s of every inbound message. */
export function ackText(): string {
  return "Got it, finding help near you…";
}

/** FR-4: asked once, then conversation state is held. */
export function askLocationText(): string {
  return "What's your ZIP or nearest cross streets?";
}

export function clarifyNeedText(): string {
  return "Sorry, I didn't catch that. Do you need medicine, food, a cool place, or phone charging? Tell me which, and your ZIP.";
}

export function infoText(): string {
  return "I can point you to an open pharmacy, food site, cooling center, or charging station that has power. Tell me what you need and your ZIP.";
}

export function locationNotFoundText(): string {
  return "I couldn't find that location. Please send your 5-digit ZIP.";
}

function withEmergencyLine(body: string, tier: Tier): string {
  return tier === "medical_critical"
    ? `${body}\nIf this is an emergency, call 911.`
    : body;
}

function withModeNotice(body: string, mode: ProcessingMode): string {
  return mode === "degraded" ? `${body}\n${BACKUP_MODE_NOTICE}` : body;
}

/** FR-5 + FR-6: name, address, distance, hours, what to bring, and the reason. */
export function routedReplyText(args: {
  match: Match;
  needType: NeedType;
  tier: Tier;
  mode: ProcessingMode;
}): string {
  const { match, needType, tier, mode } = args;
  const { resource, distanceMiles, reason } = match;
  const body = [
    `Go to: ${resource.name}`,
    `${resource.address} (${distanceMiles.toFixed(1)} mi)`,
    `Hours: ${formatHours(resource.hours)}`,
    `Bring: ${bringFor(needType)}`,
    `Chosen: ${reason}`,
  ].join("\n");
  return withModeNotice(withEmergencyLine(body, tier), mode);
}

export function noMatchText(args: { tier: Tier; mode: ProcessingMode }): string {
  const body =
    "I couldn't find an open place with power nearby for that right now. Try again in a bit, or send a different ZIP.";
  return withModeNotice(withEmergencyLine(body, args.tier), args.mode);
}
