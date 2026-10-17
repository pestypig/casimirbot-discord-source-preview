import { readConfig } from "./config";

const config = readConfig();

console.log("Discord Helix bot runtime scaffold");
console.log(`Helix API: ${config.helixApiBase}`);
console.log(`Voice receive enabled: ${config.voiceReceiveEnabled}`);
console.log(`Voice output enabled: ${config.voiceOutputEnabled}`);
console.log("Register slash commands with `npm run register`.");
console.log("Use `npm run simulate -- <session_id> <discord_user_id> \"Helix, what happened?\"` for local transcript tests.");

if (config.voiceReceiveEnabled || config.voiceOutputEnabled) {
  console.warn(
    "Real Discord voice transport is intentionally not implemented in this scaffold. Use the simulated transcript path until the voice adapter patch.",
  );
}
