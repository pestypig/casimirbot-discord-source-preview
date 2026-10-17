import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { queueOpusPacket } from "./voice-opus-output.js";

test("a false stream write still queues the accepted Opus packet", () => {
  const output = new PassThrough({ objectMode: true, highWaterMark: 1 });
  const packet = Buffer.from([0x01]);
  assert.equal(queueOpusPacket(output, packet, 2), "queued");
  assert.equal(output.writableLength, 1);
  assert.deepEqual(output.read(), packet);
  output.destroy();
});

test("the Opus queue drops a frame at its explicit memory bound", () => {
  const output = new PassThrough({ objectMode: true, highWaterMark: 1 });
  assert.equal(queueOpusPacket(output, Buffer.from([0x01]), 2), "queued");
  assert.equal(queueOpusPacket(output, Buffer.from([0x02]), 2), "dropped");
  assert.equal(output.writableLength, 1);
  output.destroy();
});

test("the Opus queue does not count a write to a destroyed resource as queued", () => {
  const output = new PassThrough({ objectMode: true });
  output.destroy();
  assert.equal(queueOpusPacket(output, Buffer.from([0x01]), 2), "dropped");
});
