import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../../client/public/discord-voice-bridge-worklet.js", import.meta.url), "utf8");

test("Discord worklet carries 48 kHz PCM into GPT Live and frames output for Discord", () => {
  const processors = new Map<string, new () => {
    port: { onmessage?: (event: { data: Float32Array }) => void; messages: ArrayBuffer[] };
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  }>();
  class Processor {
    port = {
      onmessage: undefined as ((event: { data: Float32Array }) => void) | undefined,
      messages: [] as ArrayBuffer[],
      postMessage: (buffer: ArrayBuffer) => { this.port.messages.push(buffer); },
    };
  }
  vm.runInNewContext(source, {
    AudioWorkletProcessor: Processor, Float32Array, Int16Array,
    registerProcessor: (name: string, ctor: new () => never) => processors.set(name, ctor),
  });
  const Input = processors.get("casimir-discord-voice-input");
  const Output = processors.get("casimir-discord-voice-output");
  assert.ok(Input && Output);
  const input = new Input();
  input.port.onmessage?.({ data: Float32Array.from([0.25, -0.5]) });
  const playback = new Float32Array(128);
  assert.equal(input.process([], [[playback]]), true);
  assert.equal(playback[0], 0.25);
  assert.equal(playback[1], -0.5);
  assert.equal(playback[2], 0);

  const output = new Output();
  for (let i = 0; i < 8; i += 1) {
    const left = new Float32Array(128).fill(1);
    const right = new Float32Array(128).fill(-1);
    const mutedLocalPlayback = new Float32Array(128).fill(0.5);
    assert.equal(output.process([[left, right]], [[mutedLocalPlayback]]), true);
    assert.equal(mutedLocalPlayback[0], 0);
  }
  assert.equal(output.port.messages.length, 1);
  const frame = new Int16Array(output.port.messages[0]);
  assert.equal(frame.length, 1920);
  assert.equal(frame[0], 32767);
  assert.equal(frame[1], -32768);
});
