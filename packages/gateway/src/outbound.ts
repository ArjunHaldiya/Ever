import { logEvent, OutboundMessageSchema } from "@ever/core";
import { onWarningSent, watchDelivery, type AlertStore, type DeliveryInfo } from "./alerts";

/**
 * Outbound half of the gateway: take replies the worker queued and send them through Photon.
 * A message is deleted from the queue only after it was sent. If sending throws, it is left
 * in the queue, becomes visible again after the visibility timeout, and after 3 receives
 * moves to the outbound DLQ, so a reply is never silently dropped.
 */

export type QueuedMessage = { body: string; receipt: string };

export type OutboundQueue = {
  /** Long-polls for up to a few messages. */
  receive: () => Promise<QueuedMessage[]>;
  remove: (receipt: string) => Promise<void>;
};

export type SendResult = {
  /** Photon ids of the messages that were sent, in order (a send can return no id). */
  messageIds: (string | undefined)[];
  /** Looks a sent message up again to see whether it has been delivered / read. */
  checkDelivery?: (messageId: string) => Promise<DeliveryInfo | null>;
};

export type Sender = {
  /** Send each text, in order, to the recipient handle. */
  sendTexts: (to: string, texts: string[]) => Promise<SendResult>;
};

/** Hooks for shutoff warnings, which are tracked after they are sent. */
export type WarningTracking = {
  store: AlertStore;
  now?: () => Date;
  /** Starts the delivery watch without blocking the queue loop. Defaults to watchDelivery run in the background. */
  watch?: typeof watchDelivery;
};

/** Returns how many messages were delivered. Never throws for a single bad message. */
export async function drainOutboundOnce(
  queue: OutboundQueue,
  sender: Sender,
  tracking?: WarningTracking,
): Promise<number> {
  const batch = await queue.receive();
  let delivered = 0;
  for (const item of batch) {
    try {
      const message = OutboundMessageSchema.parse(JSON.parse(item.body));
      const key = message.kind === "warning" && message.alertId && message.phoneHash
        ? { alertId: message.alertId, phoneHash: message.phoneHash }
        : null;
      let result: SendResult;
      try {
        result = await sender.sendTexts(message.to, message.texts);
      } catch (err) {
        if (key && tracking) await tracking.store.markError(key, "send failed").catch(() => undefined);
        throw err;
      }
      await queue.remove(item.receipt);
      if (key && tracking) {
        const messageId = result.messageIds[0];
        const now = tracking.now ?? (() => new Date());
        await onWarningSent(tracking.store, key, messageId, now()).catch((err) =>
          logEvent("alert_record_failed", { error: err instanceof Error ? err.name : "unknown" }),
        );
        if (messageId && result.checkDelivery) {
          const watch = tracking.watch ?? watchDelivery;
          void watch({ store: tracking.store, key, messageId, check: result.checkDelivery });
        }
      }
      delivered += 1;
      logEvent("outbound_sent", { needId: message.needId, kind: message.kind, parts: message.texts.length });
    } catch (err) {
      logEvent("outbound_failed", { error: err instanceof Error ? err.name : "unknown" });
    }
  }
  return delivered;
}
