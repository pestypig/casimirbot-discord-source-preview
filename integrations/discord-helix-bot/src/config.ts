export type DiscordHelixBotConfig = {
  discordBotToken: string;
  discordClientId: string;
  discordGuildId?: string;
  helixApiBase: string;
  helixDiscordDevToken?: string;
  helixDiscordBotSharedToken?: string;
  helixDiscordLinkBaseUrl: string;
  helixPublicBaseUrl: string;
  voiceReceiveEnabled: boolean;
  voiceOutputEnabled: boolean;
};

const boolEnv = (value: string | undefined): boolean => value === "1" || value === "true";

export function readConfig(env = process.env): DiscordHelixBotConfig {
  return {
    discordBotToken: env.DISCORD_BOT_TOKEN ?? "",
    discordClientId: env.DISCORD_CLIENT_ID ?? "",
    discordGuildId: env.DISCORD_GUILD_ID,
    helixApiBase: env.HELIX_API_BASE ?? "http://127.0.0.1:5050",
    helixDiscordDevToken: env.HELIX_DISCORD_DEV_TOKEN,
    helixDiscordBotSharedToken: env.HELIX_DISCORD_BOT_SHARED_TOKEN ?? env.HELIX_DISCORD_DEV_TOKEN,
    helixDiscordLinkBaseUrl: env.HELIX_DISCORD_LINK_BASE_URL ?? `${env.HELIX_PUBLIC_BASE_URL ?? "https://casimirbot.com"}/link-discord`,
    helixPublicBaseUrl: env.HELIX_PUBLIC_BASE_URL ?? "https://casimirbot.com",
    voiceReceiveEnabled: boolEnv(env.DISCORD_VOICE_RECEIVE_ENABLED),
    voiceOutputEnabled: boolEnv(env.DISCORD_VOICE_OUTPUT_ENABLED),
  };
}

export function assertDiscordCommandConfig(config: DiscordHelixBotConfig): void {
  const missing = [
    !config.discordBotToken ? "DISCORD_BOT_TOKEN" : "",
    !config.discordClientId ? "DISCORD_CLIENT_ID" : "",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`Missing Discord bot config: ${missing.join(", ")}`);
  }
}
