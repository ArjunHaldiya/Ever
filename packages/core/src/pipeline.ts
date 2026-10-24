import { z } from "zod";
import { detectEmergency, emergencyReply } from "./emergency";
import { extractZip, lookupZip, type ZipCentroids } from "./geo";
import { ExtractedNeedSchema, ExtractionMetaSchema } from "./schemas";
import { rankResources, type Match } from "./matcher";
import { extractLocationText } from "./rulesExtractor";
import {
  askLocationText,
  clarifyNeedText,
  infoText,
  locationNotFoundText,
  noMatchText,
  type NearbyPlace,
  routedReplyText,
} from "./templates";
import type {
  ExtractedNeed,
  ExtractionMeta,
  LatLng,
  NeedStatus,
  NeedType,
  ProcessingMode,
  Resource,
} from "./types";

/**
 * The decision step shared by the local loop and the worker. It is given an
 * already-extracted need (AI or rules) and returns what to say and what to
 * persist; it does no I/O itself. Callers run the emergency check and the
 * extractor first, and handle idempotency, storage and sending.
 */

/**
 * Held between the "what's your ZIP?" question and the answer (Conversations table, short TTL).
 * It keeps only what is needed to finish the request: the kind of need and how it was extracted.
 * No message text and no location (the held `locationText` is cleared before saving).
 */
export const ConversationStateSchema = z.object({
  needId: z.string(),
  extracted: ExtractedNeedSchema,
  /** How the original message was extracted, so the Needs row keeps showing Bedrock's work. */
  extraction: ExtractionMetaSchema,
  /** ISO 8601 */
  startedAt: z.string(),
});
export type ConversationState = z.infer<typeof ConversationStateSchema>;

/** Used when a caller doesn't say how it extracted (tests, the local loop). */
export const RULES_EXTRACTION: ExtractionMeta = {
  extractor: "rules",
  modelId: null,
  latencyMs: 0,
  fallbackReason: null,
};

/**
 * Beyond this distance the closest open place is still named (it is the best answer we have),
 * but the reply first says plainly that nothing is open within this many miles.
 */
export const DEFAULT_FAR_MILES = 20;

/**
 * A confirmed place farther than this is not an answer (it could be another state): the reply
 * falls back to nearby real places and 211 instead. Roughly a regional drive.
 */
export const MAX_USEFUL_MILES = 100;

/** When closer unverified places are listed, a confirmed place is only worth adding if it is within this many miles. */
export const MAX_CONFIRMED_FAR_WITH_LIST_MILES = 30;

export const CONVERSATION_TTL_MS = 30 * 60 * 1000;

/**
 * Shape of a Needs row, minus createdAt/routedAt which the caller stamps.
 * Data minimization: it deliberately holds no message text, no location, no ZIP and no chosen
 * place or distance (a place plus a distance is a location in disguise). Only the kind of need
 * and how the system handled it.
 */
export type NeedDraft = {
  id: string;
  tier: ExtractedNeed["tier"];
  needType: ExtractedNeed["needType"];
  language: ExtractedNeed["language"];
  emergency: boolean;
  status: NeedStatus;
  /** How many unverified nearby places the reply listed. */
  unverifiedShown: number;
  mode: ProcessingMode;
  extractor: ExtractionMeta["extractor"];
  modelId: string | null;
  latencyMs: number;
  fallbackReason: ExtractionMeta["fallbackReason"];
};

export type PipelineDeps = {
  resources: readonly Resource[];
  /** Resolve free-text location to coordinates, or null. Errors are treated as null. */
  geocode: (locationText: string) => Promise<LatLng | null>;
  newNeedId: () => string;
  now: Date;
  /** Overrides DEFAULT_FAR_MILES. */
  farMiles?: number;
  /**
   * Real places near a point when nothing confirmed is in range (e.g. pharmacies from a place
   * search). Open hours and power are unknown, so replies label them unverified. Errors are ignored.
   */
  findNearby?: (needType: NeedType, origin: LatLng) => Promise<NearbyPlace[]>;
};

export type PipelineInput = {
  text: string;
  extracted: ExtractedNeed;
  /** How `extracted` was produced. Defaults to the rules extractor. */
  extraction?: ExtractionMeta;
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
  /** The threshold, when the match is farther than it; otherwise null. */
  farMiles: number | null;
  /** True when the reply is the "no confirmed place in range" answer (template text, not Bedrock-phrased). */
  areaFallback: boolean;
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
    unverifiedShown?: number;
    emergency: boolean;
    extraction: ExtractionMeta;
  },
): NeedDraft {
  return {
    id,
    tier: extracted.tier,
    needType: extracted.needType,
    language: extracted.language,
    emergency: fields.emergency,
    status: fields.status,
    unverifiedShown: fields.unverifiedShown ?? 0,
    mode: fields.mode,
    extractor: fields.extraction.extractor,
    modelId: fields.extraction.modelId,
    latencyMs: fields.extraction.latencyMs,
    fallbackReason: fields.extraction.fallbackReason,
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
  const extraction = answeringLocation
    ? held.extraction
    : (input.extraction ?? RULES_EXTRACTION);
  const language = extracted.language;
  const locationText = input.extracted.locationText ?? extractLocationText(text);
  const base = { mode, emergency, extraction };

  // Nothing actionable: ask what they need (but never bury the 911 line).
  if (!answeringLocation && extracted.needType === "info") {
    if (!emergency) {
      replies.push(
        extracted.confidence < 0.5 ? clarifyNeedText(language) : infoText(language),
      );
    }
    return {
      replies,
      need: draftOf(needId, extracted, { ...base, status: "new" }),
      conversation: null,
      match: null,
      farMiles: null,
      areaFallback: false,
    };
  }

  const origin = locationText ? await safeGeocode(deps.geocode, locationText) : null;

  if (!origin) {
    // FR-4: ask once, then hold state. Later failed answers get a nudge, not the same question.
    replies.push(
      answeringLocation || locationText
        ? locationNotFoundText(language)
        : askLocationText(language),
    );
    return {
      replies,
      need: draftOf(needId, extracted, { ...base, status: "awaiting_location" }),
      conversation: {
        needId,
        // The place they mentioned is not kept, even in this short-lived state.
        extracted: { ...extracted, locationText: null },
        extraction,
        startedAt: held && answeringLocation ? held.startedAt : deps.now.toISOString(),
      },
      match: null,
      farMiles: null,
      areaFallback: false,
    };
  }

  const closest =
    rankResources({
      needType: extracted.needType,
      origin,
      resources: deps.resources,
      now: deps.now,
    })[0] ?? null;
  const match = closest && closest.distanceMiles <= MAX_USEFUL_MILES ? closest : null;
  const threshold = deps.farMiles ?? DEFAULT_FAR_MILES;
  const farMiles = match && match.distanceMiles > threshold ? threshold : null;

  // Nothing confirmed in range: look for real (unverified) places nearby before falling back to 211.
  let nearby: NearbyPlace[] = [];
  if ((!match || farMiles !== null) && deps.findNearby) {
    nearby = await deps.findNearby(extracted.needType, origin).catch(() => []);
  }
  // A far confirmed answer stands on its own unless we also have closer unverified places to list.
  const areaFallback = !match || (farMiles !== null && nearby.length > 0);

  replies.push(
    areaFallback
      ? noMatchText({
          tier: extracted.tier,
          mode,
          language,
          needType: extracted.needType,
          miles: threshold,
          places: nearby,
          ...(match && (nearby.length === 0 || match.distanceMiles <= MAX_CONFIRMED_FAR_WITH_LIST_MILES)
            ? { confirmedFar: match }
            : {}),
        })
      : routedReplyText({
          match: match!,
          needType: extracted.needType,
          tier: extracted.tier,
          mode,
          ...(farMiles === null ? {} : { farMiles }),
        }),
  );
  return {
    replies,
    need: draftOf(needId, extracted, {
      ...base,
      status: match && !areaFallback ? "routed" : "new",
      unverifiedShown: nearby.length,
    }),
    conversation: null,
    match,
    farMiles,
    areaFallback,
  };
}
