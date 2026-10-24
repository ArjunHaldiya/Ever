import { z } from "zod";
import { parseHours } from "./hours";

export const TIERS = ["medical_critical", "food", "shelter_cooling", "info"] as const;
export const NEED_TYPES = [
  "refrigeration",
  "device_power",
  "pharmacy",
  "food",
  "cooling",
  "charging",
  "info",
] as const;
export const LANGUAGES = ["en", "es", "vi"] as const;
export const RESOURCE_TYPES = [
  "pharmacy",
  "cooling_center",
  "food_site",
  "charging_station",
] as const;
export const NEED_STATUSES = ["new", "routed", "awaiting_location", "failed"] as const;
/** Value of the SSM chaos flag `/app/ai_mode`. */
export const AI_MODES = ["primary", "degraded"] as const;
/** Which path actually served a request (stored on the Needs row). */
export const PROCESSING_MODES = ["ai", "degraded"] as const;

export const TierSchema = z.enum(TIERS);
export const NeedTypeSchema = z.enum(NEED_TYPES);
export const LanguageSchema = z.enum(LANGUAGES);
export const ResourceTypeSchema = z.enum(RESOURCE_TYPES);
export const NeedStatusSchema = z.enum(NEED_STATUSES);
export const AiModeSchema = z.enum(AI_MODES);
export const ProcessingModeSchema = z.enum(PROCESSING_MODES);

/** Contract returned by both the Bedrock extractor and the rules extractor. */
export const ExtractedNeedSchema = z.object({
  emergency: z.boolean(),
  tier: TierSchema,
  needType: NeedTypeSchema,
  locationText: z.string().nullable(),
  language: LanguageSchema,
  /** 0..1; below 0.5 means ask a clarifying question. */
  confidence: z.number().min(0).max(1),
});

export const ResourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: ResourceTypeSchema,
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: z.string().min(1),
  hasPower: z.boolean(),
  capacity: z.number().int().nonnegative(),
  capacityUnit: z.string().min(1),
  /** "24/7" or "HH:MM-HH:MM"; see hours.ts. */
  hours: z.string().refine((h) => parseHours(h) !== null, {
    message: 'hours must be "24/7" or "HH:MM-HH:MM"',
  }),
  supports: z.array(NeedTypeSchema),
});

/** Fallback geocoder table: ZIP -> centroid. */
export const ZipCentroidsSchema = z.record(
  z.string().regex(/^\d{5}$/),
  z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
);

/** Opted-in resident for the shutoff-warning demo (seed/demo_residents*.json). */
export const DemoResidentSchema = z.object({
  /** Phone number or iMessage handle. Real values live only in the gitignored .local file. */
  handle: z.string().min(1),
  zip: z.string().regex(/^\d{5}$/),
  needType: NeedTypeSchema,
});

/**
 * Body of each SQS message, written by the gateway. `sender` is the provider's
 * opaque handle (an iMessage handle can be a phone number or an email); it is
 * only needed to reply and must never be logged.
 */
export const InboundMessageSchema = z.object({
  messageId: z.string().min(1),
  sender: z.string().min(1),
  text: z.string(),
  /** ISO 8601 */
  receivedAt: z.string().datetime(),
  provider: z.string().min(1),
});

export const ChaosBodySchema = z.object({ mode: AiModeSchema });

export const ShutoffBodySchema = z.object({
  zip: z.string().regex(/^\d{5}$/, "zip must be 5 digits"),
  /** ISO 8601 */
  shutoffAt: z.string().datetime({ offset: true }),
});
