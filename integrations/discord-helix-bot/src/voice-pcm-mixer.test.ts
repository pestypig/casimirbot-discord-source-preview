import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mixDiscordPcmFrames } from "./voice-pcm-mixer";

describe("Discord multi-speaker PCM mixer", () => {
  it("sums simultaneous speakers into one frame", () => {
    const a = Buffer.alloc(8);
    const b = Buffer.alloc(8);
    a.writeInt16LE(1000, 0);
    a.writeInt16LE(-2000, 2);
    b.writeInt16LE(2000, 0);
    b.writeInt16LE(-1000, 2);
    const mixed = mixDiscordPcmFrames([a, b], 8);
    assert.equal(mixed.readInt16LE(0), 3000);
    assert.equal(mixed.readInt16LE(2), -3000);
    assert.equal(mixed.length, 8);
  });

  it("clips concurrent peaks safely", () => {
    const a = Buffer.alloc(4);
    const b = Buffer.alloc(4);
    a.writeInt16LE(30000, 0);
    b.writeInt16LE(30000, 0);
    a.writeInt16LE(-30000, 2);
    b.writeInt16LE(-30000, 2);
    const mixed = mixDiscordPcmFrames([a, b], 4);
    assert.equal(mixed.readInt16LE(0), 32767);
    assert.equal(mixed.readInt16LE(2), -32768);
  });

  it("rejects incomplete or missing frames", () => {
    assert.throws(() => mixDiscordPcmFrames([], 4), /bridge_pcm_mix_invalid/);
    assert.throws(() => mixDiscordPcmFrames([Buffer.alloc(2)], 4), /bridge_pcm_mix_invalid/);
  });
});
