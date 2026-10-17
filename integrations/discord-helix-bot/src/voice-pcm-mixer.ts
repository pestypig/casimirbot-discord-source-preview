/** Mix one 20 ms signed 16-bit stereo frame from each active Discord speaker.
 * Caller owns the per-speaker queues and admission checks. No audio is stored. */
export function mixDiscordPcmFrames(frames: Buffer[], frameBytes = 3840): Buffer {
  if (!frames.length || !Number.isSafeInteger(frameBytes) || frameBytes < 4 || frameBytes % 4 !== 0 ||
      frames.some(frame => frame.length !== frameBytes)) {
    throw new Error("bridge_pcm_mix_invalid");
  }
  const mixed = Buffer.alloc(frameBytes);
  for (let offset = 0; offset < frameBytes; offset += 2) {
    let sample = 0;
    for (const frame of frames) sample += frame.readInt16LE(offset);
    mixed.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), offset);
  }
  return mixed;
}
