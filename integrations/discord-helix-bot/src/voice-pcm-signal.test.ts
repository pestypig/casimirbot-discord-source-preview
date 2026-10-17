import assert from "node:assert/strict";
import test from "node:test";
import { createPcmSignal, observePcm16Signal } from "./voice-pcm-signal.js";

test("PCM signal meter counts audible frames without retaining audio", () => {
  const signal = createPcmSignal();
  assert.equal(observePcm16Signal(signal, Buffer.from([0, 0, 1, 0])), false);
  assert.equal(observePcm16Signal(signal, Buffer.from([0, 0, 0, 1])), true);
  assert.equal(observePcm16Signal(signal, Buffer.from([0, 128])), true);
  assert.deepEqual(signal, { frames: 3, audibleFrames: 2, peak: 32768 });
});
