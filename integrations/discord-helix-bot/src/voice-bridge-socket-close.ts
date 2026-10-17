/** A socket that carried media owns its invitation until the call has left.
 * Pre-admission closes only release the pending bridge reservation. */
export function voiceBridgeSocketCloseAction(input: {
  invitationStillJoined: boolean;
  bridgeActive: boolean;
  sessionStarting: boolean;
}): "ignore" | "release" | "end" {
  if (!input.invitationStillJoined) return "ignore";
  return input.bridgeActive || input.sessionStarting ? "end" : "release";
}
