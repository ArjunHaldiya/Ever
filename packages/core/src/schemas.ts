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

/** Which extractor produced a need. Shown on the dashboard so Bedrock's work is visible. */
export const EXTRACTORS = ["bedrock", "rules"] as const;
/** Why Bedrock was skipped or abandoned for a request. */
export const FALLBACK_REASONS = ["chaos", "no_model", "timeout", "error", "parse_failed"] as const;

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

export const ExtractionMetaSchema = z.object({
  extractor: z.enum(EXTRACTORS),
  /** Bedrock model that answered; null when the rules extractor ran. */
  modelId: z.string().nullable(),
  latencyMs: z.number().int().nonnegative(),
  fallbackReason: z.enum(FALLBACK_REASONS).nullable(),
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

/**
 * Body of each message on the outbound queue (worker -> gateway -> Photon).
 * `texts` are sent in order; one SQS message keeps a 911 line ahead of the answer.
 * `to` is the provider handle and must never be logged.
 */
export const OutboundMessageSchema = z.object({
  to: z.string().min(1),
  texts: z.array(z.string().min(1)).min(1).max(5),
  needId: z.string().optional(),
  kind: z.enum(["reply", "warning"]),
  /** Set on warnings so the gateway can record sent / delivered / read against the right alert. */
  alertId: z.string().optional(),
  phoneHash: z.string().optional(),
});

/** One resident's warning, as stored in the Alerts table (key: alertId + phoneHash). */
export const AlertRecordSchema = z.object({
  alertId: z.string(),
  phoneHash: z.string(),
  zip: z.string(),
  /** ISO 8601 */
  shutoffAt: z.string(),
  /** Masked label for display, e.g. "***1234". The number itself is never returned to the dashboard. */
  label: z.string(),
  createdAt: z.string(),
  sentAt: z.string().nullable().optional(),
  deliveredAt: z.string().nullable().optional(),
  readAt: z.string().nullable().optional(),
  /** Photon id of the warning message, used to match delivery checks and read receipts. */
  messageId: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});

/** Add an opted-in resident from the dashboard. `phone` is normalized to E.164 on the server. */
export const AddResidentBodySchema = z.object({
  phone: z.string().min(7).max(32),
  zip: z.string().regex(/^\d{5}$/, "zip must be 5 digits"),
  needType: NeedTypeSchema.exclude(["info"]),
  firstName: z.string().trim().max(40).optional(),
});

export const RemoveResidentBodySchema = z.object({ phoneHash: z.string().min(1) });

export const ChaosBodySchema = z.object({ mode: AiModeSchema });

export const ShutoffBodySchema = z.object({
  zip: z.string().regex(/^\d{5}$/, "zip must be 5 digits"),
  /** ISO 8601 */
  shutoffAt: z.string().datetime({ offset: true }),
});
