import { assertDiscordCommandConfig, readConfig } from "./config";

export const HELIX_COMMANDS = [
  {
    name: "helix",
    description: "Manage a Helix Discord companion session.",
    options: [
      {
        name: "start",
        description: "Start a Helix Discord session.",
        type: 1,
      },
      {
        name: "link",
        description: "Create a private web link code for account linking.",
        type: 1,
      },
      {
        name: "status",
        description: "Show current Helix Discord session status.",
        type: 1,
      },
      {
        name: "attach-minecraft",
        description: "Attach the known Minehut source to this Discord session.",
        type: 1,
      },
      {
        name: "companion-mode",
        description: "Set companion policy for this session.",
        type: 1,
        options: [
          {
            name: "mode",
            description: "Companion mode.",
            type: 3,
            required: true,
            choices: [
              { name: "direct-address-only", value: "direct_address_only" },
              { name: "active-companion", value: "active_companion" },
              { name: "critical-voice", value: "critical_voice" },
              { name: "off", value: "off" },
            ],
          },
        ],
      },
      {
        name: "simulate-transcript",
        description: "Send a simulated transcript event to Helix.",
        type: 1,
        options: [
          {
            name: "text",
            description: "Transcript text.",
            type: 3,
            required: true,
          },
        ],
      },
      {
        name: "stop",
        description: "Stop the Helix Discord session.",
        type: 1,
      },
    ],
  },
];

async function registerCommands(): Promise<void> {
  const config = readConfig();
  assertDiscordCommandConfig(config);
  const endpoint = config.discordGuildId
    ? `https://discord.com/api/v10/applications/${config.discordClientId}/guilds/${config.discordGuildId}/commands`
    : `https://discord.com/api/v10/applications/${config.discordClientId}/commands`;
  const response = await fetch(endpoint, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${config.discordBotToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(HELIX_COMMANDS),
  });
  if (!response.ok) {
    throw new Error(`Discord command registration failed: ${response.status} ${await response.text()}`);
  }
  console.log(`Registered ${HELIX_COMMANDS.length} Helix command group(s).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  registerCommands().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
