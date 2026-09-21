// Grok OAuth can pause between reasoning events for longer than any ordinary
// idle bound. The router's post-prologue stall guard is the intended limit, so
// every hop that carries a Grok stream -- router to gateway, the gateway's own
// stream timeout, and the forwarder to xAI -- must outlast it; otherwise the
// pause ends at whichever hop times out first. All of them are computed here
// from the one service environment every child process inherits.
export const DEFAULT_GROK_STREAM_STALL_MS = 10 * 60_000;
export const DEFAULT_GROK_REPAIR_IDLE_MS = 120_000;
export const GROK_TRANSPORT_MARGIN_MS = 60_000;

// Undici's default body idle bound and the gateway's configured request
// timeout. A Grok hop is never given less than those hops already allowed.
const UNDICI_DEFAULT_BODY_TIMEOUT_MS = 300_000;
const LITELLM_REQUEST_TIMEOUT_MS = 600_000;

// Node clamps a larger timer delay to 1ms, which would end every Grok turn at
// its first reasoning event.
const MAX_TIMER_MS = 2_147_483_647;

// Byte gap on a progress-only repair read. This is shorter than the primary
// stall on purpose: a repair withholds the answer, so silence is a failure
// rather than a reasoning pause. It does not change the transport or gateway
// bounds. Zero disables it and leaves the stall as the only backstop.
export function grokRepairIdleMs(environment = process.env) {
  if (!Object.hasOwn(environment, "CODEX_ROUTER_GROK_REPAIR_IDLE_MS")) {
    return DEFAULT_GROK_REPAIR_IDLE_MS;
  }
  const raw = environment.CODEX_ROUTER_GROK_REPAIR_IDLE_MS;
  if (raw === 0 || raw === "0") return 0;
  const configured = Number(raw);
  return Number.isFinite(configured) && configured > 0 && configured <= MAX_TIMER_MS
    ? configured
    : DEFAULT_GROK_REPAIR_IDLE_MS;
}

export function grokStreamStallMs(environment = process.env) {
  const configured = Number(
    environment.CODEX_ROUTER_GROK_STREAM_STALL_MS ?? DEFAULT_GROK_STREAM_STALL_MS,
  );
  return Number.isFinite(configured) &&
    configured > 0 &&
    configured + GROK_TRANSPORT_MARGIN_MS <= MAX_TIMER_MS
    ? configured
    : DEFAULT_GROK_STREAM_STALL_MS;
}

export function grokTransportIdleTimeoutMs(environment = process.env) {
  return Math.max(
    UNDICI_DEFAULT_BODY_TIMEOUT_MS,
    grokStreamStallMs(environment) + GROK_TRANSPORT_MARGIN_MS,
  );
}

export function grokGatewayStreamTimeoutSeconds(environment = process.env) {
  return Math.ceil(
    Math.max(
      LITELLM_REQUEST_TIMEOUT_MS,
      grokStreamStallMs(environment) + GROK_TRANSPORT_MARGIN_MS,
    ) / 1000,
  );
}
