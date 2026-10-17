import { HelixClient } from "./helixClient";

export type RuntimeSessionState = {
  sessionId: string;
  guildId: string;
  voiceChannelId: string;
  textChannelId?: string | null;
};

const sessionsByGuild = new Map<string, RuntimeSessionState>();

export function rememberSession(session: RuntimeSessionState): void {
  sessionsByGuild.set(session.guildId, session);
}

export function getSessionForGuild(guildId: string): RuntimeSessionState | null {
  return sessionsByGuild.get(guildId) ?? null;
}

export async function ensureSession(input: {
  client: HelixClient;
  guildId: string;
  voiceChannelId: string;
  textChannelId?: string | null;
}): Promise<RuntimeSessionState> {
  const existing = getSessionForGuild(input.guildId);
  if (existing) return existing;
  const receipt = await input.client.startSession(input);
  const session = receipt.session as { session_id: string } | undefined;
  if (!session?.session_id) throw new Error("Helix did not return a Discord session id.");
  const next: RuntimeSessionState = {
    sessionId: session.session_id,
    guildId: input.guildId,
    voiceChannelId: input.voiceChannelId,
    textChannelId: input.textChannelId ?? null,
  };
  rememberSession(next);
  return next;
}
