/**
 * dsh-websearch-quota — client-half smoke test.
 *
 * The browser half is a module-loader bundle, so this harness supplies the
 * minimum browser surface it touches (`window.__ModuleLoader__`, `fetch`,
 * `document`, timers) plus a tiny React with a real hook store and a component
 * expander. That is enough to assert the loader contract, the slot
 * registration, every chip state (unknown / limited / keyed balance / error)
 * and the panel the chip opens, including the probe round-trip.
 *
 *   node test/client.test.mjs
 */
import { readFile } from 'node:fs/promises';

let failures = 0;
let checks = 0;

function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
}

function same(label, actual, expected) {
  check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Flatten every rendered text node. */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (node.props) return textOf(node.props.children);
  return '';
}

/** Depth-first search over the expanded tree. */
function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (!Array.isArray(node)) {
    if (typeof node.type === 'function') return null;
    if (predicate(node)) return node;
  }
  const children = Array.isArray(node) ? node : Array.isArray(node.props?.children) ? node.props.children : [node.props?.children];
  for (const child of children) {
    const hit = find(child, predicate);
    if (hit) return hit;
  }
  return null;
}

// ── browser surface ────────────────────────────────────────────────────────
const SNAPSHOT_LIMITED = {
  ok: true,
  version: '0.1.0',
  keyless: {
    state: 'limited',
    until: Date.now() + 60308000,
    remainingMs: 60308000,
    exact: true,
    evidence: "You've hit Firecrawl's keyless free tier rate limit. ... retry_after_seconds: 60308",
    source: 'tool-result',
    probe: { enabled: true, running: false, lastAt: null, lastStatus: null, lastMessage: null, allowedInMs: 0 },
  },
  ledger: { today: { day: '2026-10-13', calls: 3, search: 2, fetch: 1, x: 0, errors: 1, credits: 2 }, monthCalls: 17, allTime: { calls: 17 }, trackedDays: 4, lastCallAt: Date.now(), lastSuccessAt: Date.now(), dailyBudget: 50, remainingToday: 47 },
  engines: [
    { id: 'firecrawl', name: 'Firecrawl', kind: 'keyless', role: '默认搜索引擎（免注册）', status: 'limited', remaining: null, limit: null, plan: null, periodEnd: null, detail: '16h45m 后恢复（09:15）', note: '官方未公开 keyless 每日剩余额度' },
    { id: 'tavily', name: 'Tavily', kind: 'keyless', role: '免注册兜底', status: 'ok', remaining: null, limit: null, plan: null, periodEnd: null, detail: '免 key 可用（每次调用返回本次 credits 消耗）', note: '官方不公开剩余次数；配 key 后可查真实余额' },
    { id: 'exa', name: 'Exa', kind: 'keyless', role: '未配置', status: 'missing-key', remaining: null, limit: null, plan: null, periodEnd: null, detail: '需要 API key 才能使用', note: '免费额度 $10/月，但官方不提供余额查询接口' },
  ],
  modsearch: { configFound: true, configPath: '/Users/test/.modsearch/config.json', engine: 'firecrawl', keylessFetch: true, keysConfigured: [], stateFound: false, cooldowns: [] },
  paths: { stateFile: '/Users/test/.dsh/websearch-quota/state.json', diagnostics: '/tmp/dsh-websearch-quota.log' },
  sources: ['本机记账：观测到的 web 工具调用', '限流窗口：Firecrawl 429 body 的 retry_after_seconds'],
};

const SNAPSHOT_KEYED = {
  ...SNAPSHOT_LIMITED,
  keyless: { ...SNAPSHOT_LIMITED.keyless, state: 'ok', remainingMs: 0, until: 0, source: 'probe', evidence: 'probe: search succeeded' },
  engines: [
    { id: 'firecrawl', name: 'Firecrawl', kind: 'key', role: '已配置 API key', status: 'ok', remaining: 42, limit: 500, plan: null, periodEnd: '11-01', detail: '剩余 42 / 500 credits', note: 'keyless 兜底：可用' },
    { id: 'tavily', name: 'Tavily', kind: 'key', role: '已配置 API key', status: 'ok', remaining: 993, limit: 1000, plan: 'free', periodEnd: null, detail: '剩余 993 / 1000 credits（free）', note: '免费档 1,000 credits/月（官方页面为准）' },
  ],
  modsearch: { ...SNAPSHOT_LIMITED.modsearch, keysConfigured: ['firecrawl', 'tavily'] },
};

const seen = { urls: [], methods: [] };
let snapshotBody = SNAPSHOT_LIMITED;
let snapshotStatus = 200;
let probeBody = { ok: false, status: 429, creditsUsed: null, limitedUntil: Date.now() + 60308000, message: 'keyless 仍在限流：16h45m 后恢复' };

globalThis.fetch = async (url, options = {}) => {
  const href = String(url);
  seen.urls.push(href);
  seen.methods.push(options.method ?? 'GET');
  if (href.startsWith('/websearch-quota/probe')) {
    return { ok: true, status: 200, json: async () => probeBody };
  }
  return {
    ok: snapshotStatus === 200,
    status: snapshotStatus,
    json: async () => {
      if (snapshotStatus !== 200) throw new Error('not json');
      return snapshotBody;
    },
  };
};

const timers = { intervals: [] };
globalThis.setInterval = (fn, ms) => {
  timers.intervals.push(ms);
  return { unref() {} };
};
globalThis.clearInterval = () => {};
globalThis.setTimeout = globalThis.setTimeout.bind(globalThis);

const documentListeners = new Map();
globalThis.document = {
  visibilityState: 'visible',
  body: { tag: 'body' },
  addEventListener(type, listener) {
    documentListeners.set(type, listener);
  },
  removeEventListener(type) {
    documentListeners.delete(type);
  },
};

let registered;
const windowListeners = new Map();
globalThis.window = {
  innerWidth: 1440,
  innerHeight: 900,
  addEventListener(type, listener) {
    windowListeners.set(type, listener);
  },
  removeEventListener(type) {
    windowListeners.delete(type);
  },
  __ModuleLoader__: {
    load(entry) {
      registered = entry;
    },
  },
};

await import('../lib/client.js');

// ── tiny React with a real hook store ──────────────────────────────────────
const effectQueue = [];
const hooks = { slots: [], cursor: 0 };
let render = () => {};

const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } };
  },
  useState(initial) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? initial() : initial;
    const set = (value) => {
      hooks.slots[index] = typeof value === 'function' ? value(hooks.slots[index]) : value;
      render();
    };
    return [hooks.slots[index], set];
  },
  useRef(initial) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index];
  },
  useCallback(fn) {
    return fn;
  },
  useEffect(fn) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) {
      hooks.slots[index] = true;
      effectQueue.push(fn);
    }
  },
};

const requireStub = (id) => {
  if (id === 'react') return React;
  if (id === 'react-dom') return { createPortal: (element) => element };
  throw new Error(`unexpected require("${id}")`);
};

const pause = (ms = 8) => new Promise((resolve) => setTimeout(resolve, ms));

/** Expand function components the way a renderer would. */
function expand(node) {
  if (Array.isArray(node)) return node.map(expand);
  if (!node || typeof node !== 'object') return node;
  if (typeof node.type === 'function') return expand(node.type(node.props));
  const children = expand(node.props?.children);
  return { ...node, props: { ...node.props, children } };
}

console.log('\ndsh-websearch-quota — client half\n');

console.log('loader contract');
same('loader id is the package name', registered?.id, 'dsh-websearch-quota');
check('factory is a function', typeof registered?.factory === 'function');

const exportsObject = registered.factory(requireStub);
same('exported name', exportsObject.name, 'dsh-websearch-quota');
check('exported inject lists slots', Array.isArray(exportsObject.inject) && exportsObject.inject.includes('slots'), JSON.stringify(exportsObject.inject));
check('apply is a function', typeof exportsObject.apply === 'function');

console.log('\nslot registration');
let descriptor;
let component;
const disposers = [];
exportsObject.apply({
  get(key) {
    same('client half asks for no service', key, undefined);
    return undefined;
  },
  slots: {
    inject(key, callback) {
      same('slot key', key, 'conversation.composer.dock');
      callback();
      return () => {};
    },
    register(value, view) {
      descriptor = value;
      component = view;
      return () => {};
    },
  },
  effect(factory) {
    disposers.push(factory());
  },
});

same('descriptor.name', descriptor?.name, 'conversation.composer.dock');
same('descriptor.id', descriptor?.id, 'dsh-websearch-quota');
same('descriptor.order', descriptor?.order, 40);
same('descriptor.label', descriptor?.label?.(), '免费搜索额度');
check('component is a function', typeof component === 'function');
check('effect disposal is callable', typeof disposers[0] === 'function');

// ── render helpers ─────────────────────────────────────────────────────────
function mount() {
  hooks.slots.length = 0;
  hooks.cursor = 0;
  effectQueue.length = 0;
  seen.urls.length = 0;
  seen.methods.length = 0;
  timers.intervals.length = 0;

  const draw = () => {
    hooks.cursor = 0;
    const element = component();
    while (effectQueue.length) effectQueue.shift()();
    return expand(element);
  };
  render = draw;
  return { tree: draw(), draw };
}

const chipText = (tree) => textOf(tree.props.children[0]).trim();
const panelOf = (tree) => find(tree, (node) => node.props?.['data-websearch-quota-panel'] === 'true');
const buttonWith = (tree, label) => find(tree, (node) => node.type === 'button' && String(textOf(node)).includes(label));

console.log('\nchip states');
{
  snapshotBody = SNAPSHOT_LIMITED;
  const { tree, draw } = mount();
  await pause();
  const shaped = draw();
  same('unknown first paint says so', chipText(tree), '免费搜索 · 待连接');
  check('chip is an interactive role', tree.props.children[0].props.role === 'button');
  check('limited chip counts down the real window', chipText(shaped).startsWith('免费搜索 · 16h45m 后恢复'), chipText(shaped));
  check('the tooltip says where the window came from', /限流/.test(String(shaped.props.children[0].props.title)), String(shaped.props.children[0].props.title));
  check('poll interval is the documented cadence', timers.intervals.includes(30000), JSON.stringify(timers.intervals));
  check('one snapshot request per poll', seen.urls.filter((url) => url.startsWith('/websearch-quota')).length >= 1, JSON.stringify(seen.urls));
  check('visibilitychange is observed', documentListeners.has('visibilitychange'));
}

{
  snapshotBody = SNAPSHOT_KEYED;
  mount();
  await pause();
  const tree = render();
  check('a keyed balance wins the chip', chipText(tree).startsWith('免费搜索 · 剩余 42'), chipText(tree));
}

{
  snapshotBody = SNAPSHOT_LIMITED;
  snapshotStatus = 500;
  const { draw } = mount();
  await pause();
  const tree = draw();
  check('an unreachable host half degrades to the waiting chip', chipText(tree).includes('待连接'), chipText(tree));
  check('the error is surfaced in the tooltip', String(tree.props.children[0].props.title).includes('HTTP 500'), String(tree.props.children[0].props.title));
  snapshotStatus = 200;
}

console.log('\nthe panel');
{
  snapshotBody = SNAPSHOT_LIMITED;
  const { draw } = mount();
  await pause();
  const tree = draw();
  const before = seen.urls.length;
  tree.props.children[0].props.onClick();
  await pause();
  const opened = render();

  check('opening the chip refetches the snapshot', seen.urls.length > before, `${before} → ${seen.urls.length}`);
  const panel = panelOf(opened);
  check('the panel is rendered', panel !== null);
  const text = textOf(panel);
  for (const expected of [
    '免费 Web 搜索额度',
    'Firecrawl keyless 限流中',
    '本机今日调用',
    '自设预算（50/天）',
    'Firecrawl',
    'Tavily',
    'Exa',
    'modsearch 配置',
    '数据来源',
  ]) {
    check(`panel shows ${expected}`, text.includes(expected), text.slice(0, 200));
  }
  check('counts reach the panel', text.includes('3 次') && text.includes('剩余 47'), text.slice(0, 300));
  check('the source of the window is quoted', text.includes('retry_after_seconds: 60308'));
  check('read_page probe button reflects the limit', buttonWith(panel, '检测是否已恢复') !== null);

  const probeButton = buttonWith(panel, '检测是否已恢复');
  probeButton.props.onClick();
  await pause();
  const afterProbe = panelOf(render());
  check('the probe posts to the route', seen.urls.includes('/websearch-quota/probe') && seen.methods[seen.urls.indexOf('/websearch-quota/probe')] === 'POST', JSON.stringify(seen));
  check('the probe result is shown', textOf(afterProbe).includes('keyless 仍在限流'), textOf(afterProbe).slice(0, 200));
}

{
  snapshotBody = SNAPSHOT_KEYED;
  mount();
  await pause();
  const tree = render();
  tree.props.children[0].props.onClick();
  await pause();
  const panel = panelOf(render());
  const text = textOf(panel);
  check('keyed balances are listed', text.includes('剩余 42 / 500 credits') && text.includes('993 / 1000 credits'), text.slice(0, 300));
  check('an open budget offers a probe that may spend it', buttonWith(panel, '试搜一次') !== null);
  check('period end is rendered', text.includes('计费周期至 11-01'));
}

// The bundle must stay loadable as a plain script (no build step, no ESM syntax).
console.log('\nbundle shape');
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
check('bundle avoids ESM import/export syntax', !/^\s*(import|export)\s/m.test(source));
check('bundle is self-contained (no require beyond the platform rows)', !/require\((['"])(?!react)/.test(source));
check('bundle declares the module-loader entry', source.includes("window.__ModuleLoader__.load"));
console.log(`  bundle size: ${source.length} bytes`);

console.log(`\n${checks - failures}/${checks} checks passed\n`);
if (failures > 0) process.exit(1);
