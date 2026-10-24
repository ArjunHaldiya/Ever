import type {
  ConverseCommandInput,
  ConverseCommandOutput,
  ToolSpecification,
} from "@aws-sdk/client-bedrock-runtime";
import {
  buildReplyUserPrompt,
  detectEmergency,
  EXTRACTOR_SYSTEM_PROMPT,
  extractNeedByRules,
  parseRecordNeed,
  RECORD_NEED_TOOL,
  replySystemPrompt,
  validateWrittenReply,
  type AiMode,
  type ExtractedNeed,
  type ExtractionMeta,
  type Language,
  type Match,
  type NeedType,
  type ProcessingMode,
  type Tier,
} from "@ever/core";

/**
 * Bedrock calls for the worker. The Converse call is injected (`ConverseFn`) so
 * the logic is testable without AWS; `makeConverse` builds the real one.
 * Any error, timeout or unusable output falls back to the rules extractor / the
 * template reply, so a Bedrock problem never loses a request (FR-9).
 * Never log message text or phone numbers from here.
 */

export type ConverseFn = (
  input: ConverseCommandInput,
  signal: AbortSignal,
) => Promise<ConverseCommandOutput>;

/** CLAUDE.md: Bedrock gets 4 s before we fall back. */
export const BEDROCK_TIMEOUT_MS = 4000;

export class BedrockTimeoutError extends Error {
  constructor(ms: number) {
    super(`Bedrock call exceeded ${ms} ms`);
    this.name = "BedrockTimeoutError";
  }
}

export class BedrockParseError extends Error {
  constructor(what: string) {
    super(`Bedrock returned unusable ${what}`);
    this.name = "BedrockParseError";
  }
}

/** Real Converse call. Imported lazily so tests never construct an SDK client. */
export async function makeConverse(region: string): Promise<ConverseFn> {
  const { BedrockRuntimeClient, ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
  const client = new BedrockRuntimeClient({ region });
  return (input, signal) => client.send(new ConverseCommand(input), { abortSignal: signal });
}

function callWithTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new BedrockTimeoutError(ms));
    }, ms);
    run(controller.signal).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export async function extractWithBedrock(args: {
  converse: ConverseFn;
  modelId: string;
  text: string;
  timeoutMs?: number;
}): Promise<ExtractedNeed> {
  const { converse, modelId, text, timeoutMs = BEDROCK_TIMEOUT_MS } = args;
  const out = await callWithTimeout(timeoutMs, (signal) =>
    converse(
      {
        modelId,
        system: [{ text: EXTRACTOR_SYSTEM_PROMPT }],
        // The person's message is only ever the user turn, never part of the system prompt.
        messages: [{ role: "user", content: [{ text }] }],
        toolConfig: {
          tools: [{ toolSpec: RECORD_NEED_TOOL as unknown as ToolSpecification }],
          toolChoice: { tool: { name: RECORD_NEED_TOOL.name } },
        },
        inferenceConfig: { maxTokens: 300, temperature: 0 },
      },
      signal,
    ),
  );
  const block = out.output?.message?.content?.find(
    (b) => b.toolUse?.name === RECORD_NEED_TOOL.name,
  );
  const need = parseRecordNeed(block?.toolUse?.input);
  if (!need) throw new BedrockParseError("record_need output");
  return need;
}

export type ExtractDeps = {
  /** null when no model is configured. */
  converse: ConverseFn | null;
  modelId: string;
  /** The chaos flag (SSM /app/ai_mode). */
  aiMode: AiMode;
  timeoutMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
};

export type Extraction = {
  extracted: ExtractedNeed;
  /** `ai` only when Bedrock produced the extraction; anything else is `degraded`. */
  mode: ProcessingMode;
  meta: ExtractionMeta;
};

function reasonFor(err: unknown): NonNullable<ExtractionMeta["fallbackReason"]> {
  if (err instanceof BedrockTimeoutError) return "timeout";
  if (err instanceof BedrockParseError) return "parse_failed";
  return "error";
}

/**
 * AI path with automatic fallback: Bedrock when the flag and model allow it,
 * otherwise (or on any failure) the rules extractor in degraded mode.
 * The emergency phrase check always applies, whichever extractor ran.
 */
export async function extractNeed(deps: ExtractDeps, text: string): Promise<Extraction> {
  const now = deps.now ?? Date.now;
  const started = now();
  const emergency = detectEmergency(text);

  const fallback = (reason: NonNullable<ExtractionMeta["fallbackReason"]>): Extraction => ({
    extracted: extractNeedByRules(text),
    mode: "degraded",
    meta: { extractor: "rules", modelId: null, latencyMs: now() - started, fallbackReason: reason },
  });

  if (deps.aiMode === "degraded") return fallback("chaos");
  if (!deps.converse || !deps.modelId) return fallback("no_model");

  try {
    const extracted = await extractWithBedrock({
      converse: deps.converse,
      modelId: deps.modelId,
      text,
      timeoutMs: deps.timeoutMs,
    });
    return {
      extracted: emergency
        ? { ...extracted, emergency: true, tier: "medical_critical" }
        : extracted,
      mode: "ai",
      meta: {
        extractor: "bedrock",
        modelId: deps.modelId,
        latencyMs: now() - started,
        fallbackReason: null,
      },
    };
  } catch (err) {
    return fallback(reasonFor(err));
  }
}

export type PhraseDeps = {
  converse: ConverseFn | null;
  modelId: string;
  timeoutMs?: number;
};

export type PhrasedReply = {
  text: string;
  replyBy: "bedrock" | "template";
  /** Why the template was used instead; null when Bedrock's text was sent. */
  fallbackReason: string | null;
};

/**
 * Let Bedrock phrase the routed reply (and translate it for es/vi), then check it
 * against the matcher's facts. The template text is the fallback for every failure.
 */
export async function phraseReply(
  deps: PhraseDeps,
  args: {
    match: Match;
    needType: NeedType;
    tier: Tier;
    language: Language;
    templateText: string;
    farMiles?: number;
  },
): Promise<PhrasedReply> {
  const template = (fallbackReason: string): PhrasedReply => ({
    text: args.templateText,
    replyBy: "template",
    fallbackReason,
  });
  if (!deps.converse || !deps.modelId) return template("no_model");

  let written: string;
  try {
    const out = await callWithTimeout(deps.timeoutMs ?? BEDROCK_TIMEOUT_MS, (signal) =>
      deps.converse!(
        {
          modelId: deps.modelId,
          system: [{ text: replySystemPrompt(args) }],
          messages: [{ role: "user", content: [{ text: buildReplyUserPrompt(args) }] }],
          inferenceConfig: { maxTokens: 400, temperature: 0.2 },
        },
        signal,
      ),
    );
    written = (out.output?.message?.content ?? [])
      .map((b) => b.text ?? "")
      .join("")
      .trim();
  } catch (err) {
    return template(err instanceof BedrockTimeoutError ? "timeout" : "error");
  }

  const check = validateWrittenReply(written, args.match, {
    tier: args.tier,
    ...(args.farMiles === undefined ? {} : { farMiles: args.farMiles }),
  });
  return check.ok
    ? { text: written, replyBy: "bedrock", fallbackReason: null }
    : template(`invalid_${check.reason}`);
}
