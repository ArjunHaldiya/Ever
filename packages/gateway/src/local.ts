import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  ackText,
  extractNeedByRules,
  processMessage,
  zipGeocoder,
  type ConversationState,
  type NeedDraft,
  type ProcessingMode,
} from "@ever/core";
import { loadSeed } from "../../../seed/load";

/**
 * Local loop: stdin -> core pipeline -> stdout. No AWS, no Photon, no Bedrock.
 * Extraction always uses the rules extractor; "ai" vs "degraded" only controls
 * whether replies carry the backup-mode notice, so the demo wording can be checked.
 * Phase 4 replaces stdin/stdout with the Spectrum message stream.
 */

const DEBUG = process.env.DEBUG === "1";
const seed = loadSeed();
const geocode = zipGeocoder(seed.zipCentroids);

let mode: ProcessingMode = "ai";
let conversation: ConversationState | null = null;
const needs = new Map<string, NeedDraft>();

const out = (line: string) => console.log(line.replace(/^/gm, "ever> "));

function help(): string {
  return [
    "Type a message as a resident would, e.g. \"my insulin needs to stay cold, 95112\".",
    "Commands: /chaos on|off (backup-mode replies), /needs, /reset, /help, /quit",
    "Seed data is DEMO data. Extraction here is rules-only (no Bedrock).",
  ].join("\n");
}

function handleCommand(line: string): boolean {
  const [cmd, arg] = line.slice(1).trim().split(/\s+/);
  switch (cmd) {
    case "chaos":
      mode = arg === "on" ? "degraded" : "ai";
      out(`chaos ${mode === "degraded" ? "ON (backup mode)" : "OFF"}`);
      return true;
    case "needs":
      out(needs.size ? JSON.stringify([...needs.values()], null, 2) : "no needs yet");
      return true;
    case "reset":
      conversation = null;
      needs.clear();
      out("state cleared");
      return true;
    case "quit":
      return false;
    default:
      out(help());
      return true;
  }
}

async function handleText(text: string): Promise<void> {
  const started = Date.now();
  out(ackText());
  const extracted = extractNeedByRules(text);
  const result = await processMessage(
    { text, extracted, mode, conversation },
    { resources: seed.resources, geocode, newNeedId: randomUUID, now: new Date() },
  );
  conversation = result.conversation;
  needs.set(result.need.id, result.need);
  for (const reply of result.replies) out(reply);
  if (DEBUG) {
    out(`[debug ${Date.now() - started}ms] ${JSON.stringify({ extracted, need: result.need })}`);
  }
}

async function main(): Promise<void> {
  const interactive = process.stdin.isTTY;
  if (interactive) out(help());
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
  if (interactive) rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (line) {
      if (line.startsWith("/")) {
        if (!handleCommand(line)) break;
      } else {
        if (!interactive) console.log(`you> ${line}`);
        await handleText(line);
      }
    }
    if (interactive) rl.prompt();
  }
  rl.close();
}

void main();
