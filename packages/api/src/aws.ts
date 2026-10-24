import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { LambdaClient, ListEventSourceMappingsCommand, UpdateEventSourceMappingCommand } from "@aws-sdk/client-lambda";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetQueueAttributesCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { AiModeSchema, AlertRecordSchema, OutboundMessageSchema, type AlertRecord } from "@ever/core";
import { hashHandle } from "@ever/core/hash";
import { registerSharedUser } from "./photon";
import type { ApiDeps, Resident } from "./routes";

/** Real AWS wiring for the dashboard API. The logic lives in routes.ts. */

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export function buildDeps(): ApiDeps {
  const region = process.env.AWS_REGION ?? "us-east-1";
  const prefix = requireEnv("TABLE_PREFIX");
  const aiModeParam = requireEnv("AI_MODE_PARAM");
  const outboundUrl = requireEnv("OUTBOUND_QUEUE_URL");
  const workerName = process.env.WORKER_FUNCTION_NAME ?? "app-worker";
  const table = (name: string) => `${prefix}${name}`;

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const sqs = new SQSClient({ region });
  const ssm = new SSMClient({ region });
  const secrets = new SecretsManagerClient({ region });
  const lambda = new LambdaClient({ region });

  const scan = async (name: string): Promise<Record<string, unknown>[]> => {
    const items: Record<string, unknown>[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await ddb.send(new ScanCommand({ TableName: table(name), ExclusiveStartKey: startKey }));
      items.push(...(page.Items ?? []));
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    return items;
  };

  const depth = async (queueUrl: string) => {
    const out = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
      }),
    );
    return {
      visible: Number(out.Attributes?.ApproximateNumberOfMessages ?? 0),
      inFlight: Number(out.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
    };
  };

  const toResident = (i: Record<string, unknown>): Resident => ({
    phoneHash: String(i.phoneHash),
    phone: String(i.phone ?? ""),
    zip: String(i.zip),
    needType: String(i.needType ?? "info"),
    optedIn: i.optedIn === true,
    assignedNumber: typeof i.assignedNumber === "string" ? i.assignedNumber : null,
    ...(typeof i.photonUserId === "string" ? { photonUserId: i.photonUserId } : {}),
    ...(typeof i.createdAt === "string" ? { createdAt: i.createdAt } : {}),
  });

  // Secrets are read once per cold start and never logged.
  let salt: string | undefined;
  let photonCreds: { projectId: string; projectSecret: string } | undefined;
  const secretString = async (id: string): Promise<string> => {
    const out = await secrets.send(new GetSecretValueCommand({ SecretId: id }));
    if (!out.SecretString) throw new Error(`secret ${id} is empty`);
    return out.SecretString;
  };

  let apiKey: string | undefined;
  const workerMapping = async () => {
    const out = await lambda.send(new ListEventSourceMappingsCommand({ FunctionName: workerName }));
    return out.EventSourceMappings?.[0];
  };

  return {
    now: () => new Date(),

    getApiKey: async () => {
      if (apiKey) return apiKey;
      const out = await secrets.send(new GetSecretValueCommand({ SecretId: requireEnv("API_KEY_SECRET") }));
      if (!out.SecretString) throw new Error("API key secret is empty");
      apiKey = out.SecretString;
      return apiKey;
    },

    getAiMode: async () => {
      const out = await ssm.send(new GetParameterCommand({ Name: aiModeParam }));
      const parsed = AiModeSchema.safeParse(out.Parameter?.Value);
      return parsed.success ? parsed.data : "primary";
    },
    setAiMode: async (mode) => {
      await ssm.send(new PutParameterCommand({ Name: aiModeParam, Value: mode, Type: "String", Overwrite: true }));
    },

    // The trigger being off lets the inbound queue build a backlog; turning it on drains it.
    getWorkerEnabled: async () => {
      const m = await workerMapping();
      return m ? m.State === "Enabled" || m.State === "Enabling" : null;
    },
    setWorkerEnabled: async (enabled) => {
      const m = await workerMapping();
      if (!m?.UUID) throw new Error("worker trigger not found");
      await lambda.send(new UpdateEventSourceMappingCommand({ UUID: m.UUID, Enabled: enabled }));
    },

    getQueueDepths: async () => {
      const [inbound, inboundDlq, outbound, outboundDlq] = await Promise.all([
        depth(requireEnv("QUEUE_URL")),
        depth(requireEnv("DLQ_URL")),
        depth(outboundUrl),
        depth(requireEnv("OUTBOUND_DLQ_URL")),
      ]);
      return { inbound, inboundDlq, outbound, outboundDlq };
    },

    scanNeeds: () => scan("Needs"),
    scanResources: () => scan("Resources"),
    scanAlerts: async (): Promise<AlertRecord[]> =>
      (await scan("Alerts")).flatMap((item) => {
        const parsed = AlertRecordSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      }),

    residentsByZip: async (zip): Promise<Resident[]> => {
      const out = await ddb.send(
        new QueryCommand({
          TableName: table("Residents"),
          IndexName: "zip-index",
          KeyConditionExpression: "zip = :z",
          ExpressionAttributeValues: { ":z": zip },
        }),
      );
      return (out.Items ?? []).map(toResident);
    },

    // Residents who texted STOP are kept only as a marker (no phone, no ZIP); they are not listed.
    scanResidents: async () => (await scan("Residents")).filter((i) => i.optedIn === true).map(toResident),
    putResident: async (resident) => {
      await ddb.send(new PutCommand({ TableName: table("Residents"), Item: resident }));
    },
    deleteResident: async (phoneHash) => {
      await ddb.send(new DeleteCommand({ TableName: table("Residents"), Key: { phoneHash } }));
    },
    hashPhone: async (phone) => {
      salt ??= await secretString(requireEnv("PHONE_HASH_SALT_SECRET"));
      return hashHandle(phone, salt);
    },
    registerPhoton: async (phone, firstName) => {
      if (!photonCreds) {
        const parsed = JSON.parse(await secretString(process.env.PHOTON_SECRET ?? "app/photon")) as Record<string, string>;
        if (!parsed.SPECTRUM_PROJECT_ID || !parsed.SPECTRUM_PROJECT_SECRET) throw new Error("Photon credentials are not set in the app/photon secret");
        photonCreds = { projectId: parsed.SPECTRUM_PROJECT_ID, projectSecret: parsed.SPECTRUM_PROJECT_SECRET };
      }
      return registerSharedUser({ ...photonCreds, phone, ...(firstName ? { firstName } : {}) });
    },

    putAlert: async (alert) => {
      await ddb.send(new PutCommand({ TableName: table("Alerts"), Item: alert }));
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
