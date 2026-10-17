import OpusScript from "opusscript";
import type { DiscordOpusDecoder } from "./voice-opus-probe.js";

/** One decoder per Discord speaker. The caller discards returned PCM frames. */
export function createDiscordOpusDecoder(): DiscordOpusDecoder {
  const decoder = new OpusScript(48_000, 2, OpusScript.Application.VOIP);
  return {
    decode: (packet) => decoder.decode(packet),
    destroy: () => decoder.delete(),
  };
}
