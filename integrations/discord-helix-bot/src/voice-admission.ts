import type { DiscordVoiceRosterSnapshot } from "./voice-roster.js";

type Consent = { discord_user_id: unknown; consent_version: unknown };

export type DiscordVoiceAdmissionAssessment = {
  eligible: boolean;
  reason: string;
  rosterRevision: number;
  participantCount: number;
};

/** An observation of receive prerequisites, not permission to capture audio.
 * The worker keeps receive and playback off until an end-to-end path is accepted. */
export function assessDiscordVoiceAdmission(input: {
  transportReady: boolean;
  leaseConfirmed: boolean;
  armed: boolean;
  roster: DiscordVoiceRosterSnapshot;
  consents: Consent[];
}): DiscordVoiceAdmissionAssessment {
  const base = {
    rosterRevision: input.roster.revision,
    participantCount: input.roster.participantIds.length,
  };
  const denied = (reason: string): DiscordVoiceAdmissionAssessment => ({ eligible: false, reason, ...base });
  if (!input.transportReady) return denied("dave_transport_unavailable");
  if (!input.leaseConfirmed) return denied("worker_lease_unconfirmed");
  if (!input.armed) return denied("not_armed");
  if (!input.roster.complete) return denied("roster_incomplete");
  if (!input.roster.botPresent) return denied("bot_voice_state_unconfirmed");
  if (input.roster.participantIds.length === 0) return denied("no_human_participants");
  const participants = new Set(input.roster.participantIds);
  if (participants.size !== input.roster.participantIds.length ||
      input.roster.participantIds.some((id) => !/^\d{15,22}$/.test(id))) {
    return denied("roster_invalid");
  }

  const consented = new Set<string>();
  for (const entry of input.consents) {
    if (!entry || typeof entry.discord_user_id !== "string" ||
        !/^\d{15,22}$/.test(entry.discord_user_id) ||
        typeof entry.consent_version !== "number" ||
        !Number.isSafeInteger(entry.consent_version) || entry.consent_version < 1 ||
        consented.has(entry.discord_user_id)) return denied("consent_response_invalid");
    consented.add(entry.discord_user_id);
  }
  const missing = input.roster.participantIds.filter((id) => !consented.has(id)).length;
  if (missing) return denied(`participants_missing_consent:${missing}/${input.roster.participantIds.length}`);
  return {
    eligible: true,
    reason: `consent_coverage_complete:${input.roster.participantIds.length}`,
    ...base,
  };
}
