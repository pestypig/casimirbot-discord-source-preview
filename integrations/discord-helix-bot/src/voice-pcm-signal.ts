/** Metadata-only PCM signal counts. Never retain audio samples or spoken text. */
export type PcmSignal = {
  frames: number;
  audibleFrames: number;
  peak: number;
};

export const createPcmSignal = (): PcmSignal => ({ frames: 0, audibleFrames: 0, peak: 0 });

export function observePcm16Signal(signal: PcmSignal, pcm: Buffer): boolean {
  signal.frames += 1;
  let framePeak = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const sample = Math.abs(pcm.readInt16LE(offset));
    if (sample > framePeak) framePeak = sample;
  }
  if (framePeak > signal.peak) signal.peak = framePeak;
  // A 256/32768 floor ignores quantization and very low-level codec noise.
  const audible = framePeak >= 256;
  if (audible) signal.audibleFrames += 1;
  return audible;
}
