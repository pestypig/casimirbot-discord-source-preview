import { Client, ChannelType, Events, GatewayIntentBits } from "discord.js";
import { createServer, type Server as HttpServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import {
  EndBehaviorType,
  entersState,
  joinVoiceChannel,
  NetworkingStatusCode,
  VoiceConnectionStatus,
  type VoiceConnection,
} from "@discordjs/voice";
import { DiscordVoiceRoster } from "./voice-roster.js";
import { assessDiscordVoiceAdmission, type DiscordVoiceAdmissionAssessment } from "./voice-admission.js";
import { startDiscordOpusProbe, type DiscordOpusProbe, type DiscordOpusProbeResult } from "./voice-opus-probe.js";
import { createDiscordSolarWake } from "./solar-wake.js";
import { verifyVoiceBridgeTicket, VoiceBridgeNonceLedger, type VerifiedVoiceBridgeTicket } from
  "./voice-bridge-ticket.js";
import { startDiscordVoiceBridgeSession, type DiscordVoiceBridgeSession } from
  "./voice-bridge-session.js";
import { voiceBridgeSocketCloseAction } from "./voice-bridge-socket-close.js";

type DesiredInvitation = {
  invitation_id: string;
  guild_id: string;
  voice_channel_id: string;
  status: "pending" | "claimed" | "joined";
  lease_until: string | null;
};

const baseUrl = (process.env.HELIX_API_BASE || "https://casimirbot.com").replace(/\/$/, "");
const token = (process.env.DISCORD_VOICE_WORKER_TOKEN || "").trim();
const botToken = (process.env.DISCORD_BOT_TOKEN || "").trim();
const applicationId = (process.env.DISCORD_APPLICATION_ID || "").trim();
// Lease recovery requires this identity to survive a process restart. A random
// fallback would strand a still-valid invitation under the previous worker ID.
const workerId = (process.env.DISCORD_VOICE_WORKER_ID || "").trim();
const solarTickToken = (process.env.DISCORD_SOLAR_TICK_TOKEN || "").trim();
// Never set this in production until the owner-server receive, revoke and
// packet-integrity qualification is complete. It does not enable STT or output.
const receiveProbeEnabled = process.env.DISCORD_VOICE_RECEIVE_PROBE_ENABLED === "1";
const voiceBridgeEnabled = process.env.DISCORD_VOICE_BRIDGE_ENABLED === "1";
if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(baseUrl)) throw new Error("HELIX_API_BASE must use HTTPS outside localhost");
if (!token || !botToken || !/^\d{15,22}$/.test(applicationId) || !/^[a-zA-Z0-9:_-]{8,128}$/.test(workerId)) {
  throw new Error("Voice worker requires DISCORD_VOICE_WORKER_TOKEN, DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, and a valid worker ID");
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const roster = new DiscordVoiceRoster();
type JoinedVoice = {
  connection: VoiceConnection;
  guildId: string;
  voiceChannelId: string;
  lastConfirmed: number;
  probe: DiscordOpusProbe | null;
  probeStarting: boolean;
  probeConsentFingerprint: string | null;
  probeWatchdog: ReturnType<typeof setInterval> | null;
  probeWatchdogBusy: boolean;
  bridge: DiscordVoiceBridgeSession | null;
  bridgeStarting: boolean;
  bridgeParticipantIds: string[] | null;
};
type ConsentInspection = {
  assessment: DiscordVoiceAdmissionAssessment;
  consentFingerprint: string;
};
const joined = new Map<string, JoinedVoice>();
const lastConsentMonitor = new Map<string, string>();
const bridgeNonces = new VoiceBridgeNonceLedger();
let polling = false;
let solarTimer: ReturnType<typeof setInterval> | null = null;
let bridgeServer: HttpServer | null = null;

function changedGuildId(packet: unknown): string | null {
  if (!packet || typeof packet !== "object") return null;
  const event = packet as { t?: unknown; d?: unknown };
  if (!event.d || typeof event.d !== "object") return null;
  const data = event.d as { id?: unknown; guild_id?: unknown };
  const id = event.t === "VOICE_STATE_UPDATE" ? data.guild_id : data.id;
  return typeof id === "string" && /^\d{15,22}$/.test(id) ? id : null;
}

client.on(Events.Raw, (packet: unknown) => {
  if (!roster.observe(packet)) return;
  const guildId = changedGuildId(packet);
  for (const [invitationId, active] of joined) {
    if (guildId && guildId !== active.guildId) continue;
    if (active.bridgeParticipantIds) {
      const current = roster.snapshot(active.guildId, active.voiceChannelId, client.user?.id || "");
      if (current.complete && current.botPresent &&
          current.participantIds.length === active.bridgeParticipantIds.length &&
          current.participantIds.every((id, index) => id === active.bridgeParticipantIds![index])) {
        // An unrelated voice channel changed; this call's approved roster did not.
        continue;
      }
    }
    if (active.probe || active.probeStarting || active.bridge || active.bridgeStarting) {
      disconnect(invitationId);
      console.info("[discord-voice-worker] active voice roster changed; left voice channel");
      void report(invitationId, "failed", "roster_changed_during_receive").catch(() => undefined);
      continue;
    }
    if (lastConsentMonitor.get(invitationId) === "roster_changed") continue;
    lastConsentMonitor.set(invitationId, "roster_changed");
    console.info("[discord-voice-worker] consent monitor roster_changed; audio receive and output disabled");
  }
});

async function domain<T>(path: string, body?: Record<string, unknown>, timeoutMs = 8000): Promise<T> {
  const response = await fetch(`${baseUrl}/api/discord/voice/worker/${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`voice_worker_http_${response.status}`);
  return response.json() as Promise<T>;
}

function disconnect(invitationId: string): void {
  const active = joined.get(invitationId);
  if (!active) return;
  joined.delete(invitationId);
  lastConsentMonitor.delete(invitationId);
  if (active.probeWatchdog) clearInterval(active.probeWatchdog);
  active.bridge?.stop();
  active.probe?.stop();
  active.connection.destroy();
}

function loseGatewayState(): void {
  // Stop every call immediately while the Gateway is away. Keep the baseline
  // suspended so a successful RESUME can replay missed voice events onto it;
  // a fresh READY discards it and waits for GUILD_CREATE instead.
  roster.suspend();
  for (const invitationId of joined.keys()) disconnect(invitationId);
}

client.on(Events.ShardDisconnect, loseGatewayState);
client.on(Events.ShardReconnecting, loseGatewayState);
client.on(Events.ShardResume, () => {
  roster.resume();
  console.info("[discord-voice-worker] Gateway resumed; voice roster baseline restored after replay");
});

async function inspectConsentCoverage(
  invitationId: string, active: JoinedVoice, timeoutMs = 8000,
): Promise<ConsentInspection | null> {
  let summary = "consent_service_unavailable";
  let assessment: DiscordVoiceAdmissionAssessment;
  let consentFingerprint: string;
  try {
    const query = new URLSearchParams({
      application_id: applicationId, worker_id: workerId, invitation_id: invitationId,
    });
    const result = await domain<{ ok: true; armed: boolean; consents: Array<{ discord_user_id: unknown; consent_version: unknown }> }>(`consents?${query}`, undefined, timeoutMs);
    // An older request may finish after a replacement connection has taken
    // over the same invitation. Its consent view must not touch that call.
    if (joined.get(invitationId) !== active) return null;
    if (result.ok !== true || typeof result.armed !== "boolean" || !Array.isArray(result.consents)) {
      throw new Error("invalid_consent_response");
    }
    const voice = roster.snapshot(active.guildId, active.voiceChannelId, client.user?.id || "");
    assessment = assessDiscordVoiceAdmission({
      transportReady: Boolean(readyDaveTransport(active.connection)),
      leaseConfirmed: Date.now() - active.lastConfirmed < 25_000,
      armed: result.armed,
      roster: voice,
      consents: result.consents,
    });
    consentFingerprint = JSON.stringify(result.consents
      .map((entry) => [entry.discord_user_id, entry.consent_version])
      .sort(([a], [b]) => String(a).localeCompare(String(b))));
    summary = assessment.reason;
  } catch {
    if (joined.get(invitationId) !== active) return null;
    // Consent authority is unavailable or invalid. Leave the call rather than
    // retaining a connection with an unknown participant/consent state.
    disconnect(invitationId);
    console.info("[discord-voice-worker] consent service unavailable; left voice channel");
    await report(invitationId, "failed", "consent_service_unavailable").catch(() => undefined);
    return null;
  }
  if (lastConsentMonitor.get(invitationId) !== summary) {
    lastConsentMonitor.set(invitationId, summary);
    console.info(`[discord-voice-worker] consent monitor ${summary}; transcription and output disabled`);
  }
  return { assessment, consentFingerprint };
}

type BridgeAuthority = {
  ok: true;
  invitation_id: string;
  room_id: string;
  linked_profile_id: string;
  commander_discord_user_id: string;
  guild_id: string;
  voice_channel_id: string;
  armed: boolean;
  consents: Array<{ discord_user_id: unknown; consent_version: unknown }>;
};

async function bridgeAdmissionFailure(
  ticket: VerifiedVoiceBridgeTicket, active: JoinedVoice,
): Promise<string | null> {
  if (joined.get(ticket.invitation_id) !== active) return "invitation_unavailable";
  if (!client.isReady()) return "gateway_unavailable";
  if (!readyDaveTransport(active.connection)) return "dave_transport_unavailable";
  if (Date.now() - active.lastConfirmed >= 25_000) return "worker_lease_unconfirmed";
  const query = new URLSearchParams({
    application_id: applicationId, worker_id: workerId, invitation_id: ticket.invitation_id,
  });
  // The site may be waking an Autoscale instance or waiting on its database.
  // Stay within the ticket's short lifetime and the desktop's 15-second
  // admission wait, while using the same bound as other consent reads.
  const authority = await domain<BridgeAuthority>(`bridge-authority?${query}`, undefined, 8000)
    .catch(() => null);
  if (!authority) return "bridge_authority_unavailable";
  if (joined.get(ticket.invitation_id) !== active || authority.ok !== true ||
      authority.invitation_id !== ticket.invitation_id || authority.room_id !== ticket.room_id ||
      authority.linked_profile_id !== ticket.profile_id ||
      authority.guild_id !== active.guildId || authority.voice_channel_id !== active.voiceChannelId ||
      !/^\d{15,22}$/u.test(authority.commander_discord_user_id) || !Array.isArray(authority.consents)) {
    return "bridge_authority_mismatch";
  }
  const voice = roster.snapshot(active.guildId, active.voiceChannelId, client.user?.id || "");
  const assessment = assessDiscordVoiceAdmission({
    transportReady: Boolean(readyDaveTransport(active.connection)),
    leaseConfirmed: Date.now() - active.lastConfirmed < 25_000,
    armed: authority.armed,
    roster: voice,
    consents: authority.consents,
  });
  // The linked commander must be in the call, and every other human needs an
  // invitation-scoped consent. Freeze this participant set for the bridge;
  // any roster change ends media and requires a new admission.
  if (!assessment.eligible) {
    return assessment.reason.startsWith("participants_missing_consent:")
      ? "participants_missing_consent" : assessment.reason;
  }
  if (voice.participantIds.length > 4) return "participant_count_invalid";
  if (!voice.participantIds.includes(authority.commander_discord_user_id)) {
    return "commander_not_in_call";
  }
  return null;
}

async function bridgeAdmitted(
  ticket: VerifiedVoiceBridgeTicket, active: JoinedVoice,
): Promise<boolean> {
  return (await bridgeAdmissionFailure(ticket, active)) === null;
}

function startVoiceBridgeServer(): void {
  if (!voiceBridgeEnabled) return;
  const port = Number(process.env.PORT || "3000");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("invalid_voice_bridge_port");
  const server = createServer((req, res) => {
    const liveness = req.url === "/";
    const readiness = req.url === "/health";
    const ready = client.isReady();
    res.writeHead(liveness ? 200 : readiness ? ready ? 200 : 503 : 404, {
      "Content-Type": "application/json", "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(liveness || readiness
      ? { ok: liveness || ready, service: "discord_voice_worker" }
      : { ok: false }));
  });
  const sockets = new WebSocketServer({ server, path: "/voice-bridge", maxPayload: 8192,
    perMessageDeflate: false });
  sockets.on("connection", socket => {
    // The public endpoint accepts only one live pilot, but it must also bound
    // the unauthenticated sockets waiting for their first ticket frame.
    if (sockets.clients.size > 8) {
      socket.close(1008, "bridge_capacity");
      return;
    }
    let active: JoinedVoice | null = null;
    let activeInvitationId: string | null = null;
    let timedOut = false;
    let startingSession = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      socket.close(1008, "bridge_timeout");
    }, 25_000);
    const reject = (reason = "not_admitted"): void => {
      clearTimeout(timeout);
      if (active) {
        active.bridgeStarting = false;
        active.bridgeParticipantIds = null;
      }
      if (socket.readyState === WebSocket.OPEN) socket.close(1008, reason);
    };
    socket.once("message", (raw, binary) => {
      if (binary || !Buffer.isBuffer(raw) || raw.length > 2200 || timedOut) return reject();
      let input: { kind?: unknown; ticket?: unknown };
      try { input = JSON.parse(raw.toString("utf8")); } catch { return reject(); }
      if (input.kind !== "auth") return reject();
      const verified = verifyVoiceBridgeTicket(input.ticket, token, workerId);
      if (!verified || !bridgeNonces.consume(verified)) {
        console.info("[discord-voice-worker] bridge preflight denied: ticket invalid or replayed; audio disabled");
        return reject();
      }
      const joinedVoice = joined.get(verified.invitation_id);
      if (!joinedVoice || joinedVoice.bridge || joinedVoice.bridgeStarting || joinedVoice.probe || joinedVoice.probeStarting) {
        console.info("[discord-voice-worker] bridge preflight denied: invitation unavailable or busy; audio disabled");
        return reject();
      }
      active = joinedVoice;
      activeInvitationId = verified.invitation_id;
      joinedVoice.bridgeStarting = true;
      void bridgeAdmissionFailure(verified, joinedVoice).then(reason => {
        if (reason || socket.readyState !== WebSocket.OPEN || joined.get(verified.invitation_id) !== joinedVoice) {
          if (reason) console.info(`[discord-voice-worker] bridge admission denied: ${reason}; audio disabled`);
          reject(reason || "invitation_unavailable"); return;
        }
        socket.send(JSON.stringify({ kind: "admitted" }));
        socket.once("message", (message, isBinary) => {
          if (isBinary || !Buffer.isBuffer(message) || message.length > 128 || timedOut) return reject();
          let ready: { kind?: unknown };
          try { ready = JSON.parse(message.toString("utf8")); } catch { return reject(); }
          if (ready.kind !== "media_ready" || joined.get(verified.invitation_id) !== joinedVoice) return reject();
          clearTimeout(timeout);
          const participantIds = roster.snapshot(joinedVoice.guildId, joinedVoice.voiceChannelId,
            client.user?.id || "").participantIds;
          if (!participantIds.length || participantIds.length > 4) return reject();
          joinedVoice.bridgeParticipantIds = participantIds;
          startingSession = true;
          void startDiscordVoiceBridgeSession({
            socket, connection: joinedVoice.connection, voiceChannelId: joinedVoice.voiceChannelId,
            participantIds,
            admitted: async () => {
              const current = roster.snapshot(joinedVoice.guildId, joinedVoice.voiceChannelId,
                client.user?.id || "").participantIds;
              return current.length === participantIds.length &&
                current.every((id, index) => id === participantIds[index]) &&
                await bridgeAdmitted(verified, joinedVoice);
            },
            onFailure: reason => {
              if (joined.get(verified.invitation_id) !== joinedVoice) return;
              disconnect(verified.invitation_id);
              void report(verified.invitation_id, "failed", reason).catch(() => undefined);
            },
          }).then(session => {
            if (joined.get(verified.invitation_id) !== joinedVoice || socket.readyState !== WebSocket.OPEN) {
              session.stop(); joinedVoice.bridgeStarting = false;
              joinedVoice.bridgeParticipantIds = null;
              return;
            }
            joinedVoice.bridge = session;
            joinedVoice.bridgeStarting = false;
          }).catch(() => {
            joinedVoice.bridgeStarting = false;
            joinedVoice.bridgeParticipantIds = null;
            if (joined.get(verified.invitation_id) !== joinedVoice) return;
            disconnect(verified.invitation_id);
            void report(verified.invitation_id, "failed", "bridge_start_failed").catch(() => undefined);
          });
        });
      }).catch(() => reject("bridge_internal_error"));
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      if (!active || !activeInvitationId) return;
      const action = voiceBridgeSocketCloseAction({
        invitationStillJoined: joined.get(activeInvitationId) === active,
        bridgeActive: Boolean(active.bridge), sessionStarting: startingSession,
      });
      // Closing the browser bridge must leave Discord. Otherwise the worker
      // retains a busy bridge and an unmuted voice connection after media stops.
      if (action === "end") {
        disconnect(activeInvitationId);
        void report(activeInvitationId, "ended").catch(() => undefined);
      } else if (action === "release") {
        active.bridgeStarting = false;
        active.bridgeParticipantIds = null;
      }
    });
  });
  server.listen(port, "0.0.0.0");
  bridgeServer = server;
  console.info(`[discord-voice-worker] consent-gated bridge endpoint listening on port ${port}`);
}

function readyDaveTransport(connection: VoiceConnection): { protocolVersion: number; encryptionMode: string } | null {
  const voiceState = connection.state;
  if (voiceState.status !== VoiceConnectionStatus.Ready) return null;
  const networkState = voiceState.networking.state;
  if (networkState.code !== NetworkingStatusCode.Ready) return null;
  const protocolVersion = networkState.dave?.protocolVersion;
  if (!Number.isInteger(protocolVersion) || !protocolVersion || protocolVersion < 1) return null;
  return { protocolVersion, encryptionMode: networkState.connectionData.encryptionMode };
}

async function report(invitationId: string, status: "joined" | "failed" | "heartbeat" | "ended", failureCode?: string): Promise<void> {
  await domain("report", { invitation_id: invitationId, worker_id: workerId, status, failure_code: failureCode });
}

function finishReceiveProbe(invitationId: string, active: JoinedVoice, result: DiscordOpusProbeResult): void {
  if (joined.get(invitationId) !== active) return;
  disconnect(invitationId);
  const speakerCount = Object.values(result.packetsByUser).filter((count) => count > 0).length;
  if (result.outcome === "completed" && result.decodedFrames > 0) {
    console.info(`[discord-voice-worker] bounded decode probe completed; speakers=${speakerCount} packets=${result.totalPackets} decoded_frames=${result.decodedFrames} decoded_bytes=${result.decodedBytes}; audio discarded`);
    void report(invitationId, "ended").catch(() => undefined);
  } else {
    const reason = result.outcome === "completed" ? "receive_probe_no_packets" : `receive_probe_${result.outcome}`;
    console.info(`[discord-voice-worker] bounded decode probe ${reason}; audio discarded`);
    void report(invitationId, "failed", reason).catch(() => undefined);
  }
}

async function startReceiveProbe(
  invitationId: string, active: JoinedVoice, admitted: ConsentInspection,
): Promise<void> {
  if (!receiveProbeEnabled || !admitted.assessment.eligible || active.probe || active.probeStarting) return;
  if (active.bridge || active.bridgeStarting) return;
  active.probeStarting = true;
  try {
    const { createDiscordOpusDecoder } = await import("./opus-decoder.js");
    if (!active.connection.rejoin({ channelId: active.voiceChannelId, selfDeaf: false, selfMute: true })) {
      throw new Error("receive_probe_undeafen_failed");
    }
    await entersState(active.connection, VoiceConnectionStatus.Ready, 20_000);
    if (joined.get(invitationId) !== active) return;
    const fresh = await inspectConsentCoverage(invitationId, active);
    const voice = roster.snapshot(active.guildId, active.voiceChannelId, client.user?.id || "");
    if (!fresh?.assessment.eligible ||
        fresh.assessment.rosterRevision !== admitted.assessment.rosterRevision ||
        fresh.consentFingerprint !== admitted.consentFingerprint ||
        voice.revision !== admitted.assessment.rosterRevision || joined.get(invitationId) !== active) {
      throw new Error("receive_probe_admission_changed");
    }
    active.probeConsentFingerprint = fresh.consentFingerprint;
    active.probe = startDiscordOpusProbe({
      participantIds: voice.participantIds,
      createDecoder: () => createDiscordOpusDecoder(),
      subscribe: (userId) => active.connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.Manual },
      }),
      durationMs: 10_000,
      maxPackets: 20_000,
      onFinish: (result) => finishReceiveProbe(invitationId, active, result),
    });
    active.probeWatchdog = setInterval(() => {
      if (active.probeWatchdogBusy || joined.get(invitationId) !== active || !active.probe) return;
      active.probeWatchdogBusy = true;
      void inspectConsentCoverage(invitationId, active, 1200).then((inspection) => {
        if (joined.get(invitationId) !== active || !inspection) return;
        if (!inspection.assessment.eligible ||
            inspection.consentFingerprint !== active.probeConsentFingerprint) {
          disconnect(invitationId);
          void report(invitationId, "failed", "receive_probe_admission_lost").catch(() => undefined);
        }
      }).catch(() => {
        if (joined.get(invitationId) !== active) return;
        disconnect(invitationId);
        void report(invitationId, "failed", "receive_probe_watchdog_failed").catch(() => undefined);
      }).finally(() => { active.probeWatchdogBusy = false; });
    }, 500);
    active.probeWatchdog.unref?.();
    console.info("[discord-voice-worker] bounded decode probe started; PCM discarded, STT and output disabled");
  } catch {
    if (joined.get(invitationId) === active) {
      disconnect(invitationId);
      await report(invitationId, "failed", "receive_probe_admission_lost").catch(() => undefined);
    }
  } finally {
    active.probeStarting = false;
  }
}

async function join(invitation: DesiredInvitation): Promise<void> {
  // Keep the public failure code bounded to a join stage. Never put the raw
  // Discord or HTTP error in the domain receipt or a user-visible slash reply.
  let failureCode = "voice_guild_lookup_failed";
  let connection: VoiceConnection | null = null;
  try {
    const guild = await client.guilds.fetch(invitation.guild_id);
    failureCode = "voice_channel_lookup_failed";
    const channel = await guild.channels.fetch(invitation.voice_channel_id);
    if (!channel || channel.type !== ChannelType.GuildVoice || channel.guildId !== invitation.guild_id) {
      await report(invitation.invitation_id, "failed", "voice_channel_not_found");
      return;
    }
    failureCode = "voice_connection_create_failed";
    connection = joinVoiceChannel({
      guildId: guild.id,
      channelId: channel.id,
      adapterCreator: guild.voiceAdapterCreator,
      daveEncryption: true,
      selfDeaf: true,
      selfMute: true,
    });
    failureCode = "voice_ready_failed";
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    const transport = readyDaveTransport(connection);
    if (!transport) {
      connection.destroy();
      await report(invitation.invitation_id, "failed", "dave_not_negotiated").catch(() => undefined);
      return;
    }
    console.info(`[discord-voice-worker] DAVE v${transport.protocolVersion} negotiated; UDP mode ${transport.encryptionMode}; audio receive and output disabled`);
    failureCode = "voice_join_report_failed";
    await report(invitation.invitation_id, "joined");
    failureCode = "voice_join_finalization_failed";
    joined.set(invitation.invitation_id, {
      connection, guildId: guild.id, voiceChannelId: channel.id, lastConfirmed: Date.now(),
      probe: null, probeStarting: false, probeConsentFingerprint: null,
      probeWatchdog: null, probeWatchdogBusy: false,
      bridge: null, bridgeStarting: false, bridgeParticipantIds: null,
    });
    await inspectConsentCoverage(invitation.invitation_id, joined.get(invitation.invitation_id)!);
    if (joined.get(invitation.invitation_id)?.connection !== connection) return;
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      if (joined.get(invitation.invitation_id)?.connection !== connection) return;
      disconnect(invitation.invitation_id);
      void report(invitation.invitation_id, "failed", "voice_connection_lost").catch(() => undefined);
    });
    connection.on("stateChange", () => {
      const active = joined.get(invitation.invitation_id);
      // A receive subscription cannot survive even a transient loss of DAVE
      // Ready. The ordinary poll and consent watchdog are too slow to be the
      // first line of defense for a transport transition.
      if (active?.connection !== connection || (!active.probe && !active.bridge) ||
          readyDaveTransport(connection)) return;
      disconnect(invitation.invitation_id);
      void report(invitation.invitation_id, "failed", "dave_transport_lost").catch(() => undefined);
    });
  } catch (error) {
    if (failureCode === "voice_ready_failed" && error instanceof Error && error.name === "AbortError") {
      failureCode = "voice_ready_timeout";
    }
    console.warn(`[discord-voice-worker] join failed at ${failureCode}; error_kind=${error instanceof Error && error.name === "AbortError" ? "abort" : "other"}`);
    if (joined.get(invitation.invitation_id)?.connection === connection) disconnect(invitation.invitation_id);
    else connection?.destroy();
    await report(invitation.invitation_id, "failed", failureCode).catch(() => undefined);
  }
}

async function poll(): Promise<void> {
  if (polling) return;
  if (!client.isReady()) {
    for (const invitationId of joined.keys()) disconnect(invitationId);
    return;
  }
  polling = true;
  try {
    const query = new URLSearchParams({ application_id: applicationId, worker_id: workerId });
    const state = await domain<{ ok: true; invitations: DesiredInvitation[] }>(`desired?${query}`);
    const desiredIds = new Set(state.invitations.map((invitation) => invitation.invitation_id));
    for (const invitationId of joined.keys()) if (!desiredIds.has(invitationId)) disconnect(invitationId);
    for (const invitation of state.invitations) {
      const active = joined.get(invitation.invitation_id);
      if (active) {
        if (!active.probeStarting && !active.bridgeStarting && !readyDaveTransport(active.connection)) {
          disconnect(invitation.invitation_id);
          await report(invitation.invitation_id, "failed", "dave_transport_lost").catch(() => undefined);
          continue;
        }
        await report(invitation.invitation_id, "heartbeat");
        active.lastConfirmed = Date.now();
        if (active.probeStarting || active.bridgeStarting || active.bridge) continue;
        const admission = await inspectConsentCoverage(invitation.invitation_id, active);
        if (joined.get(invitation.invitation_id) !== active) continue;
        if (active.probe && (!admission?.assessment.eligible ||
            admission.consentFingerprint !== active.probeConsentFingerprint)) {
          disconnect(invitation.invitation_id);
          await report(invitation.invitation_id, "failed", "receive_probe_admission_lost").catch(() => undefined);
          continue;
        }
        if (admission?.assessment.eligible) await startReceiveProbe(invitation.invitation_id, active, admission);
        continue;
      }
      if (invitation.status === "pending") {
        const claim = await domain<{ ok: true; invitation: DesiredInvitation }>("claim", {
          invitation_id: invitation.invitation_id, worker_id: workerId,
        }).catch(() => null);
        if (!claim?.invitation) continue;
      }
      await join(invitation);
    }
  } catch {
    // A domain outage invalidates the invitation and consent view. Leave now;
    // the next successful poll may rejoin only if the domain still admits it.
    for (const invitationId of joined.keys()) disconnect(invitationId);
  } finally {
    for (const [invitationId, active] of joined) {
      if (Date.now() - active.lastConfirmed > 25_000) disconnect(invitationId);
    }
    polling = false;
  }
}

async function stop(): Promise<void> {
  if (solarTimer) clearInterval(solarTimer);
  for (const invitationId of joined.keys()) disconnect(invitationId);
  bridgeServer?.close();
  client.destroy();
}

process.once("SIGINT", () => { void stop().then(() => process.exit(0)); });
process.once("SIGTERM", () => { void stop().then(() => process.exit(0)); });

startVoiceBridgeServer();
await client.login(botToken);
console.log(`[discord-voice-worker] connected as ${client.user?.id}; bounded receive probe ${receiveProbeEnabled ? "armed for consented pilot" : "disabled"}; owner-harness voice bridge ${voiceBridgeEnabled ? "gated on consent" : "disabled"}`);
await poll();
setInterval(() => { void poll(); }, 5000);
const solarTick = createDiscordSolarWake({ baseUrl, token: solarTickToken });
if (solarTickToken) {
  solarTimer = setInterval(() => { void solarTick(); }, 60_000);
  solarTimer.unref?.();
  void solarTick();
}
