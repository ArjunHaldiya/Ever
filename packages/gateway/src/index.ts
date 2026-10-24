import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { Spectrum } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";
import { logEvent, maskHandle } from "@ever/core";
import { z } from "zod";
import { handleInboundText } from "./inbound";
import { onReadReceipt } from "./alerts";
import { makeAlertStore } from "./alertStore";
import { drainOutboundOnce } from "./outbound";

/**
 * Always-on gateway (EC2, or your laptop for testing):
 *   Photon message stream -> verify, dedupe, enqueue to SQS, acknowledge
 *   outbound SQS queue    -> send through Photon
 * Credentials: SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET from the environment (local),
 * otherwise from the Secrets Manager secret named by PHOTON_SECRET.
 */

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

const region = process.env.AWS_REGION ?? "us-east-1";
const queueUrl = requireEnv("QUEUE_URL");
const outboundUrl = requireEnv("OUTBOUND_QUEUE_URL");
const processedTable = `${requireEnv("TABLE_PREFIX")}Processed`;
const PROCESSED_TTL_S = 24 * 60 * 60;

const PhotonCredsSchema = z.object({
  SPECTRUM_PROJECT_ID: z.string().min(1),
  SPECTRUM_PROJECT_SECRET: z.string().min(1),
});

async function loadPhotonCreds(): Promise<{ projectId: string; projectSecret: string }> {
  let raw: unknown = {
    SPECTRUM_PROJECT_ID: process.env.SPECTRUM_PROJECT_ID,
    SPECTRUM_PROJECT_SECRET: process.env.SPECTRUM_PROJECT_SECRET,
  };
  if (!process.env.SPECTRUM_PROJECT_ID || !process.env.SPECTRUM_PROJECT_SECRET) {
    const secrets = new SecretsManagerClient({ region });
    const out = await secrets.send(new GetSecretValueCommand({ SecretId: requireEnv("PHOTON_SECRET") }));
    raw = JSON.parse(out.SecretString ?? "{}");
  }
  const creds = PhotonCredsSchema.parse(raw);
  if (creds.SPECTRUM_PROJECT_ID.startsWith("pho_prj_")) {
    throw new Error("Photon BETA project ID (pho_prj_...) found. spectrum-ts needs the Stable UUID project ID and secret.");
  }
  return { projectId: creds.SPECTRUM_PROJECT_ID, projectSecret: creds.SPECTRUM_PROJECT_SECRET };
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
const sqs = new SQSClient({ region });

const inboundDeps = {
  claim: async (key: string) => {
    try {
      await ddb.send(
        new PutCommand({
          TableName: processedTable,
          Item: { messageId: key, ttl: Math.floor(Date.now() / 1000) + PROCESSED_TTL_S },
          ConditionExpression: "attribute_not_exists(messageId)",
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof Error && err.name === "ConditionalCheckFailedException") return false;
      throw err;
    }
  },
  release: async (key: string) => {
    await ddb.send(new DeleteCommand({ TableName: processedTable, Key: { messageId: key } }));
  },
  enqueue: async (message: object) => {
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(message) }));
  },
};

const outboundQueue = {
  receive: async () => {
    const out = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: outboundUrl, MaxNumberOfMessages: 5, WaitTimeSeconds: 20 }),
    );
    return (out.Messages ?? []).map((m) => ({ body: m.Body ?? "", receipt: m.ReceiptHandle ?? "" }));
  },
  remove: async (receipt: string) => {
    await sqs.send(new DeleteMessageCommand({ QueueUrl: outboundUrl, ReceiptHandle: receipt }));
  },
};

const { projectId, projectSecret } = await loadPhotonCreds();
const app = await Spectrum({ projectId, projectSecret, providers: [imessage.config()] });
const im = imessage(app);
logEvent("gateway_started", { region });

const alertStore = makeAlertStore(ddb, requireEnv("TABLE_PREFIX"));

const sender = {
  sendTexts: async (to: string, texts: string[]) => {
    const space = await im.space.create(await im.user(to));
    const messageIds: (string | undefined)[] = [];
    for (const text of texts) messageIds.push((await space.send(text))?.id);
    return {
      messageIds,
      // Photon has no delivery event, so a warning is looked up again after it is sent.
      checkDelivery: async (messageId: string) => {
        const sent = await space.getMessage(messageId);
        if (!sent || !imessage.is(sent)) return null;
        return {
          delivered: sent.isDelivered === true || sent.dateDelivered !== undefined,
          ...(sent.dateDelivered ? { deliveredAt: sent.dateDelivered } : {}),
          ...(sent.dateRead ? { readAt: sent.dateRead } : {}),
        };
      },
    };
  },
};

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    logEvent("gateway_stopping", { signal });
    stopping = true;
    setTimeout(() => process.exit(0), 1500);
  });
}

async function outboundLoop(): Promise<void> {
  while (!stopping) {
    try {
      await drainOutboundOnce(outboundQueue, sender, { store: alertStore });
    } catch (err) {
      logEvent("outbound_loop_error", { error: err instanceof Error ? err.name : "unknown" });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
void outboundLoop();

let eventsSeen = 0;
const heartbeat = setInterval(() => logEvent("gateway_heartbeat", { eventsSeen }), 60_000);
heartbeat.unref();

for await (const [space, message] of app.messages) {
  try {
    eventsSeen += 1;
    // Log every event's shape (never its text) so "nothing arrived" and "arrived but ignored" differ.
    logEvent("event_seen", {
      type: message.content.type,
      platform: message.platform,
      hasSender: Boolean(message.sender?.id),
      messageId: message.id,
    });
    if (message.content.type === "read") {
      // Read receipts feed the shutoff-warning tracking (Phase 7). Never reply to them.
      logEvent("read_receipt", { targetId: message.content.target.id, reader: maskHandle(message.sender?.id) });
      // Only receipts for shutoff warnings match anything; receipts for ordinary replies are ignored.
      await onReadReceipt(alertStore, message.content.target.id, message.timestamp);
      continue;
    }
    if (message.content.type !== "text" || !message.sender?.id) {
      logEvent("event_ignored", { type: message.content.type, hasSender: Boolean(message.sender?.id) });
      continue;
    }

    const outcome = await handleInboundText(inboundDeps, {
      messageId: message.id,
      sender: message.sender.id,
      text: message.content.text,
      receivedAt: message.timestamp,
      reply: async (text) => {
        await space.send(text);
      },
    });
    logEvent("inbound_handled", { messageId: message.id, outcome });
  } catch (err) {
    logEvent("inbound_error", { error: err instanceof Error ? err.name : "unknown" });
  }
}
