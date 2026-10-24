/**
 * PLACEHOLDER until Phase 4. Fails on purpose so a message that arrives before
 * the real worker exists is retried and lands in the DLQ rather than being lost.
 */
export async function handler(): Promise<never> {
  throw new Error("worker not implemented yet (Phase 4)");
}
