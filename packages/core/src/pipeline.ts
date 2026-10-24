import { detectEmergency, emergencyReply } from "./emergency";
import { extractZip, lookupZip, roundCoord, type ZipCentroids } from "./geo";
import { rankResources, type Match } from "./matcher";
import { redactPii } from "./pii";
import { extractLocationText } from "./rulesExtractor";
import {
  askLocationText,
  clarifyNeedText,
  infoText,
  locationNotFoundText,
  noMatchText,
  routedReplyText,
} from "./templates";
import type {
  ExtractedNeed,
  LatLng,
  NeedStatus,
  ProcessingMode,
  Resource,
} from "./types";

/**
 * The decision step shared by the local loop and the worker. It is given an
 * already-extracted need (AI or rules) and returns what to say and what to
 * persist; it does no I/O itself. Callers run the emergency check and the
 * extractor first, and handle idempotency, storage and sending.
 */

/** Held between the "what's your ZIP?" question and the answer (Conversations table). */
export type ConversationState = {
  needId: string;
  extracted: ExtractedNeed;
  /** Already redacted: raw message text is never kept in state. */
  redactedText: string;
  /** ISO 8601 */
  startedAt: string;
};

export const CONVERSATION_TTL_MS = 30 * 60 * 1000;

/** Shape of a Needs row, minus createdAt/routedAt which the caller stamps. */
export type NeedDraft = {
  id: string;
  tier: ExtractedNeed["tier"];
  needType: ExtractedNeed["needType"];
  language: ExtractedNeed["language"];
  emergency: boolean;
  latRounded: number | null;
  lngRounded: number | null;
  zip: string | null;
  status: NeedStatus;
  resourceId: string | null;
  mode: ProcessingMode;
  redactedText: string;
};

export type PipelineDeps = {
  resources: readonly Resource[];
  /** Resolve free-text location to coordinates, or null. Errors are treated as null. */
  geocode: (locationText: string) => Promise<LatLng | null>;
  newNeedId: () => string;
  now: Date;
};

export type PipelineInput = {
  text: string;
  extracted: ExtractedNeed;
  mode: ProcessingMode;
  conversation: ConversationState | null;
};

export type PipelineResult = {
  /** Messages to send, in order. */
  replies: string[];
  need: NeedDraft;
  /** State to persist; null clears it. */
  conversation: ConversationState | null;
  match: Match | null;
};

/** Offline geocoder: only resolves text containing a seeded ZIP. */
export function zipGeocoder(centroids: ZipCentroids) {
  return async (locationText: string): Promise<LatLng | null> => {
    const zip = extractZip(locationText);
    return zip ? lookupZip(centroids, zip) : null;
  };
}

function isConfidentNeed(e: ExtractedNeed): boolean {
  return e.needType !== "info" && e.confidence >= 0.5;
}

async function safeGeocode(
  geocode: PipelineDeps["geocode"],
  locationText: string,
): Promise<LatLng | null> {
  try {
    return await geocode(locationText);
  } catch {
    return null;
  }
}

function draftOf(
  id: string,
  extracted: ExtractedNeed,
  fields: {
    status: NeedStatus;
    mode: ProcessingMode;
    redactedText: string;
    origin?: LatLng | null;
    zip?: string | null;
    resourceId?: string | null;
    emergency: boolean;
  },
): NeedDraft {
  return {
    id,
    tier: extracted.tier,
    needType: extracted.needType,
    language: extracted.language,
    emergency: fields.emergency,
    latRounded: fields.origin ? roundCoord(fields.origin.lat) : null,
    lngRounded: fields.origin ? roundCoord(fields.origin.lng) : null,
    zip: fields.zip ?? null,
    status: fields.status,
    resourceId: fields.resourceId ?? null,
    mode: fields.mode,
    redactedText: fields.redactedText,
  };
}

export async function processMessage(
  input: PipelineInput,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const { text, mode } = input;
  const emergency = input.extracted.emergency || detectEmergency(text);
  const replies: string[] = emergency ? [emergencyReply(input.extracted.language)] : [];

  const held =
    input.conversation &&
    deps.now.getTime() - new Date(input.conversation.startedAt).getTime() < CONVERSATION_TTL_MS
      ? input.conversation
      : null;
  // A fresh, confident request replaces a pending question instead of answering it.
  const answeringLocation = held !== null && !isConfidentNeed(input.extracted);

  const extracted = answeringLocation ? held.extracted : input.extracted;
  const needId = answeringLocation ? held.needId : deps.newNeedId();
  const redactedText = answeringLocation ? held.redactedText : redactPii(text);
  const locationText = input.extracted.locationText ?? extractLocationText(text);
  const base = { mode, redactedText, emergency };

  // Nothing actionable: ask what they need (but never bury the 911 line).
  if (!answeringLocation && extracted.needType === "info") {
    if (!emergency) {
      replies.push(extracted.confidence < 0.5 ? clarifyNeedText() : infoText());
    }
    return {
      replies,
      need: draftOf(needId, extracted, { ...base, status: "new" }),
      conversation: null,
      match: null,
    };
  }

  const origin = locationText ? await safeGeocode(deps.geocode, locationText) : null;
  const zip = locationText ? extractZip(locationText) : null;

  if (!origin) {
    // FR-4: ask once, then hold state. Later failed answers get a nudge, not the same question.
    replies.push(
      answeringLocation || locationText ? locationNotFoundText() : askLocationText(),
    );
    return {
      replies,
      need: draftOf(needId, extracted, { ...base, status: "awaiting_location" }),
      conversation: {
        needId,
        extracted,
        redactedText,
        startedAt: held && answeringLocation ? held.startedAt : deps.now.toISOString(),
      },
      match: null,
    };
  }

  const match =
    rankResources({
      needType: extracted.needType,
      origin,
      resources: deps.resources,
      now: deps.now,
    })[0] ?? null;

  replies.push(
    match
      ? routedReplyText({ match, needType: extracted.needType, tier: extracted.tier, mode })
      : noMatchText({ tier: extracted.tier, mode }),
  );
  return {
    replies,
    need: draftOf(needId, extracted, {
      ...base,
      origin,
      zip,
      status: match ? "routed" : "new",
      resourceId: match?.resource.id ?? null,
    }),
    conversation: null,
    match,
  };
}
