import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GeoPlacesClient } from "@aws-sdk/client-geo-places";
import { LocationClient } from "@aws-sdk/client-location";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  AiModeSchema,
  CONVERSATION_TTL_MS,
  ConversationStateSchema,
  logEvent,
  OutboundMessageSchema,
  ResourceSchema,
  zipGeocoder,
  ZipCentroidsSchema,
  type LatLng,
  type Resource,
} from "@ever/core";
import { hashHandle } from "@ever/core/hash";
import zipFile from "../../../seed/zip_centroids.json";
import { makeConverse } from "./bedrock";
import { makeGeocoder, makeNearbySearch } from "./nearby";
import type { WorkerDeps } from "./process";

/** Real AWS wiring for the worker. Kept thin: the logic lives in process.ts. */

const RESOURCES_CACHE_MS = 30_000;
const AI_MODE_CACHE_MS = 2_000;
const PROCESSED_TTL_S = 24 * 60 * 60;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export async function buildDeps(): Promise<WorkerDeps> {
  const region = process.env.AWS_REGION ?? "us-east-1";
  const prefix = requireEnv("TABLE_PREFIX");
  const aiModeParam = requireEnv("AI_MODE_PARAM");
  const outboundUrl = requireEnv("OUTBOUND_QUEUE_URL");
  const placeIndex = process.env.LOCATION_PLACE_INDEX ?? "";
  const modelId = process.env.BEDROCK_MODEL_ID ?? "";

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const sqs = new SQSClient({ region });
  const ssm = new SSMClient({ region });
  const geocoder = makeGeocoder(new LocationClient({ region }), placeIndex);
  const nearby = makeNearbySearch(new GeoPlacesClient({ region }));
  const table = (name: string) => `${prefix}${name}`;

  // The salt is fetched once per cold start. Never log it.
  const secrets = new SecretsManagerClient({ region });
  const saltOut = await secrets.send(
    new GetSecretValueCommand({ SecretId: requireEnv("PHONE_HASH_SALT_SECRET") }),
  );
  const salt = saltOut.SecretString;
  if (!salt) throw new Error("Phone hash salt secret is empty");

  const centroids = ZipCentroidsSchema.parse(zipFile.zips);
  const byZip = zipGeocoder(centroids);

  let aiModeCache: { value: "primary" | "degraded"; at: number } | null = null;
  let resourcesCache: { value: Resource[]; at: number } | null = null;

  return {
    now: () => new Date(),
    hashSender: (sender) => hashHandle(sender, salt),

    getAiMode: async () => {
      if (aiModeCache && Date.now() - aiModeCache.at < AI_MODE_CACHE_MS) return aiModeCache.value;
      try {
        const out = await ssm.send(new GetParameterCommand({ Name: aiModeParam }));
        const parsed = AiModeSchema.safeParse(out.Parameter?.Value);
        aiModeCache = { value: parsed.success ? parsed.data : "primary", at: Date.now() };
      } catch (err) {
        // If the flag can't be read, Bedrock's own fallbacks still protect the request.
        logEvent("ai_mode_read_failed", { error: err instanceof Error ? err.name : "unknown" });
        aiModeCache = { value: "primary", at: Date.now() };
      }
      return aiModeCache.value;
    },

    getResources: async () => {
      if (resourcesCache && Date.now() - resourcesCache.at < RESOURCES_CACHE_MS) {
        return resourcesCache.value;
      }
      const items: Record<string, unknown>[] = [];
      let startKey: Record<string, unknown> | undefined;
      do {
        const page = await ddb.send(
          new ScanCommand({ TableName: table("Resources"), ExclusiveStartKey: startKey }),
        );
        items.push(...(page.Items ?? []));
        startKey = page.LastEvaluatedKey;
      } while (startKey);
      const valid: Resource[] = [];
      for (const item of items) {
        const parsed = ResourceSchema.safeParse(item);
        if (parsed.success) valid.push(parsed.data);
        else logEvent("resource_invalid", { id: String(item.id ?? "?") });
      }
      resourcesCache = { value: valid, at: Date.now() };
      return valid;
    },

    // ZIP centroid first (instant, offline, San Jose only); Amazon Location for any other US location.
    geocode: async (text): Promise<LatLng | null> => (await byZip(text)) ?? geocoder.geocodeText(text),

    findNearby: nearby.findNearby,

    converse: modelId ? await makeConverse(region) : null,
    modelId,

    store: {
      claim: async (key) => {
        try {
          await ddb.send(
            new PutCommand({
              TableName: table("Processed"),
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
      release: async (key) => {
        await ddb.send(new DeleteCommand({ TableName: table("Processed"), Key: { messageId: key } }));
      },
      getConversation: async (phoneHash) => {
        const out = await ddb.send(
          new GetCommand({ TableName: table("Conversations"), Key: { phoneHash } }),
        );
        if (!out.Item?.state) return null;
        const parsed = ConversationStateSchema.safeParse(out.Item.state);
        return parsed.success ? parsed.data : null;
      },
      putConversation: async (phoneHash, state, now) => {
        if (state === null) {
          await ddb.send(new DeleteCommand({ TableName: table("Conversations"), Key: { phoneHash } }));
          return;
        }
        await ddb.send(
          new PutCommand({
            TableName: table("Conversations"),
            Item: {
              phoneHash,
              state,
              ttl: Math.floor((now.getTime() + CONVERSATION_TTL_MS) / 1000) + 3600,
            },
          }),
        );
      },
      putNeed: async (need) => {
        await ddb.send(new PutCommand({ TableName: table("Needs"), Item: need }));
      },
      optOutResident: async (phoneHash, now) => {
        try {
          // Keeps only a marker that they left. The phone number and ZIP are removed, and with the
          // ZIP gone the row also drops out of the zip index that shutoffs use to find residents.
          await ddb.send(
            new UpdateCommand({
              TableName: table("Residents"),
              Key: { phoneHash },
              ConditionExpression: "attribute_exists(phoneHash)",
              UpdateExpression:
                "SET optedIn = :no, optedOutAt = :at REMOVE phone, zip, needType, assignedNumber, photonUserId",
              ExpressionAttributeValues: { ":no": false, ":at": now.toISOString() },
            }),
          );
        } catch (err) {
          // Not a resident: nothing to stop, and no row is created.
          if (err instanceof Error && err.name === "ConditionalCheckFailedException") return;
          throw err;
        }
      },
    },

    sendOutbound: async (message) => {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: outboundUrl,
          MessageBody: JSON.stringify(OutboundMessageSchema.parse(message)),
        }),
      );
    },
  };
}
