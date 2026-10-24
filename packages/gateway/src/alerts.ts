import { logEvent } from "@ever/core";

/**
 * Tracks each shutoff warning through sent -> delivered -> read (FR-12).
 *  - sent: recorded when the gateway sends the warning (and its message id is remembered)
 *  - delivered: Photon has no delivery event, so the message is checked a few times after sending
 *  - read: arrives as a read receipt on the message stream, matched back through the message id
 * All storage is injected so this is testable without AWS.
 */

export type AlertKey = { alertId: string; phoneHash: string };

export type AlertStore = {
  /** Records sentAt and the Photon message id, clears any error, and remembers id -> alert. */
  markSent: (key: AlertKey, messageId: string, at: Date) => Promise<void>;
  /** Sets deliveredAt only if it is not set yet. */
  markDelivered: (key: AlertKey, at: Date) => Promise<void>;
  /** Sets readAt (and deliveredAt, since a read message was delivered) only if not set yet. */
  markRead: (key: AlertKey, at: Date) => Promise<void>;
  markError: (key: AlertKey, error: string) => Promise<void>;
  lookupSent: (messageId: string) => Promise<AlertKey | null>;
};

export type DeliveryInfo = { delivered: boolean; deliveredAt?: Date; readAt?: Date };

/** When to re-check a sent warning for delivery, in ms after sending. */
export const DELIVERY_CHECK_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 40_000, 90_000];

export async function onWarningSent(store: AlertStore, key: AlertKey, messageId: string | undefined, at: Date): Promise<void> {
  if (!messageId) {
    // Sent, but Photon returned no id, so delivery and read can't be matched.
    await store.markError(key, "sent without a message id");
    return;
  }
  await store.markSent(key, messageId, at);
}

/** Matches a read receipt to a warning we sent. Receipts for ordinary replies have no match and are ignored. */
export async function onReadReceipt(store: AlertStore, targetMessageId: string, readAt: Date): Promise<boolean> {
  const key = await store.lookupSent(targetMessageId);
  if (!key) return false;
  await store.markRead(key, readAt);
  logEvent("warning_read", { alertId: key.alertId });
  return true;
}

/** Re-checks a sent warning until it shows as delivered (or the schedule runs out). Never throws. */
export async function watchDelivery(args: {
  store: AlertStore;
  key: AlertKey;
  messageId: string;
  check: (messageId: string) => Promise<DeliveryInfo | null>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  delaysMs?: number[];
}): Promise<void> {
  const now = args.now ?? (() => new Date());
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let waited = 0;
  for (const delay of args.delaysMs ?? DELIVERY_CHECK_DELAYS_MS) {
    await sleep(delay - waited);
    waited = delay;
    try {
      const info = await args.check(args.messageId);
      if (info?.delivered) {
        await args.store.markDelivered(args.key, info.deliveredAt ?? now());
        if (info.readAt) await args.store.markRead(args.key, info.readAt);
        logEvent("warning_delivered", { alertId: args.key.alertId });
        return;
      }
    } catch (err) {
      logEvent("delivery_check_failed", { error: err instanceof Error ? err.name : "unknown" });
    }
  }
}
