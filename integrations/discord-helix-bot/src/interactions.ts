import type { HelixClient } from "./helixClient";
import { ensureSession, getSessionForGuild } from "./sessionRuntime";

export type HelixCommandContext = {
  subcommand: string;
  guildId: string;
  voiceChannelId: string;
  textChannelId?: string | null;
  discordUserId: string;
  displayName?: string | null;
  options?: Record<string, string | boolean | number | null | undefined>;
};

export async function handleHelixCommand(input: {
  client: HelixClient;
  context: HelixCommandContext;
}): Promise<{ ephemeral: boolean; content: string; receipt?: unknown }> {
  const { client, context } = input;
  if (context.subcommand === "start") {
    const session = await ensureSession({
      client,
      guildId: context.guildId,
      voiceChannelId: context.voiceChannelId,
      textChannelId: context.textChannelId,
    });
    return {
      ephemeral: false,
      content: `Helix session started for this voice channel: ${session.sessionId}`,
      receipt: session,
    };
  }
  const session = getSessionForGuild(context.guildId);
  if (!session) {
    return {
      ephemeral: true,
      content: "Start a Helix session first with /helix start.",
    };
  }
  if (context.subcommand === "link") {
    const receipt = await client.createLinkCode({
      sessionId: session.sessionId,
      discordUserId: context.discordUserId,
      displayName: context.displayName,
    });
    const code = receipt.code as { link_url?: string } | undefined;
    return {
      ephemeral: true,
      content: code?.link_url
        ? `Sign in to link this Discord session: ${code.link_url}`
        : "Helix created a link code, but no link URL was returned.",
      receipt,
    };
  }
  if (context.subcommand === "status") {
    const receipt = await client.getSession(session.sessionId);
    return {
      ephemeral: true,
      content: `Helix session status: ${JSON.stringify(receipt)}`,
      receipt,
    };
  }
  if (context.subcommand === "attach-minecraft") {
    const receipt = await client.attachMinecraft(session.sessionId);
    return {
      ephemeral: false,
      content: "Minecraft source attachment requested for this Helix Discord session.",
      receipt,
    };
  }
  if (context.subcommand === "companion-mode") {
    const mode = String(context.options?.mode ?? "direct_address_only");
    const receipt = await client.setCompanionMode({ sessionId: session.sessionId, companionMode: mode });
    return {
      ephemeral: false,
      content: `Companion mode set to ${mode}.`,
      receipt,
    };
  }
  if (context.subcommand === "simulate-transcript") {
    const text = String(context.options?.text ?? "").trim();
    if (!text) return { ephemeral: true, content: "Transcript text is required." };
    const receipt = await client.simulateTranscript({
      sessionId: session.sessionId,
      discordUserId: context.discordUserId,
      displayName: context.displayName,
      text,
      eventType: /^helix\b|^dottie\b/i.test(text) ? "direct_address" : "voice_transcript",
    });
    const bridge = receipt.ask_turn_bridge as { decision?: string } | undefined;
    return {
      ephemeral: false,
      content: bridge?.decision === "queued"
        ? "Direct address queued for a normal Helix Ask turn."
        : "Transcript recorded as Helix context.",
      receipt,
    };
  }
  if (context.subcommand === "stop") {
    const receipt = await client.stopSession(session.sessionId);
    return {
      ephemeral: false,
      content: "Helix Discord session stopped.",
      receipt,
    };
  }
  return {
    ephemeral: true,
    content: `Unknown Helix subcommand: ${context.subcommand}`,
  };
}
