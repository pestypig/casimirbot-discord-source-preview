/** Keep live Discord playback bounded without interpreting stream backpressure
 * as a failed write. Writable.write() accepts the packet even when it returns
 * false; the return value only asks the producer to pause. */
export function queueOpusPacket(
  output: { readonly destroyed: boolean; readonly readableLength: number; readonly writableLength: number; write(packet: Buffer): boolean },
  packet: Buffer,
  maxQueuedFrames: number,
): "queued" | "dropped" {
  if (output.destroyed || output.readableLength + output.writableLength >= maxQueuedFrames) return "dropped";
  output.write(packet);
  return "queued";
}
