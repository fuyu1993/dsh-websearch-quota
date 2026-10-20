/**
 * dsh-websearch-quota — pure quota logic.
 *
 * No I/O, no DSH imports: the host half (`lib/index.js`) and the tests both run
 * this file, so every rule that decides what the badge says is unit-testable
 * without booting the app.
 *
 * The model, in one paragraph. A DSH web call (`web_search` / `x_search` /
 * `read_page` / `web_fetch`) is served by the local modsearch stack, which by
 * default falls back to Firecrawl's *keyless* tier: no signup, no key, no
 * published counter — the only hard evidence of exhaustion is a `429` whose
 * body carries `retry_after_seconds`. So:
 *
 *   · the upstream *count* of free searches left is only knowable when a real
 *     API key is configured (Firecrawl `/v2/team/credit-usage`, Tavily
 *     `/usage`) — those come from the host half;
 *   · without a key we keep an honest local ledger (how many calls this machine
 *     made today / this month) plus the exact rate-limit window we observed,
 *     and we never invent a number that upstream never published.
 */

/** Tools that spend a web budget → the bucket they are counted in. */
export const WEB_TOOL_BUCKETS = Object.freeze({
  web_search: 'search',
  x_search: 'x',
  read_page: 'fetch',
  web_fetch: 'fetch',
});

/** How many days of ledger history are kept on disk. */
export const LEDGER_DAYS = 62;

/**
 * Fallback window when a limit is reported without a usable reset time.
 * Firecrawl's keyless tier does return `retry_after_seconds`, so this is only
 * reached for sibling messages that omit it (measured reset times cluster
 * around 45 minutes for the per-minute buckets).
 */
export const FALLBACK_LIMIT_MS = 45 * 60 * 1000;

/** Sanity clamp: a reported window outside this range is treated as garbage. */
export const MIN_LIMIT_MS = 30 * 1000;
export const MAX_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;

export function bucketOf(toolName) {
  return typeof toolName === 'string' ? WEB_TOOL_BUCKETS[toolName] ?? null : null;
}

/** Local `YYYY-MM-DD` — the ledger follows the user's day, not UTC. */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Local `YYYY-MM`. */
export function monthKey(ts = Date.now()) {
  return dayKey(ts).slice(0, 7);
}

/** Local `HH:MM`. */
export function formatClock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Compact duration: `45s`, `12m`, `16h47m`, `2d3h`. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  if (total < 60) return `${Math.round(total)}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) return remMinutes ? `${hours}h${String(remMinutes).padStart(2, '0')}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d${remHours}h` : `${days}d`;
}

/** Any string that looks like a vendor key, scrubbed before it leaves the host. */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/\b(fc|tvly|exa|sk)-[A-Za-z0-9_-]{8,}/g, '$1-***')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '***');
}

/** Flatten a `tools/result` payload into one searchable string (never stored). */
export function resultText(result) {
  if (result === null || result === undefined) return '';
  const parts = [];
  if (result.error && typeof result.error.message === 'string') parts.push(result.error.message);
  for (const key of ['value', 'content', 'meta']) {
    const value = result[key];
    if (value === undefined) continue;
    if (typeof value === 'string') {
      parts.push(value);
      continue;
    }
    try {
      parts.push(JSON.stringify(value));
    } catch {
      /* circular / exotic values are irrelevant to the pattern match */
    }
  }
  return parts.join('\n');
}

const RETRY_AFTER_PATTERNS = [
  // `"retry_after_seconds": 60308`, `retry-after: 60`, `retry_after = 30`
  /"?retry[_-]?after(?:_seconds|_ms|_s)?"?\s*[:=]\s*"?(\d+(?:\.\d+)?)/i,
  // `Resets in 16h 47m 12s` / `Reset in 45 minutes`
  /resets?\s+in\s+(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?!s))?\s*(?:(\d+)\s*s)?/i,
  // `try again in 90 seconds`
  /(?:try again|available)\s+in\s+(\d+(?:\.\d+)?)\s*(s|sec|seconds?|m|min|minutes?|h|hours?)/i,
];

/**
 * Seconds until the window reopens, or `null` when the message carries none.
 * Units: `retry_after` is seconds unless the key itself says `_ms`.
 */
export function parseRetryAfterSeconds(text) {
  const source = String(text ?? '');
  const raw = source.match(RETRY_AFTER_PATTERNS[0]);
  if (raw) {
    const value = Number(raw[1]);
    if (!Number.isFinite(value)) return null;
    return /retry[_-]?after_ms/i.test(source) ? value / 1000 : value;
  }
  const duration = source.match(RETRY_AFTER_PATTERNS[1]);
  if (duration && duration.slice(1).some(Boolean)) {
    return (
      Number(duration[1] ?? 0) * 86400 +
      Number(duration[2] ?? 0) * 3600 +
      Number(duration[3] ?? 0) * 60 +
      Number(duration[4] ?? 0)
    );
  }
  const relative = source.match(RETRY_AFTER_PATTERNS[2]);
  if (relative) {
    const value = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const scale = unit.startsWith('s') ? 1 : unit.startsWith('m') ? 60 : 3600;
    return value * scale;
  }
  return null;
}

/** Credits a response says it consumed, when the provider volunteers it. */
export function parseCreditsUsed(text) {
  const match = String(text ?? '').match(/"?credits?Used"?\s*[:=]\s*(\d+(?:\.\d+)?)/i);
  return match ? Number(match[1]) : null;
}

const FIRE
  = /firecrawl/i;
const LIMITED = /(rate.?limit|too many requests|\b429\b|out of credit|quota|exhaust)/i;

/**
 * Read a tool result as evidence about the *keyless* Firecrawl budget.
 *
 * Returns `null` when the result says nothing about it, otherwise
 * `{ until, durationMs, exact, evidence }` — `exact` is true only when the
 * message itself carried the reset window, in which case `until` is the real
 * reopen time rather than our fallback guess.
 */
export function detectLimit(text, now = Date.now()) {
  const source = String(text ?? '');
  if (!FIRE.test(source) || !LIMITED.test(source)) return null;
  const seconds = parseRetryAfterSeconds(source);
  const hasSeconds = Number.isFinite(seconds) && seconds !== null;
  const durationMs = hasSeconds
    ? Math.min(MAX_LIMIT_MS, Math.max(MIN_LIMIT_MS, seconds * 1000))
    : FALLBACK_LIMIT_MS;
  return {
    until: now + durationMs,
    durationMs,
    exact: Boolean(hasSeconds),
    evidence: redactSecrets(source.replace(/\s+/g, ' ').trim().slice(0, 240)),
    at: now,
  };
}

/** Drop ledger days outside the retention window. */
export function pruneDays(days, now = Date.now(), keep = LEDGER_DAYS) {
  const cutoff = dayKey(now - keep * 86400 * 1000);
  const out = {};
  for (const [day, entry] of Object.entries(days ?? {})) {
    if (day >= cutoff) out[day] = entry;
  }
  return out;
}

export function emptyState() {
  return {
    version: 1,
    days: {},
    lastCallAt: null,
    lastSuccessAt: null,
    keyless: { until: 0, at: null, exact: false, evidence: null, source: null },
    probes: { at: null, lastStatus: null, lastMessage: null },
  };
}

/** Fill in fields a state file written by an older version may lack. */
export function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    days: pruneDays(raw.days ?? {}),
    keyless: { ...base.keyless, ...(raw.keyless ?? {}) },
    probes: { ...base.probes, ...(raw.probes ?? {}) },
  };
}

const EMPTY_DAY = Object.freeze({ calls: 0, search: 0, fetch: 0, x: 0, errors: 0, credits: 0 });

function addDay(state, at, bucket, { isError, credits }) {
  const key = dayKey(at);
  const day = { ...EMPTY_DAY, ...(state.days[key] ?? {}) };
  day.calls += 1;
  day[bucket] += 1;
  if (isError) day.errors += 1;
  if (Number.isFinite(credits) && credits > 0) day.credits += credits;
  return { ...state.days, [key]: day };
}

/**
 * Fold one observed tool call into the state. Pure: the caller persists the
 * returned object. `text` is the flattened result (see `resultText`).
 */
export function applyCall(state, { tool, at = Date.now(), isError = false, text = '' } = {}) {
  const bucket = bucketOf(tool);
  if (!bucket) return state;
  const credits = isError ? null : parseCreditsUsed(text);
  let next = {
    ...state,
    days: addDay(state, at, bucket, { isError, credits }),
    lastCallAt: at,
    lastSuccessAt: isError ? state.lastSuccessAt : at,
  };
  if (isError) {
    const limit = detectLimit(text, at);
    if (limit) {
      const previous = state.keyless ?? {};
      // Keep the longer window when several engines complain in a row.
      if (!(previous.until > limit.until && previous.at && at - previous.at < 60_000)) {
        next = {
          ...next,
          keyless: { until: limit.until, at: limit.at, exact: limit.exact, evidence: limit.evidence, source: 'tool-result' },
        };
      }
    }
  }
  return next;
}

/** Record the outcome of an explicit `/websearch-quota?action=probe` run. */
export function applyProbe(state, { at = Date.now(), status, body = '', message = null } = {}) {
  const probes = { at, lastStatus: status ?? null, lastMessage: redactSecrets(String(message ?? '')).slice(0, 240) || null };
  if (status === 429) {
    const seconds = parseRetryAfterSeconds(body);
    const durationMs = Number.isFinite(seconds) && seconds !== null
      ? Math.min(MAX_LIMIT_MS, Math.max(MIN_LIMIT_MS, seconds * 1000))
      : FALLBACK_LIMIT_MS;
    return {
      ...state,
      probes,
      keyless: {
        until: at + durationMs,
        at,
        exact: Number.isFinite(seconds) && seconds !== null,
        evidence: redactSecrets(String(body).replace(/\s+/g, ' ').trim().slice(0, 240)),
        source: 'probe',
      },
    };
  }
  if (status === 200) {
    // A live search succeeded: the keyless budget is open right now.
    return {
      ...state,
      probes,
      keyless: { until: 0, at, exact: true, evidence: 'probe: search succeeded', source: 'probe' },
    };
  }
  return { ...state, probes };
}

/**
 * Keyless availability as the badge should read it:
 * `limited` (window still open) · `ok` (last evidence says open) · `unknown`
 * (nothing observed since the plugin was installed).
 */
export function keylessStatus(state, now = Date.now()) {
  const keyless = state?.keyless ?? {};
  if (keyless.until && keyless.until > now) {
    return {
      state: 'limited',
      until: keyless.until,
      remainingMs: keyless.until - now,
      exact: Boolean(keyless.exact),
      evidence: keyless.evidence ?? null,
      source: keyless.source ?? null,
      at: keyless.at ?? null,
    };
  }
  if (keyless.at) {
    return { state: 'ok', until: 0, remainingMs: 0, exact: Boolean(keyless.exact), evidence: keyless.evidence ?? null, source: keyless.source ?? null, at: keyless.at };
  }
  return { state: 'unknown', until: 0, remainingMs: 0, exact: false, evidence: null, source: null, at: null };
}

/** Roll the ledger up for the panel: today, this month, and the last call. */
export function summarize(state, now = Date.now()) {
  const today = dayKey(now);
  const month = monthKey(now);
  const days = state?.days ?? {};
  const totals = { calls: 0, search: 0, fetch: 0, x: 0, errors: 0, credits: 0 };
  let monthCalls = 0;
  for (const [day, entry] of Object.entries(days)) {
    const merged = { ...EMPTY_DAY, ...entry };
    if (day.startsWith(month)) monthCalls += merged.calls;
    for (const key of Object.keys(totals)) totals[key] += merged[key] ?? 0;
  }
  const todayEntry = { ...EMPTY_DAY, ...(days[today] ?? {}) };
  return {
    today: { day: today, ...todayEntry },
    monthCalls,
    allTime: totals,
    trackedDays: Object.keys(days).length,
    lastCallAt: state?.lastCallAt ?? null,
    lastSuccessAt: state?.lastSuccessAt ?? null,
  };
}
