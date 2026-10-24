import { loadSeed } from "./load";

/**
 * Phase 2: validates all seed files and prints a summary.
 * Loading into DynamoDB is added in Phase 3, once the CDK stack defines the tables.
 */
const seed = loadSeed();

const byType = new Map<string, number>();
for (const r of seed.resources) byType.set(r.type, (byType.get(r.type) ?? 0) + 1);

console.log(`resources: ${seed.resources.length} (${[...byType].map(([t, n]) => `${t}=${n}`).join(", ")})`);
console.log(`  unpowered: ${seed.resources.filter((r) => !r.hasPower).length}, full: ${seed.resources.filter((r) => r.capacity === 0).length} (intentional matcher traps)`);
console.log(`zip centroids: ${Object.keys(seed.zipCentroids).length}`);
console.log(`residents: ${seed.residents.length} from ${seed.residentsSource}`);
for (const n of seed.notices) console.log(`NOTICE: ${n}`);
console.log("seed files valid. DynamoDB load not wired yet (Phase 3).");
