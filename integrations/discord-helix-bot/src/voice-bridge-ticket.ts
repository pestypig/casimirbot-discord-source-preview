import crypto from "node:crypto";

const SIGNING_CONTEXT = "casimir.discord.voice.bridge.v1\n";
const ticketId = /^discord_voice:[0-9a-f-]{36}$/u;
const roomId = /^shared_realtime_room:[0-9a-f-]{36}$/u;
const workerIdPattern = /^[a-zA-Z0-9:_-]{8,128}$/u;
// The site signs for 30 seconds. A small site/worker clock difference must not
// reject a newly issued ticket before its signature and scope can be checked.
const MAX_ISSUANCE_CLOCK_SKEW_MS = 5_000;

export type VerifiedVoiceBridgeTicket = Readonly<{
  version: 1;
  invitation_id: string;
  room_id: string;
  profile_id: string;
  worker_id: string;
  expires_at_ms: number;
  nonce: string;
}>;

/** The ticket is a one-use, short-lived capability. Validate it before any
 * invitation, consent or media work; never include it in logs or receipts. */
export function verifyVoiceBridgeTicket(
  ticket: unknown,
  secret: string,
  expectedWorkerId: string,
  now = Date.now(),
): VerifiedVoiceBridgeTicket | null {
  if (typeof ticket !== "string" || ticket.length > 2048 || secret.length < 32 ||
      !workerIdPattern.test(expectedWorkerId)) return null;
  const match = /^([A-Za-z0-9_-]{120,1400})\.([A-Za-z0-9_-]{43})$/u.exec(ticket);
  if (!match) return null;
  const [, encoded, signature] = match;
  const expected = crypto.createHmac("sha256", secret).update(SIGNING_CONTEXT)
    .update(encoded).digest();
  const supplied = Buffer.from(signature, "base64url");
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  let payload: unknown;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) return null;
    payload = JSON.parse(bytes.toString("utf8"));
  } catch { return null; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const data = payload as Record<string, unknown>;
  if (Object.keys(data).sort().join(",") !==
      "expires_at_ms,invitation_id,nonce,profile_id,room_id,version,worker_id" ||
      data.version !== 1 || typeof data.invitation_id !== "string" || !ticketId.test(data.invitation_id) ||
      typeof data.room_id !== "string" || !roomId.test(data.room_id) ||
      typeof data.profile_id !== "string" || data.profile_id.length < 3 || data.profile_id.length > 256 ||
      data.worker_id !== expectedWorkerId ||
      typeof data.nonce !== "string" || !/^[A-Za-z0-9_-]{22}$/u.test(data.nonce) ||
      !Number.isSafeInteger(data.expires_at_ms) ||
      Number(data.expires_at_ms) <= now ||
      Number(data.expires_at_ms) > now + 30_000 + MAX_ISSUANCE_CLOCK_SKEW_MS) return null;
  return data as VerifiedVoiceBridgeTicket;
}

/** Consume before asynchronous admission work so parallel connections cannot
 * reuse one ticket. The ledger stays bounded and is process-local. */
export class VoiceBridgeNonceLedger {
  private readonly used = new Map<string, number>();

  consume(ticket: VerifiedVoiceBridgeTicket, now = Date.now()): boolean {
    for (const [nonce, expires] of this.used) if (expires <= now) this.used.delete(nonce);
    if (this.used.size >= 1024 || this.used.has(ticket.nonce) || ticket.expires_at_ms <= now) return false;
    this.used.set(ticket.nonce, ticket.expires_at_ms);
    return true;
  }
}
