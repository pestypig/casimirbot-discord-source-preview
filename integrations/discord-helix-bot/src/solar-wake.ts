type SolarTickReceipt = {
  ok?: unknown;
  due?: unknown;
  delivered?: unknown;
  alreadyDelivered?: unknown;
  receipts?: unknown;
};

const newYorkClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", hourCycle: "h23",
});

function dueDate(now: Date): string | null {
  const parts = Object.fromEntries(newYorkClock.formatToParts(now)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  return parts.hour === "08" ? `${parts.year}-${parts.month}-${parts.day}` : null;
}

/** A wake request only. The domain owns the movie choice, subscription, claim,
 * Discord send, and durable delivery receipt. */
export function createDiscordSolarWake(input: {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (message: string) => void;
}) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());
  const log = input.log ?? console.info;
  let confirmedDate: string | null = null;
  let lastAttemptAt = 0;
  let running = false;

  return async function tick(): Promise<void> {
    const current = now();
    const date = dueDate(current);
    if (!date || !input.token || confirmedDate === date || running ||
        current.getTime() - lastAttemptAt < 5 * 60_000) return;
    lastAttemptAt = current.getTime();
    running = true;
    try {
      const response = await fetchImpl(`${input.baseUrl}/api/discord/solar/tick`, {
        method: "POST",
        headers: { Authorization: `Bearer ${input.token}` },
        signal: AbortSignal.timeout(8000),
      });
      const receipt = await response.json() as SolarTickReceipt;
      const delivered = typeof receipt.delivered === "number" ? receipt.delivered : 0;
      const alreadyDelivered = typeof receipt.alreadyDelivered === "number" ? receipt.alreadyDelivered : 0;
      if (response.ok && receipt.ok === true && receipt.due === true &&
          delivered + alreadyDelivered > 0 && Array.isArray(receipt.receipts) && receipt.receipts.length > 0) {
        confirmedDate = date;
        log(`[discord-voice-worker] solar delivery confirmed for ${date}`);
      } else {
        log(`[discord-voice-worker] solar delivery unconfirmed for ${date}; HTTP ${response.status}`);
      }
    } catch {
      log(`[discord-voice-worker] solar delivery wake unavailable for ${date}`);
    } finally {
      running = false;
    }
  };
}
