import { ackText, InboundMessageSchema, isStopRequest, logEvent, type InboundMessage } from "@ever/core";

/**
 * Inbound half of the gateway: verify, dedupe, enqueue, acknowledge. It does no real work
 * (that is the worker's job) because Photon delivers each message once and never retries,
 * so a message we fail to enqueue is lost. Hence the enqueue retries and the apology.
 */

export type InboundEvent = {
  messageId: string;
  sender: string;
  text: string;
  receivedAt: Date;
  /** Sends a text back into the conversation this message arrived in. */
  reply: (text: string) => Promise<void>;
};

export type InboundDeps = {
  claim: (key: string) => Promise<boolean>;
  release: (key: string) => Promise<void>;
  enqueue: (message: InboundMessage) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
};

export type InboundOutcome = "enqueued" | "duplicate" | "empty" | "failed";

const ENQUEUE_ATTEMPTS = 3;
const SORRY_TEXT = "Sorry, something went wrong on our side. Please send your message again.";

export async function handleInboundText(deps: InboundDeps, evt: InboundEvent): Promise<InboundOutcome> {
  if (!evt.text.trim()) return "empty";

  const key = `in:${evt.messageId}`;
  if (!(await deps.claim(key))) {
    logEvent("inbound_duplicate", { messageId: evt.messageId });
    return "duplicate";
  }

  const message = InboundMessageSchema.parse({
    messageId: evt.messageId,
    sender: evt.sender,
    text: evt.text,
    receivedAt: evt.receivedAt.toISOString(),
    provider: "photon",
  });

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; attempt <= ENQUEUE_ATTEMPTS; attempt++) {
    try {
      await deps.enqueue(message);
      logEvent("inbound_enqueued", { messageId: evt.messageId, attempt });
      // FR-1: acknowledge after the message is safely queued. A failed ack must not undo that.
      // A STOP gets its own confirmation from the worker, not "finding help near you".
      if (!isStopRequest(evt.text)) await evt.reply(ackText()).catch((err) =>
        logEvent("ack_failed", { messageId: evt.messageId, error: err instanceof Error ? err.name : "unknown" }),
      );
      return "enqueued";
    } catch (err) {
      logEvent("enqueue_failed", {
        messageId: evt.messageId,
        attempt,
        error: err instanceof Error ? err.name : "unknown",
      });
      if (attempt < ENQUEUE_ATTEMPTS) await sleep(150 * attempt ** 2);
    }
  }

  // Could not queue it: free the claim and tell the person to resend rather than lose it silently.
  await deps.release(key).catch(() => undefined);
  await evt.reply(SORRY_TEXT).catch(() => undefined);
  return "failed";
}
