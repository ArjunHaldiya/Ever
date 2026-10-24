// MapLibre 6 runs map parsing in a separate worker file that imports a shared chunk.
// Vite's dependency bundling moves the main file away from them, so the worker can't start.
// Serving both files from /vendor/maplibre/ (next to each other) fixes that, in dev and in the build.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const dist = join(dirname(require.resolve("maplibre-gl/package.json")), "dist");
const out = new URL("../public/vendor/maplibre/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
for (const f of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) copyFileSync(join(dist, f), join(out, f));
console.log("copied MapLibre worker files to public/vendor/maplibre/");
