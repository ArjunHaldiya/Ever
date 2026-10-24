import { InboundMessageSchema, logEvent } from "@ever/core";
import { buildDeps } from "./aws";
import { processInbound, type WorkerDeps } from "./process";

/**
 * Lambda entry point (SQS event source, batch size 1). A record that can't be parsed or
 * processed throws, so SQS retries it and, after 3 receives, moves it to the DLQ.
 */

type SqsEvent = { Records: { messageId: string; body: string }[] };

let depsPromise: Promise<WorkerDeps> | undefined;

function getDeps(): Promise<WorkerDeps> {
  depsPromise ??= buildDeps().catch((err) => {
    depsPromise = undefined; // let the next invocation try again
    throw err;
  });
  return depsPromise;
}

export async function handler(event: SqsEvent): Promise<void> {
  const deps = await getDeps();
  for (const record of event.Records) {
    let message;
    try {
      message = InboundMessageSchema.parse(JSON.parse(record.body));
    } catch {
      logEvent("poison_message", { sqsMessageId: record.messageId });
      throw new Error("Unparseable inbound message");
    }
    await processInbound(deps, message);
  }
}
