import { PassThrough } from "node:stream";
import {
  AudioPlayerStatus, createAudioPlayer, createAudioResource, EndBehaviorType,
  entersState, StreamType, VoiceConnectionStatus, type VoiceConnection,
} from "@discordjs/voice";
import OpusScript from "opusscript";
import WebSocket from "ws";
import { createPcmSignal, observePcm16Signal } from "./voice-pcm-signal.js";
import { queueOpusPacket } from "./voice-opus-output.js";
import { mixDiscordPcmFrames } from "./voice-pcm-mixer.js";

const maxBufferedBytes = 512 * 1024;
const pcmFrameBytes = 960 * 2 * 2;
const maxQueuedOpusFrames = 48;
const maxConsecutiveDroppedOpusFrames = 100;
const maxInputFramesPerSpeaker = 25;

export type DiscordVoiceBridgeSession = { stop(): void };

/** Starts only after an exact ticket has been consumed and the first admission
 * snapshot has passed. Every subsequent media step checks the same authority. */
export async function startDiscordVoiceBridgeSession(input: {
  socket: WebSocket;
  connection: VoiceConnection;
  voiceChannelId: string;
  participantIds: string[];
  admitted(): Promise<boolean>;
  onFailure(reason: string): void;
}): Promise<DiscordVoiceBridgeSession> {
  if (input.socket.readyState !== WebSocket.OPEN || !await input.admitted()) {
    throw new Error("bridge_admission_lost");
  }
  if (input.participantIds.length < 1 || input.participantIds.length > 4 ||
      new Set(input.participantIds).size !== input.participantIds.length ||
      input.participantIds.some(id => !/^\d{15,22}$/.test(id))) {
    throw new Error("bridge_participants_invalid");
  }
  if (!input.connection.rejoin({ channelId: input.voiceChannelId, selfDeaf: false, selfMute: false })) {
    throw new Error("bridge_voice_rejoin_failed");
  }
  await entersState(input.connection, VoiceConnectionStatus.Ready, 20_000);
  if (input.socket.readyState !== WebSocket.OPEN || !await input.admitted()) {
    throw new Error("bridge_admission_lost");
  }

  const encoder = new OpusScript(48_000, 2, OpusScript.Application.VOIP);
  const receivers = input.participantIds.map(userId => ({
    userId,
    decoder: new OpusScript(48_000, 2, OpusScript.Application.VOIP),
    stream: input.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    }),
    frames: [] as Buffer[],
    onData: (_packet: unknown): void => undefined,
    onEnd: (): void => undefined,
    onError: (): void => undefined,
  }));
  // Start a fresh resource with each audible burst. The player enters Idle
  // after a short gap without packets; skipped silence must not leave later
  // reply packets writing into its destroyed stream.
  let opusOutput: PassThrough | null = null;
  const player = createAudioPlayer({ behaviors: { maxMissedFrames: 25 } });
  const subscription = input.connection.subscribe(player);
  if (!subscription) {
    for (const receiver of receivers) { receiver.stream.destroy(); receiver.decoder.delete(); }
    encoder.delete();
    throw new Error("bridge_discord_output_unavailable");
  }
  let stopped = false;
  let watchdogBusy = false;
  let lastPong = Date.now();
  let discordInputPackets = 0;
  let browserOutputFrames = 0;
  let browserOutputQueuedFrames = 0;
  let browserOutputDroppedFrames = 0;
  let playerStarts = 0;
  let playerPlayingTransitions = 0;
  let playerIdleTransitions = 0;
  let consecutiveDroppedOpusFrames = 0;
  const discordInputSignal = createPcmSignal();
  const browserOutputSignal = createPcmSignal();
  const fail = (reason: string): void => {
    if (stopped) return;
    stop();
    input.onFailure(reason);
  };
  const onPong = (): void => { lastPong = Date.now(); };
  const onPlayerStateChange = (oldState: { status: string }, newState: { status: string }): void => {
    if (newState.status === AudioPlayerStatus.Playing && oldState.status !== AudioPlayerStatus.Playing) {
      playerPlayingTransitions += 1;
    }
    if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {
      playerIdleTransitions += 1;
    }
  };
  const ensureOpusOutput = (): PassThrough => {
    if (opusOutput && !opusOutput.destroyed && player.state.status !== AudioPlayerStatus.Idle) {
      return opusOutput;
    }
    opusOutput = new PassThrough({ objectMode: true, highWaterMark: 32 });
    player.play(createAudioResource(opusOutput, { inputType: StreamType.Opus, silencePaddingFrames: 5 }));
    playerStarts += 1;
    return opusOutput;
  };
  const onReceive = (receiver: typeof receivers[number], packet: unknown): void => {
    if (stopped || !Buffer.isBuffer(packet) || packet.length < 1 || packet.length > 3828) {
      return fail("bridge_invalid_discord_packet");
    }
    let pcm: Buffer;
    try { pcm = receiver.decoder.decode(packet); }
    catch { return fail("bridge_discord_decode_failed"); }
    if (!Buffer.isBuffer(pcm) || pcm.length < pcmFrameBytes || pcm.length > 11_520 ||
        pcm.length % pcmFrameBytes !== 0 ||
        receiver.frames.length + pcm.length / pcmFrameBytes > maxInputFramesPerSpeaker) {
      return fail("bridge_discord_audio_invalid");
    }
    for (let offset = 0; offset < pcm.length; offset += pcmFrameBytes) {
      receiver.frames.push(Buffer.from(pcm.subarray(offset, offset + pcmFrameBytes)));
    }
    discordInputPackets++;
  };
  // Decode each speaker independently, then emit one real-time 20 ms stereo
  // frame to GPT Live. Concurrent speech is mixed in that frame; serializing
  // speakers' packets would make overlapping speech run at the wrong speed.
  const inputMixer = setInterval(() => {
    if (stopped || !receivers.some(receiver => receiver.frames.length)) return;
    if (input.socket.readyState !== WebSocket.OPEN || input.socket.bufferedAmount > maxBufferedBytes) {
      fail("bridge_discord_audio_invalid"); return;
    }
    const frames = receivers.flatMap(receiver => receiver.frames.shift() ?? []);
    const mixed = mixDiscordPcmFrames(frames, pcmFrameBytes);
    const frame = Buffer.allocUnsafe(1 + pcmFrameBytes);
    frame[0] = 1;
    mixed.copy(frame, 1);
    observePcm16Signal(discordInputSignal, mixed);
    input.socket.send(frame, { binary: true }, error => { if (error) fail("bridge_socket_send_failed"); });
  }, 20);
  inputMixer.unref?.();
  const onBrowserAudio = (raw: WebSocket.RawData, binary: boolean): void => {
    if (stopped || !binary || !Buffer.isBuffer(raw) || raw.length !== pcmFrameBytes + 1 || raw[0] !== 2) {
      return fail("bridge_browser_audio_invalid");
    }
    browserOutputFrames += 1;
    const pcm = raw.subarray(1);
    // The worklet emits a frame every 20 ms, including silence. Sending that
    // silence can fill Discord's output stream before GPT Live has spoken.
    if (!observePcm16Signal(browserOutputSignal, pcm)) return;
    let packet: Buffer;
    try { packet = encoder.encode(pcm, 960); }
    catch { return fail("bridge_discord_encode_failed"); }
    if (!Buffer.isBuffer(packet) || packet.length < 1 || packet.length > 3828) {
      return fail("bridge_discord_encode_failed");
    }
    let output: PassThrough;
    try { output = ensureOpusOutput(); }
    catch { return fail("bridge_discord_playback_error"); }
    if (queueOpusPacket(output, packet, maxQueuedOpusFrames) === "dropped") {
      browserOutputDroppedFrames += 1;
      consecutiveDroppedOpusFrames += 1;
      if (consecutiveDroppedOpusFrames >= maxConsecutiveDroppedOpusFrames) {
        fail("bridge_discord_output_stalled");
      }
      return;
    }
    browserOutputQueuedFrames += 1;
    consecutiveDroppedOpusFrames = 0;
  };
  const onSocketClose = (): void => fail("bridge_socket_closed");
  const onSocketError = (): void => fail("bridge_socket_error");
  const onReceiveEnd = (): void => fail("bridge_discord_receive_ended");
  const onReceiveError = (): void => fail("bridge_discord_receive_error");
  const onPlayerError = (): void => fail("bridge_discord_playback_error");
  const watchdog = setInterval(() => {
    if (stopped || watchdogBusy) return;
    if (Date.now() - lastPong > 10_000 || input.socket.readyState !== WebSocket.OPEN) {
      fail("bridge_socket_unresponsive");
      return;
    }
    input.socket.ping();
    watchdogBusy = true;
    void input.admitted().then(ok => {
      if (!ok) fail("bridge_admission_lost");
    }).catch(() => fail("bridge_admission_unavailable"))
      .finally(() => { watchdogBusy = false; });
  }, 500);
  watchdog.unref?.();

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(watchdog);
    clearInterval(inputMixer);
    for (const receiver of receivers) {
      receiver.stream.off("data", receiver.onData);
      receiver.stream.off("end", receiver.onEnd);
      receiver.stream.off("error", receiver.onError);
      receiver.stream.destroy();
      receiver.frames.length = 0;
      receiver.decoder.delete();
    }
    input.socket.off("message", onBrowserAudio);
    input.socket.off("close", onSocketClose);
    input.socket.off("error", onSocketError);
    input.socket.off("pong", onPong);
    player.off("error", onPlayerError);
    player.off("stateChange", onPlayerStateChange);
    const playerStateAtStop = player.state.status;
    player.stop(true);
    subscription?.unsubscribe();
    opusOutput?.destroy();
    encoder.delete();
    console.info(`[discord-voice-worker] bridge stopped; discord_input_packets=${discordInputPackets} browser_output_frames=${browserOutputFrames} browser_output_queued_frames=${browserOutputQueuedFrames} browser_output_dropped_frames=${browserOutputDroppedFrames} discord_input_audible_frames=${discordInputSignal.audibleFrames} discord_input_peak=${discordInputSignal.peak} browser_output_audible_frames=${browserOutputSignal.audibleFrames} browser_output_peak=${browserOutputSignal.peak} player_starts=${playerStarts} player_playing_transitions=${playerPlayingTransitions} player_idle_transitions=${playerIdleTransitions} player_state_at_stop=${playerStateAtStop}; metadata only`);
    if (input.socket.readyState === WebSocket.OPEN) input.socket.close(1000, "bridge_stopped");
  };

  for (const receiver of receivers) {
    receiver.onData = packet => onReceive(receiver, packet);
    receiver.onEnd = onReceiveEnd;
    receiver.onError = onReceiveError;
    receiver.stream.on("data", receiver.onData);
    receiver.stream.on("end", receiver.onEnd);
    receiver.stream.on("error", receiver.onError);
  }
  input.socket.on("message", onBrowserAudio);
  input.socket.on("close", onSocketClose);
  input.socket.on("error", onSocketError);
  input.socket.on("pong", onPong);
  player.on("error", onPlayerError);
  player.on("stateChange", onPlayerStateChange);
  if (!stopped) input.socket.send(JSON.stringify({ kind: "ready" }));
  return { stop };
}
