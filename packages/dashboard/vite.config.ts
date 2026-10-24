import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// envDir points at the repo root so VITE_API_URL (and optionally VITE_API_KEY) come from .env.local.
// Only variables prefixed VITE_ reach the browser bundle; other secrets in that file stay out.
export default defineConfig({
  plugins: [react()],
  envDir: "../..",
  server: { port: 5173 },
});
