import { z } from "zod";
import { AiModeSchema, NeedTypeSchema, ResourceSchema } from "./schemas";

/**
 * What GET /state returns to the responder dashboard, built by the API and validated by the dashboard.
 *
 * Privacy by design: this deliberately contains NO request locations, ZIP codes of requesters, message
 * text, phone numbers, or lists of residents. A responder needs to know where help is, not who asked.
 * The only thing derived from requests is `focus`: the kind of help most recently asked for, with no
 * location, text or identity attached. The API strips everything else before it leaves the server, so
 * even browser dev tools cannot see it.
 */

/** The kind of help most recently asked for. Highlights matching places until the next request. */
export const FocusSchema = z.object({
  needType: NeedTypeSchema.exclude(["info"]),
  /** ISO 8601 */
  at: z.string(),
});
export type Focus = z.infer<typeof FocusSchema>;

/**
 * The latest shutoff warning, as totals only: how many were sent, delivered and read. There are no
 * per-person rows at all. `zip` is the area the responder chose to warn, not where anyone is.
 */
export const WarningViewSchema = z.object({
  alertId: z.string(),
  zip: z.string(),
  shutoffAt: z.string(),
  createdAt: z.string(),
  total: z.number(),
  sent: z.number(),
  delivered: z.number(),
  read: z.number(),
  /** People the warning could not be sent to. */
  failed: z.number(),
});
export type WarningView = z.infer<typeof WarningViewSchema>;

export const QueueDepthSchema = z.object({
  visible: z.number(),
  inFlight: z.number(),
});

/** Aggregates only. Shown in the hidden demo panel, never per request. */
export const StatsSchema = z.object({
  requests: z.number(),
  bedrockPct: z.number().nullable(),
  avgExtractMs: z.number().nullable(),
  avgReplyMs: z.number().nullable(),
  modelId: z.string().nullable(),
});
export type Stats = z.infer<typeof StatsSchema>;

export const StateSchema = z.object({
  now: z.string(),
  places: z.array(ResourceSchema),
  focus: FocusSchema.nullable(),
  warning: WarningViewSchema.nullable(),
  system: z.object({
    aiMode: AiModeSchema,
    /** Whether the worker's queue trigger is on. null if it could not be read. */
    workerEnabled: z.boolean().nullable(),
    queues: z.object({
      inbound: QueueDepthSchema,
      inboundDlq: QueueDepthSchema,
      outbound: QueueDepthSchema,
      outboundDlq: QueueDepthSchema,
    }),
  }),
  stats: StatsSchema,
});
export type DashboardState = z.infer<typeof StateSchema>;

/** An opted-in resident as returned to the person who adds them. Never part of GET /state. */
export const ResidentViewSchema = z.object({
  phoneHash: z.string(),
  /** Masked label, e.g. "***1234". */
  label: z.string(),
  zip: z.string(),
  needType: NeedTypeSchema,
  /** The shared-line number this person texts (a public service number). */
  assignedNumber: z.string().nullable(),
  createdAt: z.string(),
});
export type ResidentView = z.infer<typeof ResidentViewSchema>;

export const WorkerBodySchema = z.object({ enabled: z.boolean() });
