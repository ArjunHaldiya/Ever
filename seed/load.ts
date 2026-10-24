import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DemoResidentSchema,
  ResourceSchema,
  ZipCentroidsSchema,
} from "../packages/core/src";
import type { Resource, ZipCentroids } from "../packages/core/src";

type DemoResident = ReturnType<typeof DemoResidentSchema.parse>;

const SEED_DIR = dirname(fileURLToPath(import.meta.url));

function readJson(file: string): { _notice?: unknown; [key: string]: unknown } {
  return JSON.parse(readFileSync(join(SEED_DIR, file), "utf8"));
}

export type Seed = {
  resources: Resource[];
  zipCentroids: ZipCentroids;
  residents: DemoResident[];
  /** Which residents file was used. The .local one holds real numbers and is gitignored. */
  residentsSource: "demo_residents.local.json" | "demo_residents.json";
  notices: string[];
};

/** Reads and validates every seed file. Throws (with the zod issue list) on bad data. */
export function loadSeed(): Seed {
  const resourcesFile = readJson("resources.json");
  const zipsFile = readJson("zip_centroids.json");
  const residentsSource = existsSync(join(SEED_DIR, "demo_residents.local.json"))
    ? "demo_residents.local.json"
    : "demo_residents.json";
  const residentsFile = readJson(residentsSource);

  return {
    resources: ResourceSchema.array().parse(resourcesFile.resources),
    zipCentroids: ZipCentroidsSchema.parse(zipsFile.zips),
    residents: DemoResidentSchema.array().parse(residentsFile.residents),
    residentsSource,
    notices: [resourcesFile._notice, zipsFile._notice, residentsFile._notice].filter(
      (n): n is string => typeof n === "string",
    ),
  };
}
