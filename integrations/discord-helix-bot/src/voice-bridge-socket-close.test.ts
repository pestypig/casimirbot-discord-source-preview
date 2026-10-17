import assert from "node:assert/strict";
import test from "node:test";
import { voiceBridgeSocketCloseAction } from "./voice-bridge-socket-close.js";

test("a closed active media socket ends its Discord invitation", () => {
  assert.equal(voiceBridgeSocketCloseAction({ invitationStillJoined: true,
    bridgeActive: true, sessionStarting: false }), "end");
});

test("a closed socket during media startup ends its Discord invitation", () => {
  assert.equal(voiceBridgeSocketCloseAction({ invitationStillJoined: true,
    bridgeActive: false, sessionStarting: true }), "end");
});

test("a rejected pre-admission socket releases only its reservation", () => {
  assert.equal(voiceBridgeSocketCloseAction({ invitationStillJoined: true,
    bridgeActive: false, sessionStarting: false }), "release");
});

test("a stale socket does not affect a replacement invitation", () => {
  assert.equal(voiceBridgeSocketCloseAction({ invitationStillJoined: false,
    bridgeActive: true, sessionStarting: false }), "ignore");
});
