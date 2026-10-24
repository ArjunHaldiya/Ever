import { Spectrum } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";

/**
 * Connectivity check for Photon (Spectrum). No AWS, no queue, no AI.
 *
 *   pnpm photon:check              listen only: log each inbound message's metadata
 *   REPLY=1 pnpm photon:check      also reply "received" to whoever texted (team phones only)
 *
 * Reads SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET from .env.local.
 * Never logs message text or full phone numbers.
 */

const projectId = process.env.SPECTRUM_PROJECT_ID;
const projectSecret = process.env.SPECTRUM_PROJECT_SECRET;
if (!projectId || !projectSecret) {
  console.error("Set SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET in .env.local (see .env.example).");
  process.exit(1);
}
if (projectId.startsWith("pho_prj_")) {
  console.error(
    "This is a Photon BETA project ID (starts with pho_prj_). spectrum-ts needs the STABLE project:\n" +
      "a UUID-style ID plus a project secret. Get them with the Photon CLI:\n" +
      "  npx @photon-ai/cli projects ls --json\n" +
      "  npx @photon-ai/cli projects show <id>",
  );
  process.exit(1);
}
const reply = process.env.REPLY === "1";

/** "+14085551234" -> "***1234" */
function mask(id: string | undefined): string {
  return id ? `***${id.slice(-4)}` : "unknown";
}

const app = await Spectrum({
  projectId,
  projectSecret,
  providers: [imessage.config()],
});

console.log(
  `Connected to Photon. Reply mode: ${reply ? "ON" : "off"}. Text your Photon line from a team phone. Ctrl+C to stop.`,
);

for await (const [space, message] of app.messages) {
  const type = message.content.type;
  const who = mask(message.sender?.id);

  if (type === "read") {
    console.log(`[read receipt] ${who} read message ${message.content.target.id}`);
    continue;
  }

  const length = message.content.type === "text" ? message.content.text.length : undefined;
  console.log(
    `[inbound] platform=${message.platform} type=${type} from=${who} id=${message.id}` +
      (length === undefined ? "" : ` textLength=${length}`),
  );

  if (reply && type === "text") {
    await space.send("EVER connectivity check: received your message.");
    console.log(`[sent] reply to ${who}`);
  }
}
