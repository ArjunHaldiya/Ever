import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { hashHandle } from "../packages/core/src/hash";
import { loadSeed } from "./load";

/**
 * pnpm seed            validate the seed files and print a summary (no AWS calls)
 * pnpm seed --write    also load the resources into <TABLE_PREFIX>Resources, and the opted-in
 *                       residents into <TABLE_PREFIX>Residents (only from demo_residents.local.json)
 *
 * Writing replaces each resource row with the seed values, which resets its capacity.
 * Seed data is DEMO data, not real availability.
 */
const seed = loadSeed();

const byType = new Map<string, number>();
for (const r of seed.resources) byType.set(r.type, (byType.get(r.type) ?? 0) + 1);

console.log(`resources: ${seed.resources.length} (${[...byType].map(([t, n]) => `${t}=${n}`).join(", ")})`);
console.log(`  unpowered: ${seed.resources.filter((r) => !r.hasPower).length}, full: ${seed.resources.filter((r) => r.capacity === 0).length} (intentional matcher traps)`);
console.log(`zip centroids: ${Object.keys(seed.zipCentroids).length}`);
console.log(`residents: ${seed.residents.length} from ${seed.residentsSource}`);
for (const n of seed.notices) console.log(`NOTICE: ${n}`);
console.log("seed files valid.");

if (process.argv.includes("--write")) {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  const table = `${process.env.TABLE_PREFIX ?? "app-"}Resources`;
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  for (let i = 0; i < seed.resources.length; i += 25) {
    const batch = seed.resources.slice(i, i + 25);
    const out = await ddb.send(
      new BatchWriteCommand({
        RequestItems: { [table]: batch.map((Item) => ({ PutRequest: { Item } })) },
      }),
    );
    const unprocessed = Object.values(out.UnprocessedItems ?? {}).flat().length;
    if (unprocessed > 0) throw new Error(`${unprocessed} items were not written; run again`);
  }
  console.log(`wrote ${seed.resources.length} resources to ${table} in ${region}`);

  // Residents: only the real, gitignored file. The committed placeholders are fictional numbers,
  // and a shutoff warning to them would just fail and clutter the dead-letter queue.
  if (seed.residentsSource !== "demo_residents.local.json") {
    console.log("residents NOT written: create seed/demo_residents.local.json (same shape as demo_residents.json) with team phones that are registered in Photon and have texted the line.");
  } else {
    const secrets = new SecretsManagerClient({ region });
    const salt = (await secrets.send(new GetSecretValueCommand({ SecretId: process.env.PHONE_HASH_SALT_SECRET ?? "app/phone-hash-salt" }))).SecretString;
    if (!salt) throw new Error("phone hash salt secret is empty");
    const residentsTable = `${process.env.TABLE_PREFIX ?? "app-"}Residents`;
    for (const r of seed.residents) {
      await ddb.send(
        new PutCommand({
          TableName: residentsTable,
          Item: { phoneHash: hashHandle(r.handle, salt), phone: r.handle, zip: r.zip, needType: r.needType, optedIn: true },
        }),
      );
    }
    console.log(`wrote ${seed.residents.length} opted-in residents to ${residentsTable}`);
  }
} else {
  console.log("Not written to DynamoDB. Add --write to load the resources.");
}
