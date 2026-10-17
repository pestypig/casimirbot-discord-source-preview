type RecordValue = Record<string, unknown>;

const asRecord = (value: unknown): RecordValue | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
const snowflake = (value: unknown): value is string =>
  typeof value === "string" && /^\d{15,22}$/.test(value);

type GuildRoster = {
  byUser: Map<string, string>;
  revision: number;
};

export type DiscordVoiceRosterSnapshot = {
  complete: boolean;
  botPresent: boolean;
  participantIds: string[];
  revision: number;
};

/** GUILD_CREATE establishes a complete voice roster. A successful Gateway
 * RESUME may retain that baseline after replay, but a fresh READY cannot. */
export class DiscordVoiceRoster {
  private readonly guilds = new Map<string, GuildRoster>();
  private revision = 0;
  private suspended = false;

  /** A disconnected Gateway cannot authorize audio. Retain the last baseline
   * only so a successful RESUME can replay missed voice updates onto it. */
  suspend(): void {
    this.suspended = true;
    this.revision += 1;
  }

  /** Discord replays missed dispatches before confirming a resumed session. */
  resume(): void {
    if (!this.suspended) return;
    this.suspended = false;
    this.revision += 1;
    for (const guild of this.guilds.values()) guild.revision = this.revision;
  }

  invalidateAll(): void {
    this.guilds.clear();
    this.suspended = false;
    this.revision += 1;
  }

  /** Returns true when a voice-channel membership baseline changed or was
   * invalidated. Mute-only updates do not change the participant set. */
  observe(packet: unknown): boolean {
    const event = asRecord(packet);
    const data = asRecord(event?.d);
    if (typeof event?.t !== "string") return false;
    // A new IDENTIFY starts a different session. Its GUILD_CREATE events must
    // establish fresh baselines before any call is admitted.
    if (event.t === "READY") {
      this.invalidateAll();
      return true;
    }
    const rosterEvent = event.t === "GUILD_CREATE" || event.t === "GUILD_DELETE" ||
      event.t === "VOICE_STATE_UPDATE";
    if (!data) {
      if (rosterEvent) this.invalidateAll();
      return rosterEvent;
    }
    if (event.t === "GUILD_CREATE") {
      const guildId = data.id;
      if (!snowflake(guildId)) {
        this.invalidateAll();
        return true;
      }
      const states = data.voice_states;
      if (data.unavailable === true || !Array.isArray(states)) {
        this.guilds.delete(guildId);
        this.revision += 1;
        return true;
      }
      const byUser = new Map<string, string>();
      for (const rawState of states) {
        const state = asRecord(rawState);
        if (!state || !snowflake(state.user_id) || !snowflake(state.channel_id) ||
            byUser.has(state.user_id)) {
          this.guilds.delete(guildId);
          this.revision += 1;
          return true;
        }
        byUser.set(state.user_id, state.channel_id);
      }
      this.guilds.set(guildId, { byUser, revision: ++this.revision });
      return true;
    }
    if (event.t === "GUILD_DELETE") {
      if (!snowflake(data.id)) {
        this.invalidateAll();
        return true;
      }
      this.guilds.delete(data.id);
      this.revision += 1;
      return true;
    }
    if (event.t !== "VOICE_STATE_UPDATE") return false;
    if (!snowflake(data.guild_id)) {
      this.invalidateAll();
      return true;
    }
    const guild = this.guilds.get(data.guild_id);
    if (!guild) return false;
    if (!snowflake(data.user_id) ||
        (data.channel_id !== null && !snowflake(data.channel_id))) {
      this.guilds.delete(data.guild_id);
      this.revision += 1;
      return true;
    }
    if (data.channel_id === null && !guild.byUser.has(data.user_id)) {
      // A departure for someone absent from a complete baseline changes no
      // current membership. Resume replay can contain such a departure.
      return false;
    }
    if (guild.byUser.get(data.user_id) === (data.channel_id ?? undefined)) return false;
    if (data.channel_id === null) guild.byUser.delete(data.user_id);
    else guild.byUser.set(data.user_id, data.channel_id);
    guild.revision = ++this.revision;
    return true;
  }

  snapshot(guildId: string, channelId: string, botUserId: string): DiscordVoiceRosterSnapshot {
    const guild = this.guilds.get(guildId);
    if (this.suspended || !guild || !snowflake(channelId) || !snowflake(botUserId)) {
      return { complete: false, botPresent: false, participantIds: [], revision: this.revision };
    }
    return {
      complete: true,
      botPresent: guild.byUser.get(botUserId) === channelId,
      participantIds: [...guild.byUser.entries()]
        .filter(([userId, voiceChannelId]) => userId !== botUserId && voiceChannelId === channelId)
        .map(([userId]) => userId)
        .sort(),
      revision: guild.revision,
    };
  }
}
