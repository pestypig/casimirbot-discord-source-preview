import type { DiscordHelixBotConfig } from "./config";

type JsonRecord = Record<string, unknown>;

export class HelixClient {
  constructor(private readonly config: DiscordHelixBotConfig) {}

  private authHeaders(): Record<string, string> {
    return this.config.helixDiscordBotSharedToken
      ? { Authorization: `Bearer ${this.config.helixDiscordBotSharedToken}` }
      : this.config.helixDiscordDevToken
        ? { "X-Helix-Discord-Dev-Token": this.config.helixDiscordDevToken }
        : {};
  }

  private async post<T = JsonRecord>(path: string, body: JsonRecord): Promise<T> {
    const response = await fetch(`${this.config.helixApiBase}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.authHeaders(),
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(typeof payload?.message === "string" ? payload.message : `Helix ${response.status}`);
    }
    return payload as T;
  }

  private async get<T = JsonRecord>(path: string): Promise<T> {
    const response = await fetch(`${this.config.helixApiBase}${path}`, {
      headers: this.authHeaders(),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(typeof payload?.message === "string" ? payload.message : `Helix ${response.status}`);
    }
    return payload as T;
  }

  startSession(input: {
    guildId: string;
    voiceChannelId: string;
    textChannelId?: string | null;
    threadId?: string | null;
  }): Promise<JsonRecord> {
    return this.post("/api/discord/session/start", {
      guild_id: input.guildId,
      voice_channel_id: input.voiceChannelId,
      text_channel_id: input.textChannelId ?? null,
      thread_id: input.threadId ?? null,
    });
  }

  createLinkCode(input: {
    sessionId: string;
    discordUserId: string;
    displayName?: string | null;
  }): Promise<JsonRecord> {
    return this.post("/api/discord/session/link-code", {
      session_id: input.sessionId,
      discord_user_id: input.discordUserId,
      display_name: input.displayName ?? null,
      public_base_url: this.config.helixDiscordLinkBaseUrl,
    });
  }

  getSession(sessionId: string): Promise<JsonRecord> {
    return this.get(`/api/discord/session/${encodeURIComponent(sessionId)}`);
  }

  attachMinecraft(sessionId: string): Promise<JsonRecord> {
    return this.post(`/api/discord/session/${encodeURIComponent(sessionId)}/attach-minecraft`, {});
  }

  setCompanionMode(input: {
    sessionId: string;
    companionMode: string;
    commentaryMode?: string;
    voiceOutputEnabled?: boolean;
  }): Promise<JsonRecord> {
    return this.post(`/api/discord/session/${encodeURIComponent(input.sessionId)}/companion-mode`, {
      companion_mode: input.companionMode,
      commentary_mode: input.commentaryMode ?? "off",
      voice_output_enabled: input.voiceOutputEnabled ?? false,
    });
  }

  simulateTranscript(input: {
    sessionId: string;
    discordUserId: string;
    displayName?: string | null;
    text: string;
    eventType?: string;
  }): Promise<JsonRecord> {
    return this.post("/api/discord/source-event", {
      session_id: input.sessionId,
      event_type: input.eventType ?? "voice_transcript",
      discord_user_id: input.discordUserId,
      display_name: input.displayName ?? null,
      text: input.text,
      evidence_refs: [`discord:simulated:${Date.now()}`],
    });
  }

  stopSession(sessionId: string): Promise<JsonRecord> {
    return this.post(`/api/discord/session/${encodeURIComponent(sessionId)}/stop`, {});
  }

  recordOutput(input: {
    sessionId: string;
    delivered: boolean;
    channel: "discord_text" | "discord_voice" | "none";
    reason: string;
    textPreview?: string | null;
  }): Promise<JsonRecord> {
    return this.post("/api/discord/voice-output/receipt", {
      session_id: input.sessionId,
      delivered: input.delivered,
      channel: input.channel,
      reason: input.reason,
      text_preview: input.textPreview ?? null,
    });
  }
}
