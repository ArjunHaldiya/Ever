import type { z } from "zod";
import type {
  AiModeSchema,
  ChaosBodySchema,
  ExtractedNeedSchema,
  InboundMessageSchema,
  LanguageSchema,
  NeedStatusSchema,
  NeedTypeSchema,
  ProcessingModeSchema,
  ResourceSchema,
  ResourceTypeSchema,
  ShutoffBodySchema,
  TierSchema,
} from "./schemas";

export type Tier = z.infer<typeof TierSchema>;
export type NeedType = z.infer<typeof NeedTypeSchema>;
export type Language = z.infer<typeof LanguageSchema>;
export type ResourceType = z.infer<typeof ResourceTypeSchema>;
export type NeedStatus = z.infer<typeof NeedStatusSchema>;
export type AiMode = z.infer<typeof AiModeSchema>;
export type ProcessingMode = z.infer<typeof ProcessingModeSchema>;
export type ExtractedNeed = z.infer<typeof ExtractedNeedSchema>;
export type Resource = z.infer<typeof ResourceSchema>;
export type InboundMessage = z.infer<typeof InboundMessageSchema>;
export type ChaosBody = z.infer<typeof ChaosBodySchema>;
export type ShutoffBody = z.infer<typeof ShutoffBodySchema>;

export type LatLng = { lat: number; lng: number };
