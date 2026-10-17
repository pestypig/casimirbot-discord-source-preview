import type { Readable } from "node:stream";

export type DiscordOpusProbeOutcome =
  | "completed"
  | "invalid_packet"
  | "decode_error"
  | "invalid_pcm"
  | "packet_budget_exceeded"
  | "stream_ended"
  | "stream_error";

export type DiscordOpusProbeResult = {
  outcome: DiscordOpusProbeOutcome;
  elapsedMs: number;
  totalPackets: number;
  totalBytes: number;
  decodedFrames: number;
  decodedBytes: number;
  packetsByUser: Readonly<Record<string, number>>;
};

export type DiscordOpusProbe = { stop(): void };
export type DiscordOpusDecoder = { decode(packet: Buffer): Buffer; destroy(): void };

/** A bounded receive observation. Every packet is decoded for basic PCM frame
 * integrity, then both packet and PCM bytes are discarded. This is not an STT
 * input or proof of complete speech. The caller owns consent and DAVE gates. */
export function startDiscordOpusProbe(input: {
  participantIds: string[];
  subscribe: (userId: string) => Pick<Readable, "on" | "destroy">;
  createDecoder: (userId: string) => DiscordOpusDecoder;
  durationMs: number;
  maxPackets: number;
  onFinish: (result: DiscordOpusProbeResult) => void;
}): DiscordOpusProbe {
  const participants = [...new Set(input.participantIds)];
  if (participants.length === 0 || participants.length > 25 ||
      participants.length !== input.participantIds.length ||
      participants.some((id) => !/^\d{15,22}$/.test(id)) ||
      !Number.isSafeInteger(input.durationMs) || input.durationMs < 250 || input.durationMs > 15_000 ||
      !Number.isSafeInteger(input.maxPackets) || input.maxPackets < 1 || input.maxPackets > 20_000) {
    throw new Error("invalid_discord_opus_probe_scope");
  }

  const startedAt = Date.now();
  const packetsByUser: Record<string, number> = Object.fromEntries(participants.map((id) => [id, 0]));
  const streams: Array<Pick<Readable, "on" | "destroy">> = [];
  const decoders: DiscordOpusDecoder[] = [];
  let totalPackets = 0;
  let totalBytes = 0;
  let decodedFrames = 0;
  let decodedBytes = 0;
  let active = true;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stop = (): void => {
    if (!active) return;
    active = false;
    if (timer) clearTimeout(timer);
    for (const stream of streams) {
      try { stream.destroy(); } catch { /* Preserve the terminal receipt. */ }
    }
    for (const decoder of decoders) {
      try { decoder.destroy(); } catch { /* Preserve the terminal receipt. */ }
    }
  };
  const finish = (outcome: DiscordOpusProbeOutcome): void => {
    if (!active) return;
    const result: DiscordOpusProbeResult = {
      outcome,
      elapsedMs: Date.now() - startedAt,
      totalPackets,
      totalBytes,
      decodedFrames,
      decodedBytes,
      packetsByUser: { ...packetsByUser },
    };
    stop();
    input.onFinish(result);
  };

  timer = setTimeout(() => finish("completed"), input.durationMs);
  timer.unref?.();
  try {
    for (const userId of participants) {
      let decoder: DiscordOpusDecoder | null = null;
      const stream = input.subscribe(userId);
      streams.push(stream);
      stream.on("data", (packet: unknown) => {
        if (!active) return;
        if (!Buffer.isBuffer(packet) || packet.length < 1 || packet.length > 3828) {
          finish("invalid_packet");
          return;
        }
        if (totalPackets >= input.maxPackets) {
          finish("packet_budget_exceeded");
          return;
        }
        let pcm: Buffer;
        try {
          if (!decoder) {
            decoder = input.createDecoder(userId);
            decoders.push(decoder);
          }
          pcm = decoder.decode(packet);
        } catch {
          finish("decode_error");
          return;
        }
        // 48 kHz, stereo, signed 16-bit PCM: complete samples are four bytes.
        // The decoder's maximum 60 ms frame is 2,880 samples/channel.
        if (!Buffer.isBuffer(pcm) || pcm.length < 4 || pcm.length > 11_520 || pcm.length % 4 !== 0) {
          finish("invalid_pcm");
          return;
        }
        totalPackets += 1;
        totalBytes += packet.length;
        decodedFrames += 1;
        decodedBytes += pcm.length;
        packetsByUser[userId] += 1;
      });
      stream.on("end", () => finish("stream_ended"));
      stream.on("error", () => finish("stream_error"));
    }
  } catch (error) {
    stop();
    throw error;
  }
  return { stop };
}
