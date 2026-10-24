import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

/**
 * pnpm scrub            (dry run: only counts what would change)
 * pnpm scrub --apply    (does it)
 * Data minimization cleanup for rows written before EVER stopped storing location, ZIP and text:
 *  - Needs: removes latRounded, lngRounded, zip, redactedText, resourceId, distanceMiles.
 *  - Conversations: deletes the short-lived held state (it held redacted text).
 * Residents and Alerts are not touched: opted-in residents need their number and ZIP so warnings can be sent.
 */
const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const prefix = process.env.TABLE_PREFIX ?? "app-";
const apply = process.argv.includes("--apply");
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

const GONE = ["latRounded", "lngRounded", "zip", "redactedText", "resourceId", "distanceMiles"];

async function* scan(table: string): AsyncGenerator<Record<string, unknown>> {
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new ScanCommand({ TableName: `${prefix}${table}`, ExclusiveStartKey: startKey }));
    for (const item of page.Items ?? []) yield item;
    startKey = page.LastEvaluatedKey;
  } while (startKey);
}

let needsTouched = 0;
let needsTotal = 0;
for await (const need of scan("Needs")) {
  needsTotal += 1;
  const present = GONE.filter((k) => k in need);
  if (present.length === 0) continue;
  needsTouched += 1;
  if (apply) {
    await ddb.send(
      new UpdateCommand({
        TableName: `${prefix}Needs`,
        Key: { id: need.id },
        UpdateExpression: `REMOVE ${present.map((_, i) => `#f${i}`).join(", ")}`,
        ExpressionAttributeNames: Object.fromEntries(present.map((k, i) => [`#f${i}`, k])),
      }),
    );
  }
}

let held = 0;
for await (const convo of scan("Conversations")) {
  held += 1;
  if (apply) await ddb.send(new DeleteCommand({ TableName: `${prefix}Conversations`, Key: { phoneHash: convo.phoneHash } }));
}

const verb = apply ? "scrubbed" : "would scrub";
console.log(`Needs: ${verb} ${needsTouched} of ${needsTotal} rows`);
console.log(`Conversations: ${apply ? "deleted" : "would delete"} ${held}`);
if (!apply) console.log("Dry run only. Re-run with --apply to make the change.");
