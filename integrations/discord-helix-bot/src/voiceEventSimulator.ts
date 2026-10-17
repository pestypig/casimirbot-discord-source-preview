import { readConfig } from "./config";
import { HelixClient } from "./helixClient";

async function main(): Promise<void> {
  const config = readConfig();
  const [sessionId, discordUserId, ...textParts] = process.argv.slice(2);
  const text = textParts.join(" ").trim();
  if (!sessionId || !discordUserId || !text) {
    throw new Error("Usage: npm run simulate -- <session_id> <discord_user_id> <transcript text>");
  }
  const client = new HelixClient(config);
  const receipt = await client.simulateTranscript({
    sessionId,
    discordUserId,
    text,
    eventType: /^helix\b|^dottie\b/i.test(text) ? "direct_address" : "voice_transcript",
  });
  console.log(JSON.stringify(receipt, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
