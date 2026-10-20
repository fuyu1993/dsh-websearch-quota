/**
 * dsh-websearch-quota — host half.
 *
 * Answers one question for the composer badge: *how much free web search does
 * this machine still have?* The answer has three independent parts, because
 * the local modsearch stack has three kinds of budget:
 *
 *   1. **keyless Firecrawl** (the default: no key, no signup). Firecrawl
 *      publishes no remaining count — the only hard evidence is a `429` whose
 *      body carries `retry_after_seconds`. So we watch `tools/result` for that
 *      message and remember the exact window; everything we show about it is
 *      either observed or explicitly labelled as an estimate.
 *   2. **keyed Firecrawl / Tavily** — real numbers, queried server-side from
 *      `/v2/team/credit-usage` and `/usage`. Keys are read from modsearch's own
 *      config (or the env vars it also honours) and never leave this process.
 *   3. **local ledger** — how many web calls this machine made today/this
 *      month, counted from observed tool results. It is our own bookkeeping,
 *      not a vendor figure, and the panel labels it that way.
 *
 * Nothing here writes to modsearch; the plugin is a read-only observer plus one
 * optional probe the user triggers by hand.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  applyCall,
  applyProbe,
  bucketOf,
  emptyState,
  formatClock,
  formatDuration,
  keylessStatus,
  normalizeState,
  parseCreditsUsed,
  redactSecrets,
  resultText,
  summarize,
  WEB_TOOL_BUCKETS,
} from './quota.js';

export const name = 'dsh-websearch-quota';

/** `webServer` is a hard dependency: the panel is fed over HTTP. */
export const inject = ['webServer'];

const VERSION = '0.1.0';

/**
 * Route prefix — deliberately WITHOUT a trailing slash: the framework matches a
 * prefix route only for the exact prefix or `prefix + '/'` paths.
 */
const ROUTE_PREFIX = '/websearch-quota';

const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME
  : join(homedir(), '.dsh');
const STATE_DIR = join(DSH_HOME, 'websearch-quota');
const STATE_FILE = join(STATE_DIR, 'state.json');

const MODSEARCH_DIR = join(homedir(), '.modsearch');
const MODSEARCH_CONFIG = join(MODSEARCH_DIR, 'config.json');
const MODSEARCH_STATE = join(MODSEARCH_DIR, 'state.json');

const KEY_QUOTA_TTL_MS = 5 * 60 * 1000;
const PROBE_MIN_INTERVAL_MS = 30 * 1000;
const HTTP_TIMEOUT_MS = 10 * 1000;
const WRITE_DEBOUNCE_MS = 1500;

const FIRECRAWL_CREDIT_USAGE = 'https://api.firecrawl.dev/v2/team/credit-usage';
const FIRECRAWL_SEARCH = 'https://api.firecrawl.dev/v2/search';
const TAVILY_USAGE = 'https://api.tavily.com/usage';

const ENGINE_IDS = ['firecrawl', 'tavily', 'exa'];
const ENV_KEYS = { firecrawl: 'FIRECRAWL_API_KEY', tavily: 'TAVILY_API_KEY', exa: 'EXA_API_KEY' };

const DIAG = `${tmpdir()}/dsh-websearch-quota.log`;
const diag = (event, data = {}) => {
  try {
    appendFileSync(DIAG, `${new Date().toISOString()} ${event} ${JSON.stringify(data)}\n`);
  } catch {
    /* diagnostics never break the plugin */
  }
};

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

const asNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** A non-empty string, else `null`. */
const str = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/** Read a JSON file, returning `null` for missing/unreadable/malformed files. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * What modsearch itself is configured with: the pinned engine, per-engine keys
 * (first of the comma-separated list), and its own cooldown book-keeping — the
 * last one is a *hint only*, since modsearch falls back to a 45-minute window
 * when a message carries no reset time.
 */
function readModsearch(paths) {
  const config = readJson(paths.modsearchConfig);
  const keys = {};
  for (const engine of ENGINE_IDS) {
    const fromFile = config?.engines?.[engine]?.apiKey;
    const raw = typeof fromFile === 'string' && fromFile.trim() !== ''
      ? fromFile
      : process.env[ENV_KEYS[engine]] ?? '';
    const first = String(raw).split(',')[0].trim();
    if (first) keys[engine] = first;
  }
  const state = readJson(paths.modsearchState);
  const cooldowns = [];
  const rawCooldowns = state?.engineCooldowns;
  if (rawCooldowns && typeof rawCooldowns === 'object') {
    for (const [engine, entry] of Object.entries(rawCooldowns)) {
      const until = asNumber(entry?.until);
      if (until === null) continue;
      cooldowns.push({
        engine: engine.split('::')[0],
        until,
        active: until > Date.now(),
        reason: typeof entry?.reason === 'string' ? redactSecrets(entry.reason).slice(0, 200) : null,
      });
    }
  }
  return {
    configPath: paths.modsearchConfig,
    configFound: config !== null,
    engine: typeof config?.engine === 'string' ? config.engine : null,
    keylessFetch: config?.engines?.firecrawl?.keylessFetch !== false,
    keys,
    stateFound: state !== null,
    cooldowns,
  };
}

/** Is the local `agy` fallback engine on PATH? */
function findOnPath(binary) {
  const path = process.env.PATH ?? '';
  for (const dir of path.split(':')) {
    if (!dir) continue;
    try {
      if (existsSync(join(dir, binary))) return join(dir, binary);
    } catch {
      /* unreadable PATH entry */
    }
  }
  return null;
}

/** `fetch` with a hard timeout and a text body; never throws. */
async function requestText(url, options = {}) {
  try {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } catch (error) {
    return { ok: false, status: 0, text: '', error: String(error?.message ?? error) };
  }
}

async function fetchFirecrawlUsage(apiKey) {
  const response = await requestText(FIRECRAWL_CREDIT_USAGE, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (response.status === 0) return { error: `请求失败：${response.error}` };
  if (!response.ok) return { error: `HTTP ${response.status}` };
  let json;
  try {
    json = JSON.parse(response.text);
  } catch {
    return { error: '响应不是 JSON' };
  }
  const data = json?.data ?? json;
  const remaining = asNumber(data?.remainingCredits ?? data?.remaining_credits);
  const limit = asNumber(data?.planCredits ?? data?.plan_credits);
  return {
    remaining,
    limit,
    periodStart: data?.billingPeriodStart ?? null,
    periodEnd: data?.billingPeriodEnd ?? null,
  };
}

async function fetchTavilyUsage(apiKey) {
  const response = await requestText(TAVILY_USAGE, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (response.status === 0) return { error: `请求失败：${response.error}` };
  if (!response.ok) return { error: `HTTP ${response.status}` };
  let json;
  try {
    json = JSON.parse(response.text);
  } catch {
    return { error: '响应不是 JSON' };
  }
  const key = json?.key ?? {};
  const account = json?.account ?? {};
  const used = asNumber(key.usage) ?? asNumber(account.plan_usage);
  const limit = asNumber(key.limit) ?? asNumber(account.plan_limit);
  return {
    remaining: limit !== null && used !== null ? Math.max(0, limit - used) : null,
    limit,
    used,
    plan: typeof account.current_plan === 'string' ? account.current_plan : null,
  };
}

/** Wrap an ISO date (or epoch ms) as a short local `MM-DD` label. */
function shortDate(value) {
  if (value === null || value === undefined) return null;
  const ts = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(ts)) return null;
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function apply(ctx, config = {}) {
  const settings = {
    keyQuotaTtlMs: asNumber(config.keyQuotaTtlMs) ?? KEY_QUOTA_TTL_MS,
    probeMinIntervalMs: asNumber(config.probeMinIntervalMs) ?? PROBE_MIN_INTERVAL_MS,
    dailyBudget: asNumber(config.dailyBudget),
    trackTools: Array.isArray(config.trackTools) && config.trackTools.length > 0
      ? new Set(config.trackTools)
      : new Set(Object.keys(WEB_TOOL_BUCKETS)),
    probeEnabled: config.probeEnabled !== false,
    // Paths are overridable so a test (or a second DSH home) can run hermetically.
    stateFile: str(config.stateFile) ?? STATE_FILE,
    modsearchConfig: str(config.modsearchConfigPath) ?? MODSEARCH_CONFIG,
    modsearchState: str(config.modsearchStatePath) ?? MODSEARCH_STATE,
  };
  settings.stateDir = dirname(settings.stateFile);

  let state = normalizeState(readJson(settings.stateFile) ?? emptyState());
  let writeTimer = null;
  let quotaCache = { at: 0, data: null };
  let probeRunning = false;
  let lastProbeAt = 0;

  const persistNow = () => {
    try {
      mkdirSync(settings.stateDir, { recursive: true });
      const tmp = `${settings.stateFile}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
      renameSync(tmp, settings.stateFile);
    } catch (error) {
      diag('state-write-failed', { message: String(error?.message ?? error) });
    }
  };
  const schedulePersist = () => {
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      persistNow();
    }, WRITE_DEBOUNCE_MS);
    writeTimer.unref?.();
  };

  // ── observation: every web tool call feeds the ledger and the limit watch ──
  const onToolResult = (exec, result) => {
    try {
      const tool = typeof exec?.name === 'string' ? exec.name : null;
      if (!tool || !bucketOf(tool) || !settings.trackTools.has(tool)) return;
      const text = resultText(result);
      const isError = result?.isError === true;
      const before = state.keyless?.until ?? 0;
      state = applyCall(state, { tool, at: Date.now(), isError, text });
      schedulePersist();
      const after = state.keyless?.until ?? 0;
      if (after !== before && after > Date.now()) {
        diag('keyless-limit-observed', { tool, until: state.keyless?.until, exact: state.keyless?.exact });
      }
    } catch (error) {
      diag('tool-result-failed', { message: String(error?.message ?? error) });
    }
  };

  ctx.on('tools/result', onToolResult);

  // ── keyed quotas (cached: the panel polls, vendors should not be) ─────────
  const keyedQuotas = async (force) => {
    const now = Date.now();
    if (!force && quotaCache.data && now - quotaCache.at < settings.keyQuotaTtlMs) {
      return quotaCache.data;
    }
    const modsearch = readModsearch(settings);
    const result = {};
    const jobs = [];
    if (modsearch.keys.firecrawl) {
      jobs.push(fetchFirecrawlUsage(modsearch.keys.firecrawl).then((value) => { result.firecrawl = value; }));
    }
    if (modsearch.keys.tavily) {
      jobs.push(fetchTavilyUsage(modsearch.keys.tavily).then((value) => { result.tavily = value; }));
    }
    await Promise.all(jobs);
    quotaCache = { at: now, data: { at: now, engines: result } };
    return quotaCache.data;
  };

  // ── the optional probe: the one action that can spend a free search ───────
  const runProbe = async ({ force = false } = {}) => {
    const now = Date.now();
    if (probeRunning) return { ok: false, error: 'busy', message: '探测正在进行' };
    if (!force && now - lastProbeAt < settings.probeMinIntervalMs) {
      return {
        ok: false,
        error: 'rate-limited',
        message: `探测太频繁，请等 ${formatDuration(settings.probeMinIntervalMs - (now - lastProbeAt))}`,
        retryInMs: settings.probeMinIntervalMs - (now - lastProbeAt),
      };
    }
    probeRunning = true;
    lastProbeAt = now;
    try {
      const response = await requestText(FIRECRAWL_SEARCH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'modsearch quota probe', limit: 1, sources: ['web'] }),
      });
      const status = response.status;
      state = applyProbe(state, { at: Date.now(), status, body: response.text, message: response.error });
      persistNow();
      const credits = parseCreditsUsed(response.text);
      const limited = status === 429;
      return {
        ok: status === 200,
        status,
        creditsUsed: credits,
        limitedUntil: limited ? state.keyless.until : null,
        message: status === 200
          ? `keyless 可用（本次探测消耗 ${credits ?? '1'} credit）`
          : limited
            ? `keyless 仍在限流：${formatDuration(state.keyless.until - Date.now())} 后恢复`
            : `探测返回 HTTP ${status}${response.error ? `（${response.error}）` : ''}`,
        snapshot: await snapshot({ force: true }),
      };
    } finally {
      probeRunning = false;
    }
  };

  // ── the snapshot the panel renders ───────────────────────────────────────
  const snapshot = async ({ force = false } = {}) => {
    const now = Date.now();
    const modsearch = readModsearch(settings);
    const keyless = keylessStatus(state, now);
    const ledger = summarize(state, now);
    const keyed = await keyedQuotas(force);
    const engines = [];

    const firecrawlKeyed = keyed.engines.firecrawl;
    if (modsearch.keys.firecrawl) {
      engines.push({
        id: 'firecrawl',
        name: 'Firecrawl',
        kind: 'key',
        role: '已配置 API key',
        status: firecrawlKeyed?.error ? 'error' : 'ok',
        remaining: firecrawlKeyed?.remaining ?? null,
        limit: firecrawlKeyed?.limit ?? null,
        plan: null,
        periodEnd: shortDate(firecrawlKeyed?.periodEnd),
        detail: firecrawlKeyed?.error
          ? `额度查询失败：${firecrawlKeyed.error}`
          : firecrawlKeyed?.remaining !== null && firecrawlKeyed?.limit !== null
            ? `剩余 ${firecrawlKeyed.remaining} / ${firecrawlKeyed.limit} credits`
            : '额度查询未返回数字',
        note: `keyless 兜底：${keylessLabel(keyless)}`,
      });
    } else {
      engines.push({
        id: 'firecrawl',
        name: 'Firecrawl',
        kind: 'keyless',
        role: '默认搜索引擎（免注册）',
        status: keyless.state === 'limited' ? 'limited' : keyless.state === 'ok' ? 'ok' : 'unknown',
        remaining: null,
        limit: null,
        plan: null,
        periodEnd: null,
        detail: keyless.state === 'limited'
          ? `${keyless.exact ? '' : '约 '}${formatDuration(keyless.remainingMs)} 后恢复（${formatClock(keyless.until)}）`
          : keyless.state === 'ok'
            ? '上次观测为可用'
            : '尚未观测到限流',
        note: '官方未公开 keyless 每日剩余额度；search ≈ 2 credits / 10 条，scrape 1 credit',
      });
    }

    const tavilyKeyed = keyed.engines.tavily;
    if (modsearch.keys.tavily) {
      engines.push({
        id: 'tavily',
        name: 'Tavily',
        kind: 'key',
        role: '已配置 API key',
        status: tavilyKeyed?.error ? 'error' : 'ok',
        remaining: tavilyKeyed?.remaining ?? null,
        limit: tavilyKeyed?.limit ?? null,
        plan: tavilyKeyed?.plan ?? null,
        periodEnd: null,
        detail: tavilyKeyed?.error
          ? `额度查询失败：${tavilyKeyed.error}`
          : tavilyKeyed?.remaining !== null
            ? `剩余 ${tavilyKeyed.remaining}${tavilyKeyed.limit !== null ? ` / ${tavilyKeyed.limit}` : ''} credits${tavilyKeyed.plan ? `（${tavilyKeyed.plan}）` : ''}`
            : '额度查询未返回数字',
        note: '免费档 1,000 credits/月（官方页面为准）',
      });
    } else {
      engines.push({
        id: 'tavily',
        name: 'Tavily',
        kind: 'keyless',
        role: '免注册兜底',
        status: 'ok',
        remaining: null,
        limit: null,
        plan: null,
        periodEnd: null,
        detail: '免 key 可用（每次调用返回本次 credits 消耗）',
        note: '官方不公开剩余次数；配 key 后可查真实余额',
      });
    }

    engines.push({
      id: 'exa',
      name: 'Exa',
      kind: modsearch.keys.exa ? 'key' : 'keyless',
      role: modsearch.keys.exa ? '已配置 API key' : '未配置',
      status: modsearch.keys.exa ? 'ok' : 'missing-key',
      remaining: null,
      limit: null,
      plan: null,
      periodEnd: null,
      detail: modsearch.keys.exa ? '已配置 key（Exa 无额度查询接口）' : '需要 API key 才能使用',
      note: '免费额度 $10/月，但官方不提供余额查询接口',
    });

    const agyPath = findOnPath('agy');
    engines.push({
      id: 'agy',
      name: 'Antigravity CLI',
      kind: 'local',
      role: '本机 CLI 兜底',
      status: agyPath ? 'ok' : 'missing',
      remaining: null,
      limit: null,
      plan: null,
      periodEnd: null,
      detail: agyPath ? `已安装：${agyPath}` : '未安装',
      note: '本地引擎，不消耗云端免费额度',
    });

    const budget = settings.dailyBudget;
    return {
      ok: true,
      version: VERSION,
      now,
      route: ROUTE_PREFIX,
      ledger: {
        ...ledger,
        dailyBudget: budget,
        remainingToday: budget !== null ? Math.max(0, budget - ledger.today.calls) : null,
      },
      keyless: {
        ...keyless,
        evidence: keyless.evidence ? redactSecrets(keyless.evidence) : null,
        probe: {
          enabled: settings.probeEnabled,
          running: probeRunning,
          lastAt: state.probes?.at ?? null,
          lastStatus: state.probes?.lastStatus ?? null,
          lastMessage: state.probes?.lastMessage ?? null,
          allowedInMs: Math.max(0, settings.probeMinIntervalMs - (Date.now() - lastProbeAt)),
        },
      },
      engines,
      modsearch: {
        configFound: modsearch.configFound,
        configPath: modsearch.configPath,
        engine: modsearch.engine,
        keylessFetch: modsearch.keylessFetch,
        keysConfigured: Object.keys(modsearch.keys),
        stateFound: modsearch.stateFound,
        cooldowns: modsearch.cooldowns,
      },
      config: {
        dailyBudget: budget,
        trackTools: [...settings.trackTools],
        keyQuotaTtlMs: settings.keyQuotaTtlMs,
      },
      paths: { stateFile: settings.stateFile, modsearchConfig: settings.modsearchConfig, diagnostics: DIAG },
      sources: [
        '本机记账：观测到的 web 工具调用（tools/result），跨会话累计',
        '限流窗口：Firecrawl 429 body 的 retry_after_seconds，或手动探测结果',
        '真实余额：Firecrawl /v2/team/credit-usage 与 Tavily /usage（需 API key）',
      ],
    };
  };

  const keylessLabel = (keyless) => {
    if (keyless.state === 'limited') return `限流中 ${formatDuration(keyless.remainingMs)}`;
    if (keyless.state === 'ok') return '可用';
    return '未观测';
  };

  // ── HTTP: the panel polls this, the probe button posts to it ──────────────
  const handle = async (req, res) => {
    try {
      const rejection = ctx.get('connection')?.requestRejection?.({ headers: req.headers });
      if (rejection) {
        sendJson(res, rejection, { ok: false, error: 'unauthorized' });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const action = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+|\/+$/g, '');
      const force = url.searchParams.get('refresh') === '1';

      if (action === '' || action === 'health') {
        sendJson(res, 200, await snapshot({ force }));
        return;
      }
      if (action === 'probe') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method-not-allowed', message: '探测请用 POST' });
          return;
        }
        if (!settings.probeEnabled) {
          sendJson(res, 403, { ok: false, error: 'probe-disabled', message: '配置里已关闭探测（probeEnabled: false）' });
          return;
        }
        sendJson(res, 200, await runProbe({ force }));
        return;
      }
      sendJson(res, 404, { ok: false, error: 'unknown-action', message: `未知的 ${ROUTE_PREFIX} 动作：${action}` });
    } catch (error) {
      diag('route-failed', { message: String(error?.message ?? error) });
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: 'internal', message: String(error?.message ?? error) });
      } else {
        res.destroy();
      }
    }
  };

  ctx.effect(
    () => {
      const dispose = ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handle });
      diag('route-registered', { path: ROUTE_PREFIX, stateFile: settings.stateFile });
      return dispose;
    },
    'dsh-websearch-quota: http route',
  );

  // Persist whatever the listener accumulated when the plugin unloads.
  ctx.effect(() => () => {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    persistNow();
  }, 'dsh-websearch-quota: flush ledger');

  ctx.logger?.debug?.('dsh-websearch-quota: ready (%s)', ROUTE_PREFIX);
}
