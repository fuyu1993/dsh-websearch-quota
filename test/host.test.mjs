/**
 * Integration tests for the host half (lib/index.js), driven through the same
 * surface DSH calls: a fake `ctx` that captures `tools/result` listeners and the
 * `webServer.register` call, plus a stubbed global `fetch` so no request ever
 * leaves the machine. Fixture paths are injected through the plugin config, so
 * the real `~/.dsh` and `~/.modsearch` are never touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../lib/index.js';

const HOME = mkdtempSync(join(tmpdir(), 'dsh-websearch-quota-test-'));

/** The exact body the live keyless endpoint returned for this machine. */
const OBSERVED_429 = '{"success":false,"error":"You\'ve hit Firecrawl\'s keyless free tier rate limit.'
  + ' To continue now, create a free API key at https://firecrawl.dev/k/tm6nwh8rg4ps",'
  + '"reason":"credits","retry_after_seconds":60308,"signup_url":"https://firecrawl.dev/k/tm6nwh8rg4ps"}';

// A stray key in the developer's shell must not leak into the "no keys" fixtures.
for (const key of ['FIRECRAWL_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY']) delete process.env[key];

let seq = 0;
const path = (name) => join(HOME, `${name}-${++seq}.json`);

/** A modsearch config fixture, with or without vendor keys. */
function modsearchFixture({ keys }) {
  const file = path(keys ? 'modsearch-keys' : 'modsearch-nokeys');
  writeFileSync(
    file,
    JSON.stringify(
      keys
        ? {
            engine: 'firecrawl',
            engines: {
              firecrawl: { apiKey: 'fc-testkey1234567890' },
              tavily: { apiKey: 'tvly-testkey1234567890' },
            },
          }
        : { engine: 'firecrawl' },
    ),
  );
  return file;
}

/** Boot the plugin against a fake host context. */
function boot({ config = {}, rejection = undefined, modsearchConfig = modsearchFixture({ keys: true }), modsearchState = join(HOME, 'absent-state.json') } = {}) {
  const listeners = new Map();
  const cleanups = [];
  let route = null;

  const ctx = {
    on(event, listener) {
      listeners.set(event, listener);
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return cleanup;
    },
    get(key) {
      if (key === 'connection') return { requestRejection: () => rejection };
      return undefined;
    },
    webServer: {
      port: 56123,
      register(definition) {
        route = definition;
        return () => {
          route = null;
        };
      },
    },
  };

  const stateFile = config.stateFile ?? path('state');
  apply(ctx, {
    keyQuotaTtlMs: 60000,
    modsearchConfigPath: modsearchConfig,
    modsearchStatePath: modsearchState,
    ...config,
    stateFile,
  });

  return {
    ctx,
    listeners,
    cleanups,
    stateFile,
    get route() {
      return route;
    },
    /** The plugin's unload effect: persist whatever the listeners accumulated. */
    flush: () => cleanups.at(-1)?.(),
  };
}

/** Drive the registered route with a request/response pair. */
async function call(route, { url = '/websearch-quota', method = 'GET', headers = {} } = {}) {
  const res = {
    status: 0,
    headersSent: false,
    body: '',
    destroyed: false,
    writeHead(status) {
      this.status = status;
      this.headersSent = true;
    },
    end(body) {
      this.body = body ?? '';
    },
    destroy() {
      this.destroyed = true;
    },
  };
  await route.handler({ url, method, headers }, res);
  return { status: res.status, body: res.body, destroyed: res.destroyed, json: () => JSON.parse(res.body) };
}

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const fetchLog = [];
function stubFetch(routes) {
  fetchLog.length = 0;
  globalThis.fetch = async (url) => {
    const href = String(url);
    fetchLog.push(href);
    for (const [fragment, make] of routes) {
      if (href.includes(fragment)) return make();
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
}

const VENDOR_OK = [
  ['credit-usage', () => response({ data: { remainingCredits: 42, planCredits: 500, billingPeriodEnd: '2026-11-01T00:00:00.000Z' } })],
  ['tavily.com/usage', () => response({ key: { usage: 7, limit: 1000 }, account: { current_plan: 'free' } })],
  ['api.firecrawl.dev/v2/search', () => response({ success: true, data: { web: [{}], creditsUsed: 2 } })],
];

test('apply() registers one prefix route and one unload effect', () => {
  const app = boot();
  assert.equal(app.route.kind, 'prefix');
  assert.equal(app.route.path, '/websearch-quota');
  assert.equal(typeof app.route.handler, 'function');
  assert.equal(app.listeners.has('tools/result'), true);
  assert.equal(app.cleanups.length, 2, 'route dispose + unload flush');
});

test('a fresh install reports an unknown keyless budget and an empty ledger', async () => {
  const app = boot({ modsearchConfig: modsearchFixture({ keys: false }) });
  stubFetch(VENDOR_OK);
  const snapshot = (await call(app.route)).json();

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.keyless.state, 'unknown');
  assert.equal(snapshot.keyless.evidence, null);
  assert.equal(snapshot.ledger.today.calls, 0);
  assert.equal(snapshot.ledger.monthCalls, 0);
  assert.equal(snapshot.ledger.dailyBudget, null);
  assert.equal(snapshot.paths.stateFile, app.stateFile);

  const firecrawl = snapshot.engines.find((engine) => engine.id === 'firecrawl');
  assert.equal(firecrawl.kind, 'keyless');
  assert.equal(firecrawl.status, 'unknown');
  assert.equal(firecrawl.remaining, null);
  assert.match(firecrawl.note, /未公开/);

  const exa = snapshot.engines.find((engine) => engine.id === 'exa');
  assert.equal(exa.status, 'missing-key');
  assert.equal(snapshot.modsearch.keysConfigured.length, 0);
  assert.equal(fetchLog.length, 0, 'no key, no vendor request');
});

test('keyed engines report real balances, cached until a refresh is asked for', async () => {
  const app = boot();
  stubFetch(VENDOR_OK);

  const first = (await call(app.route)).json();
  const firecrawl = first.engines.find((engine) => engine.id === 'firecrawl');
  assert.equal(firecrawl.kind, 'key');
  assert.equal(firecrawl.remaining, 42);
  assert.equal(firecrawl.limit, 500);
  assert.equal(firecrawl.periodEnd, '11-01');
  assert.match(firecrawl.detail, /剩余 42 \/ 500 credits/);

  const tavily = first.engines.find((engine) => engine.id === 'tavily');
  assert.equal(tavily.remaining, 993);
  assert.equal(tavily.limit, 1000);
  assert.equal(tavily.plan, 'free');
  assert.equal(fetchLog.length, 2);
  assert.equal(first.modsearch.engine, 'firecrawl');
  assert.deepEqual(first.modsearch.keysConfigured.sort(), ['firecrawl', 'tavily']);

  await call(app.route);
  assert.equal(fetchLog.length, 2, 'a poll inside the TTL must not re-query the vendors');

  await call(app.route, { url: '/websearch-quota?refresh=1' });
  assert.equal(fetchLog.length, 4, 'refresh=1 forces a fresh balance');
});

test('observed tool results feed the ledger and pin the limit window', async () => {
  const app = boot({ modsearchConfig: modsearchFixture({ keys: false }) });
  stubFetch(VENDOR_OK);
  const onResult = app.listeners.get('tools/result');

  onResult({ name: 'web_search' }, { isError: true, error: { message: OBSERVED_429 } });
  onResult({ name: 'bash' }, { isError: false, value: 'ls -la' });

  const limited = (await call(app.route)).json();
  assert.equal(limited.keyless.state, 'limited');
  assert.equal(limited.keyless.exact, true);
  assert.equal(limited.keyless.source, 'tool-result');
  assert.ok(Math.abs(limited.keyless.remainingMs - 60308000) < 5000, `remainingMs=${limited.keyless.remainingMs}`);
  assert.match(limited.keyless.evidence, /rate limit/);
  assert.equal(limited.ledger.today.calls, 1, 'bash is not a web call');
  assert.equal(limited.ledger.today.search, 1);
  assert.equal(limited.ledger.today.errors, 1);

  onResult({ name: 'web_search' }, { isError: false, value: { web: [{ title: 'x' }], meta: { usage: { creditsUsed: 2 } } } });
  const after = (await call(app.route)).json();
  assert.equal(after.ledger.today.calls, 2);
  assert.equal(after.ledger.today.credits, 2);
  assert.equal(after.ledger.lastSuccessAt > 0, true);

  // The unload effect must have written the ledger to disk.
  app.flush();
  assert.equal(existsSync(app.stateFile), true);
  const onDisk = JSON.parse(readFileSync(app.stateFile, 'utf-8'));
  const today = Object.values(onDisk.days)[0];
  assert.equal(today.calls, 2);
  assert.equal(onDisk.keyless.until > Date.now(), true);
});

test('the probe reports the real window and only 429/200 change the state', async () => {
  const app = boot({ config: { probeMinIntervalMs: 0 }, modsearchConfig: modsearchFixture({ keys: false }) });

  stubFetch([['api.firecrawl.dev/v2/search', () => response(OBSERVED_429, 429)]]);
  const limited = (await call(app.route, { url: '/websearch-quota/probe', method: 'POST' })).json();
  assert.equal(limited.ok, false);
  assert.equal(limited.status, 429);
  assert.ok(Math.abs(limited.limitedUntil - Date.now() - 60308000) < 5000);
  assert.match(limited.message, /限流/);
  assert.equal(limited.snapshot.keyless.state, 'limited');
  assert.equal(limited.snapshot.keyless.source, 'probe');

  const wrongMethod = await call(app.route, { url: '/websearch-quota/probe' });
  assert.equal(wrongMethod.status, 405);

  stubFetch([['api.firecrawl.dev/v2/search', () => response({ success: true, data: { creditsUsed: 2 } })]]);
  const open = (await call(app.route, { url: '/websearch-quota/probe', method: 'POST' })).json();
  assert.equal(open.ok, true);
  assert.equal(open.creditsUsed, 2);
  assert.match(open.message, /可用/);
  assert.equal(open.snapshot.keyless.state, 'ok');
});

test('the probe is rate limited and can be switched off', async () => {
  const app = boot({ modsearchConfig: modsearchFixture({ keys: false }) });
  stubFetch([['api.firecrawl.dev/v2/search', () => response({ success: true })]]);
  await call(app.route, { url: '/websearch-quota/probe', method: 'POST' });
  const second = (await call(app.route, { url: '/websearch-quota/probe', method: 'POST' })).json();
  assert.equal(second.error, 'rate-limited');
  assert.match(second.message, /太频繁/);

  const off = boot({ config: { probeEnabled: false }, modsearchConfig: modsearchFixture({ keys: false }) });
  const refused = await call(off.route, { url: '/websearch-quota/probe', method: 'POST' });
  assert.equal(refused.status, 403);
  assert.equal(refused.json().error, 'probe-disabled');
  assert.equal((await call(off.route)).json().keyless.probe.enabled, false);
});

test('routing answers health, rejects unknown actions and honours the loopback check', async () => {
  const app = boot({ modsearchConfig: modsearchFixture({ keys: false }) });
  stubFetch(VENDOR_OK);

  const health = await call(app.route, { url: '/websearch-quota/health' });
  assert.equal(health.status, 200);
  assert.equal(health.json().ok, true);

  const unknown = await call(app.route, { url: '/websearch-quota/nope' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json().error, 'unknown-action');

  const denied = boot({ rejection: 403, modsearchConfig: modsearchFixture({ keys: false }) });
  const blocked = await call(denied.route);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json().error, 'unauthorized');
});

test('modsearch own cooldown book-keeping is surfaced as a hint', async () => {
  const statePath = path('modsearch-state');
  const until = Date.now() + 3600000;
  writeFileSync(
    statePath,
    JSON.stringify({ engineCooldowns: { 'firecrawl::key:1': { until, reason: 'quota exhausted for fc-abcdef1234567890' }, tavily: { until: 0, reason: 'stale' } } }),
  );
  const app = boot({ modsearchConfig: modsearchFixture({ keys: false }), modsearchState: statePath });
  stubFetch(VENDOR_OK);

  const snapshot = (await call(app.route)).json();
  const entry = snapshot.modsearch.cooldowns.find((row) => row.engine === 'firecrawl');
  assert.equal(entry.active, true);
  assert.equal(entry.until, until);
  assert.equal(entry.reason.includes('fc-abcdef1234567890'), false, 'keys are scrubbed from the reason');
  assert.equal(snapshot.modsearch.cooldowns.find((row) => row.engine === 'tavily').active, false);
  assert.equal(snapshot.modsearch.stateFound, true);
});

test('a missing modsearch config degrades to the keyless view', async () => {
  const app = boot({ modsearchConfig: join(HOME, 'does-not-exist.json') });
  stubFetch(VENDOR_OK);
  const snapshot = (await call(app.route)).json();
  assert.equal(snapshot.modsearch.configFound, false);
  assert.equal(snapshot.engines.find((engine) => engine.id === 'firecrawl').kind, 'keyless');
  assert.equal(snapshot.modsearch.keysConfigured.length, 0);
});

test('a self-set daily budget turns the ledger into remaining calls', async () => {
  const app = boot({ config: { dailyBudget: 3 }, modsearchConfig: modsearchFixture({ keys: false }) });
  stubFetch(VENDOR_OK);
  app.listeners.get('tools/result')({ name: 'web_search' }, { isError: false, value: 'ok' });
  const snapshot = (await call(app.route)).json();
  assert.equal(snapshot.ledger.dailyBudget, 3);
  assert.equal(snapshot.ledger.remainingToday, 2);
});
