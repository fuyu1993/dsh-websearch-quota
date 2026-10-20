/**
 * Unit tests for the pure half (lib/quota.js): the retry-window parsing, the
 * Firecrawl-limit detector, the ledger folding and the state migrations. No
 * network, no clock dependency — every case passes an explicit `now`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyCall,
  applyProbe,
  bucketOf,
  dayKey,
  detectLimit,
  emptyState,
  FALLBACK_LIMIT_MS,
  formatDuration,
  MAX_LIMIT_MS,
  MIN_LIMIT_MS,
  monthKey,
  normalizeState,
  parseCreditsUsed,
  parseRetryAfterSeconds,
  pruneDays,
  redactSecrets,
  resultText,
  keylessStatus,
  summarize,
} from '../lib/quota.js';

/** The exact body observed from the live keyless endpoint on this machine. */
const OBSERVED_429 = '{"success":false,"error":"You\'ve hit Firecrawl\'s keyless free tier rate limit.'
  + ' To continue now, create a free API key at https://firecrawl.dev/k/tm6nwh8rg4ps\\n\\nThen authenticate with:\\n'
  + 'Authorization: Bearer YOUR_API_KEY","reason":"credits","retry_after_seconds":60308,'
  + '"signup_url":"https://firecrawl.dev/k/tm6nwh8rg4ps"}';

const NOW = Date.parse('2026-10-13T16:32:00+08:00');

test('bucketOf maps the four web tools and ignores everything else', () => {
  assert.equal(bucketOf('web_search'), 'search');
  assert.equal(bucketOf('web_fetch'), 'fetch');
  assert.equal(bucketOf('x_search'), 'x');
  assert.equal(bucketOf('read_page'), 'fetch');
  assert.equal(bucketOf('bash'), null);
  assert.equal(bucketOf(undefined), null);
});

test('parseRetryAfterSeconds reads every shape the vendors use', () => {
  assert.equal(parseRetryAfterSeconds(OBSERVED_429), 60308);
  assert.equal(parseRetryAfterSeconds('retry-after: 60'), 60);
  assert.equal(parseRetryAfterSeconds('retry_after = 30'), 30);
  assert.equal(parseRetryAfterSeconds('"retry_after_ms": 5000'), 5);
  assert.equal(parseRetryAfterSeconds('Resets in 16h47m'), 60420);
  assert.equal(parseRetryAfterSeconds('Resets in 3d2h'), 266400);
  assert.equal(parseRetryAfterSeconds('try again in 90 seconds'), 90);
  assert.equal(parseRetryAfterSeconds('available in 45 minutes'), 2700);
  assert.equal(parseRetryAfterSeconds('no window here'), null);
});

test('parseCreditsUsed only trusts an explicit creditsUsed field', () => {
  assert.equal(parseCreditsUsed('{"data":{"creditsUsed":2}}'), 2);
  assert.equal(parseCreditsUsed('{"creditUsed":1}'), 1);
  assert.equal(parseCreditsUsed('{"meta":{"usage":{"creditsUsed":0.5}}}'), 0.5);
  assert.equal(parseCreditsUsed('just some results'), null);
});

test('detectLimit is Firecrawl-only and keeps the exact window when offered', () => {
  const exact = detectLimit(OBSERVED_429, NOW);
  assert.equal(exact.exact, true);
  assert.equal(exact.durationMs, 60308000);
  assert.equal(exact.until, NOW + 60308000);
  assert.match(exact.evidence, /keyless free tier rate limit/);

  const guessed = detectLimit('Firecrawl error: 429 Too Many Requests', NOW);
  assert.equal(guessed.exact, false);
  assert.equal(guessed.durationMs, FALLBACK_LIMIT_MS);

  // Not Firecrawl → not our budget.
  assert.equal(detectLimit('github api: rate limit exceeded', NOW), null);
  // Firecrawl, but a success message → nothing to report.
  assert.equal(detectLimit('Firecrawl search returned 5 results', NOW), null);
});

test('detectLimit clamps absurd windows into the sane range', () => {
  assert.equal(detectLimit('firecrawl quota exhausted, retry_after_seconds: 999999999', NOW).durationMs, MAX_LIMIT_MS);
  assert.equal(detectLimit('firecrawl quota exhausted, retry_after_seconds: 1', NOW).durationMs, MIN_LIMIT_MS);
});

test('applyCall folds a call into the ledger and records the limit window', () => {
  const at = NOW;
  const after = applyCall(emptyState(), { tool: 'web_search', at, isError: true, text: OBSERVED_429 });
  const day = after.days[dayKey(at)];
  assert.equal(day.calls, 1);
  assert.equal(day.search, 1);
  assert.equal(day.errors, 1);
  assert.equal(day.credits, 0);
  assert.equal(after.lastCallAt, at);
  assert.equal(after.lastSuccessAt, null);
  assert.equal(after.keyless.until, at + 60308000);
  assert.equal(after.keyless.source, 'tool-result');
  assert.equal(after.keyless.exact, true);
});

test('applyCall counts credits and successes, and ignores unknown tools', () => {
  let state = applyCall(emptyState(), { tool: 'web_search', at: NOW, isError: false, text: '{"creditsUsed":2}' });
  state = applyCall(state, { tool: 'web_fetch', at: NOW + 1000, isError: false, text: '{"creditsUsed":1}' });
  state = applyCall(state, { tool: 'bash', at: NOW + 2000, isError: false, text: 'ls' });
  const day = state.days[dayKey(NOW)];
  assert.equal(day.calls, 2, 'bash must not be counted');
  assert.equal(day.search, 1);
  assert.equal(day.fetch, 1);
  assert.equal(day.credits, 3);
  assert.equal(state.lastSuccessAt, NOW + 1000);
});

test('a later, shorter complaint does not shorten the open window', () => {
  let state = applyCall(emptyState(), { tool: 'web_search', at: NOW, isError: true, text: OBSERVED_429 });
  const first = state.keyless.until;
  state = applyCall(state, { tool: 'web_search', at: NOW + 1000, isError: true, text: 'firecrawl 429, retry_after_seconds: 60' });
  assert.equal(state.keyless.until, first);
});

test('applyProbe treats 429 as evidence and 200 as an open budget', () => {
  const limited = applyProbe(emptyState(), { at: NOW, status: 429, body: OBSERVED_429 });
  assert.equal(limited.keyless.source, 'probe');
  assert.equal(limited.keyless.until, NOW + 60308000);
  assert.equal(limited.probes.lastStatus, 429);

  const open = applyProbe(limited, { at: NOW + 1000, status: 200, body: '{"success":true,"data":{"creditsUsed":2}}' });
  assert.equal(open.keyless.until, 0);
  assert.equal(open.keyless.evidence, 'probe: search succeeded');
  assert.equal(keylessStatus(open, NOW + 2000).state, 'ok');

  const failed = applyProbe(open, { at: NOW + 3000, status: 500, message: 'HTTP 500' });
  assert.equal(failed.keyless.until, 0, 'an unrelated failure must not fake a limit');
  assert.equal(failed.probes.lastStatus, 500);
});

test('keylessStatus walks unknown → limited → ok as the window passes', () => {
  const base = emptyState();
  assert.equal(keylessStatus(base, NOW).state, 'unknown');

  const limited = applyProbe(base, { at: NOW, status: 429, body: 'firecrawl retry_after_seconds: 120' });
  const view = keylessStatus(limited, NOW + 60000);
  assert.equal(view.state, 'limited');
  assert.equal(view.remainingMs, 60000);
  assert.equal(keylessStatus(limited, NOW + 130000).state, 'ok', 'the same window is open once it elapses');
});

test('summarize rolls days up into today / month / all-time', () => {
  let state = applyCall(emptyState(), { tool: 'web_fetch', at: NOW - 20 * 86400000, isError: false, text: '{}' });
  state = applyCall(state, { tool: 'web_search', at: NOW, isError: false, text: '{"creditsUsed":2}' });
  const view = summarize(state, NOW);
  assert.equal(view.today.calls, 1);
  assert.equal(view.monthCalls, 1, 'the older call is in a previous month');
  assert.equal(view.allTime.calls, 2);
  assert.equal(view.trackedDays, 2);
  assert.equal(view.lastCallAt, NOW);
  assert.equal(view.lastSuccessAt, NOW);
});

test('pruneDays and normalizeState keep old state files loadable', () => {
  const days = {
    [dayKey(NOW)]: { calls: 3, search: 3 },
    '2001-01-01': { calls: 99 },
  };
  assert.deepEqual(Object.keys(pruneDays(days, NOW)), [dayKey(NOW)]);

  const filled = normalizeState({ days: { [dayKey(NOW)]: { calls: 1 } } });
  assert.equal(filled.version, 1);
  assert.deepEqual(filled.keyless, emptyState().keyless);
  assert.deepEqual(filled.probes, emptyState().probes);
  assert.deepEqual(filled.days[dayKey(NOW)], { calls: 1 });
  assert.deepEqual(normalizeState(null), emptyState());
  assert.deepEqual(normalizeState('nonsense'), emptyState());
});

test('monthKey and dayKey are local-time strings', () => {
  assert.match(dayKey(NOW), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(monthKey(NOW), dayKey(NOW).slice(0, 7));
});

test('formatDuration matches the host label style', () => {
  assert.equal(formatDuration(45000), '45s');
  assert.equal(formatDuration(12 * 60000), '12m');
  assert.equal(formatDuration(60308000), '16h45m');
  assert.equal(formatDuration(2 * 86400000 + 3 * 3600000), '2d3h');
  assert.equal(formatDuration(0), '0s');
});

test('redactSecrets scrubs keys before any string leaves the host', () => {
  const scrubbed = redactSecrets('Authorization: Bearer fc-abcdef1234567890 and tvly-abcdef1234567890');
  assert.equal(scrubbed.includes('fc-abcdef1234567890'), false);
  assert.equal(scrubbed.includes('tvly-abcdef1234567890'), false);
  assert.match(scrubbed, /fc-\*\*\*/);
});

test('resultText flattens the shapes a tools/result payload can take', () => {
  assert.equal(resultText(null), '');
  assert.match(resultText({ error: { message: 'boom' } }), /boom/);
  assert.match(resultText({ value: { web: [{ title: 'hi' }] } }), /"title":"hi"/);
  assert.match(resultText({ content: 'plain text' }), /plain text/);
  const circular = {};
  circular.self = circular;
  assert.equal(resultText({ meta: circular }), '', 'a circular payload is skipped, not thrown');
});
