import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

/**
 * pnpm demo:reset
 * Clears demo activity so a recording starts clean: Needs, Alerts, Conversations, and the
 * message-tracking rows in Processed. Sets the chaos flag back to "primary".
 * Resources are NOT touched here; run `pnpm seed --write` to restore their capacities.
 * Residents are kept (they are the opted-in list).
 */
const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const prefix = process.env.TABLE_PREFIX ?? "app-";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

async function clear(table: string, keys: string[]): Promise<number> {
  let deleted = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new ScanCommand({ TableName: `${prefix}${table}`, ExclusiveStartKey: startKey }));
    for (const item of page.Items ?? []) {
      await ddb.send(new DeleteCommand({ TableName: `${prefix}${table}`, Key: Object.fromEntries(keys.map((k) => [k, item[k]])) }));
      deleted += 1;
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return deleted;
}

console.log(`Needs: ${await clear("Needs", ["id"])} cleared`);
console.log(`Alerts: ${await clear("Alerts", ["alertId", "phoneHash"])} cleared`);
console.log(`Conversations: ${await clear("Conversations", ["phoneHash"])} cleared`);
console.log(`Processed: ${await clear("Processed", ["messageId"])} cleared`);

const ssm = new SSMClient({ region });
const flag = process.env.AI_MODE_PARAM ?? "/app/ai_mode";
const before = (await ssm.send(new GetParameterCommand({ Name: flag }))).Parameter?.Value;
await ssm.send(new PutParameterCommand({ Name: flag, Value: "primary", Type: "String", Overwrite: true }));
console.log(`AI mode: ${before} -> primary`);
console.log("Done. Run `pnpm seed --write` to restore place capacities.");
