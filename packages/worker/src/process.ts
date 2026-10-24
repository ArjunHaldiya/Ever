import {
  logEvent,
  processMessage,
  stopReplyText,
  stopRequestLanguage,
  type AiMode,
  type ConversationState,
  type InboundMessage,
  type LatLng,
  type NearbyPlace,
  type NeedType,
  type NeedDraft,
  type OutboundMessage,
  type Resource,
} from "@ever/core";
import { extractNeed, phraseReply, type ConverseFn } from "./bedrock";

/**
 * The worker's whole job for one inbound message, with every AWS call injected so it
 * can be tested without AWS. Order matters for safe retries (SQS is at-least-once):
 *   claim -> read state -> extract -> decide -> save need -> queue reply -> save conversation
 * A failure at any step releases the claim and throws, so SQS retries and, after 3
 * tries, the message lands in the DLQ. The conversation is written last so a retry
 * still sees the state the first attempt started from.
 */

export type NeedRecord = NeedDraft & {
  createdAt: string;
  routedAt: string | null;
  /** Who wrote the reply text sent to the person. */
  replyBy: "bedrock" | "template";
  replyFallbackReason: string | null;
};

export type WorkerDeps = {
  now: () => Date;
  hashSender: (sender: string) => string;
  getAiMode: () => Promise<AiMode>;
  getResources: () => Promise<readonly Resource[]>;
  geocode: (locationText: string) => Promise<LatLng | null>;
  /** Real nearby places when nothing confirmed is in range (unverified). Optional. */
  findNearby?: (needType: NeedType, origin: LatLng) => Promise<NearbyPlace[]>;
  converse: ConverseFn | null;
  modelId: string;
  store: {
    /** True if this is the first claim of the key; false if it was already claimed. */
    claim: (key: string) => Promise<boolean>;
    release: (key: string) => Promise<void>;
    getConversation: (phoneHash: string) => Promise<ConversationState | null>;
    /** null clears the held conversation. */
    putConversation: (phoneHash: string, state: ConversationState | null, now: Date) => Promise<void>;
    putNeed: (need: NeedRecord) => Promise<void>;
    /**
     * STOP: stop all shutoff warnings to this person and forget their phone number and ZIP.
     * Does nothing for someone who is not a resident. Safe to repeat.
     */
    optOutResident: (phoneHash: string, now: Date) => Promise<void>;
  };
  sendOutbound: (message: OutboundMessage) => Promise<void>;
};

export type Outcome =
  | { status: "duplicate" }
  | { status: "stopped" }
  | { status: "processed"; needId: string; needStatus: NeedRecord["status"]; mode: NeedRecord["mode"]; totalMs: number };

export async function processInbound(deps: WorkerDeps, msg: InboundMessage): Promise<Outcome> {
  const claimKey = `wk:${msg.messageId}`;
  if (!(await deps.store.claim(claimKey))) {
    logEvent("duplicate_skipped", { messageId: msg.messageId });
    return { status: "duplicate" };
  }

  const started = deps.now();
  try {
    const phoneHash = deps.hashSender(msg.sender);

    // STOP is handled before anything else: no extraction, no AI, no Need row, nothing stored.
    const stopLanguage = stopRequestLanguage(msg.text);
    if (stopLanguage) {
      await deps.store.optOutResident(phoneHash, started);
      await deps.store.putConversation(phoneHash, null, started);
      await deps.sendOutbound({
        to: msg.sender,
        texts: [stopReplyText(stopLanguage)],
        needId: `stop_${msg.messageId}`,
        kind: "reply",
      });
      logEvent("resident_stopped", { messageId: msg.messageId });
      return { status: "stopped" };
    }

    const [aiMode, resources, conversation] = await Promise.all([
      deps.getAiMode(),
      deps.getResources(),
      deps.store.getConversation(phoneHash),
    ]);

    const extraction = await extractNeed(
      { converse: deps.converse, modelId: deps.modelId, aiMode },
      msg.text,
    );

    const result = await processMessage(
      {
        text: msg.text,
        extracted: extraction.extracted,
        extraction: extraction.meta,
        mode: extraction.mode,
        conversation,
      },
      {
        resources,
        geocode: deps.geocode,
        ...(deps.findNearby ? { findNearby: deps.findNearby } : {}),
        // Derived from the message id so a retry upserts the same Needs row.
        newNeedId: () => `need_${msg.messageId}`,
        now: started,
      },
    );

    // On the AI path let Bedrock phrase (and translate) the routed answer; the template is the fallback.
    const replies = [...result.replies];
    let replyBy: NeedRecord["replyBy"] = "template";
    let replyFallbackReason: string | null = null;
    if (result.match && !result.areaFallback && extraction.mode === "ai") {
      const phrased = await phraseReply(
        { converse: deps.converse, modelId: deps.modelId },
        {
          match: result.match,
          needType: result.need.needType,
          tier: result.need.tier,
          language: result.need.language,
          templateText: replies[replies.length - 1]!,
          ...(result.farMiles === null ? {} : { farMiles: result.farMiles }),
        },
      );
      replies[replies.length - 1] = phrased.text;
      replyBy = phrased.replyBy;
      replyFallbackReason = phrased.fallbackReason;
    }

    const routedAt = result.need.status === "routed" ? deps.now().toISOString() : null;
    await deps.store.putNeed({
      ...result.need,
      createdAt: started.toISOString(),
      routedAt,
      replyBy,
      replyFallbackReason,
    });
    await deps.sendOutbound({ to: msg.sender, texts: replies, needId: result.need.id, kind: "reply" });
    await deps.store.putConversation(phoneHash, result.conversation, started);

    const totalMs = deps.now().getTime() - started.getTime();
    logEvent("processed", {
      needId: result.need.id,
      messageId: msg.messageId,
      status: result.need.status,
      mode: result.need.mode,
      extractor: result.need.extractor,
      fallbackReason: result.need.fallbackReason,
      replyBy,
      extractLatencyMs: result.need.latencyMs,
      totalMs,
    });
    return {
      status: "processed",
      needId: result.need.id,
      needStatus: result.need.status,
      mode: result.need.mode,
      totalMs,
    };
  } catch (err) {
    await deps.store.release(claimKey).catch(() => undefined);
    logEvent("process_failed", {
      messageId: msg.messageId,
      error: err instanceof Error ? err.name : "unknown",
    });
    throw err;
  }
}
