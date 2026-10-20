/* dsh-websearch-quota — client (browser) half.
 *
 * Hand-written, no build step: the DSH client bundle format is a CommonJS
 * factory registered with the page's module loader. `require` resolves the
 * shared platform rows (`react`, `react-dom`, `react/jsx-runtime`).
 *
 * The chip lives in `conversation.composer.dock` — the ambient row below the
 * composer card — and answers, at a glance, whether the local modsearch stack
 * can still search for free. Clicking it opens a panel with the details: the
 * rate-limit window, this machine's own call ledger, and the real credit
 * balance of every engine that has an API key configured.
 *
 * All data comes from this plugin's host half (`GET /websearch-quota`); the
 * browser never sees an API key.
 */
window.__ModuleLoader__.load({
	id: 'dsh-websearch-quota',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require('react');
		const ReactDOM = require('react-dom');
		const h = React.createElement;

		const NAME = 'dsh-websearch-quota';
		/** `slots` is the only service this half needs. */
		const inject = ['slots'];

		const SLOT = 'conversation.composer.dock';
		const ROUTE = '/websearch-quota';
		/** Panel poll interval while the GUI is visible. */
		const POLL_MS = 30000;
		/** Countdown refresh (local, no request). */
		const TICK_MS = 1000;

		const SURFACE = 'var(--dsw-alias-bg-overlay, #1c1c1e)';
		const LAYER = 'var(--dsw-alias-bg-layer-1, #232326)';
		const BORDER = 'var(--dsw-alias-border-l1, rgba(127,127,127,.28))';
		const TEXT = 'var(--dsw-alias-label-primary, #e8e8ea)';
		const MUTED = 'var(--dsw-alias-label-secondary, #9a9aa0)';
		const ACCENT = 'var(--dsw-alias-brand-primary, #4c8dff)';
		const OK = 'var(--dsw-alias-state-success-primary, #35c46a)';
		const WARN = 'var(--dsw-alias-state-warn-primary, #f0b429)';
		const ERR = 'var(--dsw-alias-state-error-primary, #ff6b6b)';
		const IDLE = 'var(--dsw-alias-state-idle-primary, #8a8a90)';

		const STATUS_COLOR = {
			ok: OK,
			limited: WARN,
			unknown: IDLE,
			'missing-key': IDLE,
			missing: IDLE,
			error: ERR,
		};

		/** `16h47m` · `45m` · `12s` — the same shape the host half prints. */
		function formatDuration(ms) {
			const seconds = Math.max(0, Math.round(Number(ms) || 0) / 1000);
			if (seconds < 60) return `${Math.round(seconds)}s`;
			const minutes = Math.floor(seconds / 60);
			if (minutes < 60) return `${minutes}m`;
			const hours = Math.floor(minutes / 60);
			const rest = minutes % 60;
			if (hours < 24) return rest ? `${hours}h${String(rest).padStart(2, '0')}m` : `${hours}h`;
			const days = Math.floor(hours / 24);
			const restHours = hours % 24;
			return restHours ? `${days}d${restHours}h` : `${days}d`;
		}

		function clock(ts) {
			const d = new Date(ts);
			return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
		}

		async function fetchSnapshot(force) {
			const response = await fetch(`${ROUTE}${force ? '?refresh=1' : ''}`, {
				credentials: 'same-origin',
				headers: { accept: 'application/json' },
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return response.json();
		}

		/**
		 * Poll the host half. One interval, refetched on demand (open, refresh
		 * button, tab refocus) so a search the user just ran shows up quickly.
		 */
		function useSnapshot() {
			const [data, setData] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [loading, setLoading] = React.useState(true);

			const load = React.useCallback(async (force) => {
				setLoading(true);
				try {
					const next = await fetchSnapshot(Boolean(force));
					setData(next);
					setError(null);
				} catch (cause) {
					setError(String(cause?.message ?? cause));
				} finally {
					setLoading(false);
				}
			}, []);

			React.useEffect(() => {
				let alive = true;
				const tick = () => {
					if (!alive) return;
					if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
					load(false);
				};
				tick();
				const timer = setInterval(tick, POLL_MS);
				const onVisible = () => {
					if (document.visibilityState === 'visible') load(false);
				};
				document.addEventListener?.('visibilitychange', onVisible);
				return () => {
					alive = false;
					clearInterval(timer);
					document.removeEventListener?.('visibilitychange', onVisible);
				};
			}, [load]);

			return { data, error, loading, reload: load };
		}

		/** A locally ticking clock, so the countdown moves without a request. */
		function useTick(active, intervalMs) {
			const [, setNow] = React.useState(Date.now());
			React.useEffect(() => {
				if (!active) return undefined;
				const timer = setInterval(() => setNow(Date.now()), intervalMs);
				return () => clearInterval(timer);
			}, [active, intervalMs]);
		}

		/** What the chip says: real balance first, then the limit window. */
		function chipState(data) {
			if (!data) return { tone: 'unknown', text: '免费搜索 · 待连接' };
			const keyed = (data.engines ?? []).filter(
				(engine) => engine.kind === 'key' && typeof engine.remaining === 'number',
			);
			if (keyed.length > 0) {
				const lowest = keyed.reduce((min, engine) => (engine.remaining < min.remaining ? engine : min), keyed[0]);
				return { tone: 'ok', text: `免费搜索 · 剩余 ${lowest.remaining}`, detail: `${lowest.name} 余额最低` };
			}
			const keyless = data.keyless ?? { state: 'unknown' };
			if (keyless.state === 'limited') {
				return {
					tone: 'limited',
					text: `免费搜索 · ${formatDuration(keyless.remainingMs)} 后恢复`,
					detail: keyless.exact ? 'Firecrawl keyless 限流窗口' : 'Firecrawl keyless 限流（估算窗口）',
				};
			}
			const today = data.ledger?.today?.calls ?? 0;
			if (keyless.state === 'ok') return { tone: 'ok', text: `免费搜索 · 可用`, detail: `本机今日 ${today} 次` };
			return { tone: 'unknown', text: '免费搜索 · 未探测', detail: `本机今日 ${today} 次` };
		}

		function Dot({ tone }) {
			return h('span', {
				style: {
					width: 7,
					height: 7,
					borderRadius: '50%',
					flex: '0 0 auto',
					background: STATUS_COLOR[tone] ?? IDLE,
					boxShadow: tone === 'limited' ? `0 0 0 3px ${WARN}22` : 'none',
				},
			});
		}

		function Row({ label, value, muted }) {
			return h(
				'div',
				{ style: { display: 'flex', justifyContent: 'space-between', gap: 10, padding: '2px 0' } },
				h('span', { style: { color: muted ? MUTED : TEXT } }, label),
				h('span', { style: { color: TEXT, fontVariantNumeric: 'tabular-nums' } }, value),
			);
		}

		function EngineRow({ engine }) {
			const tone = engine.status ?? 'unknown';
			return h(
				'div',
				{
					style: {
						borderTop: `1px solid ${BORDER}`,
						padding: '7px 0 6px',
					},
				},
				h(
					'div',
					{ style: { display: 'flex', alignItems: 'center', gap: 6 } },
					h(Dot, { tone }),
					h('span', { style: { color: TEXT, fontWeight: 600 } }, engine.name),
					h('span', { style: { color: MUTED, fontSize: 11 } }, engine.role ? `· ${engine.role}` : ''),
				),
				h('div', { style: { color: TEXT, paddingLeft: 13, marginTop: 2 } }, engine.detail ?? ''),
				engine.note
					? h('div', { style: { color: MUTED, fontSize: 11, paddingLeft: 13, marginTop: 1 } }, engine.note)
					: null,
				engine.periodEnd
					? h('div', { style: { color: MUTED, fontSize: 11, paddingLeft: 13 } }, `计费周期至 ${engine.periodEnd}`)
					: null,
			);
		}

		function Button({ onClick, children, tone, disabled, title }) {
			return h(
				'button',
				{
					type: 'button',
					onClick,
					disabled: Boolean(disabled),
					title,
					style: {
						appearance: 'none',
						border: `1px solid ${BORDER}`,
						background: LAYER,
						color: disabled ? MUTED : tone === 'accent' ? ACCENT : TEXT,
						borderRadius: 7,
						padding: '3px 9px',
						fontSize: 11,
						cursor: disabled ? 'default' : 'pointer',
						opacity: disabled ? 0.6 : 1,
					},
				},
				children,
			);
		}

		/**
		 * The panel itself, rendered through a portal so the composer's own
		 * stacking/overflow cannot clip it.
		 */
		function Panel({ anchor, data, error, loading, reload, onClose }) {
			const [probe, setProbe] = React.useState(null);
			const [busy, setBusy] = React.useState(false);

			React.useEffect(() => {
				const onKey = (event) => {
					if (event.key === 'Escape') onClose();
				};
				const onDown = (event) => {
					if (anchor?.node && anchor.node.contains(event.target)) return;
					if (event.target?.closest?.('[data-websearch-quota-panel]')) return;
					onClose();
				};
				document.addEventListener('keydown', onKey);
				document.addEventListener('mousedown', onDown, true);
				return () => {
					document.removeEventListener('keydown', onKey);
					document.removeEventListener('mousedown', onDown, true);
				};
			}, [anchor, onClose]);

			const runProbe = async () => {
				setBusy(true);
				try {
					const response = await fetch(`${ROUTE}/probe`, {
						method: 'POST',
						credentials: 'same-origin',
						headers: { accept: 'application/json' },
					});
					const body = await response.json().catch(() => null);
					setProbe(body?.message ?? `HTTP ${response.status}`);
					if (body?.snapshot) reload?.(false);
				} catch (cause) {
					setProbe(`探测失败：${String(cause?.message ?? cause)}`);
				} finally {
					setBusy(false);
				}
			};

			const rect = anchor?.rect;
			const width = 336;
			const left = rect
				? Math.max(8, Math.min(rect.left, (window.innerWidth || width + 16) - width - 8))
				: 16;
			const bottom = rect ? Math.max(8, (window.innerHeight || 0) - rect.top + 8) : 64;
			const keyless = data?.keyless ?? null;
			const ledger = data?.ledger ?? null;

			const body = h(
				'div',
				{
					'data-websearch-quota-panel': 'true',
					style: {
						position: 'fixed',
						left,
						bottom,
						width,
						zIndex: 60,
						background: SURFACE,
						border: `1px solid ${BORDER}`,
						borderRadius: 12,
						boxShadow: '0 14px 40px rgba(0,0,0,.42)',
						padding: 12,
						color: TEXT,
						fontSize: 12,
						lineHeight: 1.55,
						fontFamily: 'inherit',
					},
				},
				h(
					'div',
					{ style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
					h('span', { style: { fontWeight: 600, fontSize: 13, flex: '1 1 auto' } }, '免费 Web 搜索额度'),
					h(Button, { onClick: () => reload?.(true), disabled: loading, title: '重新读取（含真实余额查询）' }, loading ? '…' : '刷新'),
					h(Button, { onClick: onClose, title: '关闭' }, '✕'),
				),
				error
					? h('div', { style: { color: ERR, marginBottom: 6 } }, `无法读取主机半段：${error}`)
					: null,

				keyless
					? h(
							'div',
							{ style: { color: keyless.state === 'limited' ? WARN : MUTED, marginBottom: 4 } },
							keyless.state === 'limited'
								? `Firecrawl keyless 限流中：${keyless.exact ? '' : '约 '}${formatDuration(keyless.remainingMs)} 后恢复（${clock(keyless.until)}）${keyless.exact ? '' : ' · 估算窗口'}`
								: keyless.state === 'ok'
									? 'Firecrawl keyless：上次观测可用'
									: 'Firecrawl keyless：尚未观测到限流',
						)
					: null,
				keyless?.evidence
					? h(
							'div',
							{ style: { color: MUTED, fontSize: 11, marginBottom: 6, wordBreak: 'break-all' } },
							`依据：${String(keyless.evidence).slice(0, 120)}${String(keyless.evidence).length > 120 ? '…' : ''}`,
						)
					: null,

				ledger
					? h(
							'div',
							{ style: { background: LAYER, border: `1px solid ${BORDER}`, borderRadius: 8, padding: '6px 8px', marginBottom: 6 } },
							h(Row, { label: '本机今日调用', value: `${ledger.today?.calls ?? 0} 次` }),
							h(Row, {
								label: '其中搜索 / 抓取',
								value: `${(ledger.today?.search ?? 0) + (ledger.today?.x ?? 0)} / ${ledger.today?.fetch ?? 0}`,
								muted: true,
							}),
							h(Row, { label: '本机本月调用', value: `${ledger.monthCalls ?? 0} 次`, muted: true }),
							ledger.dailyBudget !== null && ledger.dailyBudget !== undefined
								? h(Row, {
										label: `自设预算（${ledger.dailyBudget}/天）`,
										value: `剩余 ${ledger.remainingToday}`,
									})
								: null,
							h(Row, {
								label: '最近一次调用',
								value: ledger.lastCallAt ? clock(ledger.lastCallAt) : '—',
								muted: true,
							}),
						)
					: null,

				h(
					'div',
					null,
					...((data?.engines ?? []).map((engine) => h(EngineRow, { key: engine.id, engine }))),
				),

				data?.modsearch
					? h(
							'div',
							{ style: { color: MUTED, fontSize: 11, borderTop: `1px solid ${BORDER}`, paddingTop: 6, marginTop: 4 } },
							`modsearch 配置：${data.modsearch.configFound ? data.modsearch.configPath : '未找到'}`
								+ `${data.modsearch.engine ? ` · 指定引擎 ${data.modsearch.engine}` : ''}`
								+ `${data.modsearch.keysConfigured?.length ? ` · 已配 key：${data.modsearch.keysConfigured.join('、')}` : ' · 未配置 key（走 keyless）'}`,
							data.modsearch.cooldowns?.some((entry) => entry.active)
								? h(
										'div',
										{ style: { marginTop: 2 } },
										`modsearch 自身冷却：${data.modsearch.cooldowns
											.filter((entry) => entry.active)
											.map((entry) => `${entry.engine} ${formatDuration(entry.until - Date.now())}`)
											.join('、')}（插件用观测到的真实窗口，优先于它）`,
									)
								: null,
						)
					: null,

				h(
					'div',
					{ style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 } },
					data?.keyless?.probe?.enabled === false
						? h('span', { style: { color: MUTED, fontSize: 11 } }, '探测已关闭')
						: h(
								Button,
								{
									onClick: runProbe,
									disabled: busy || data?.keyless?.probe?.running,
									tone: 'accent',
									title: '直接向 Firecrawl keyless 发一次最小搜索：限流中免费，可用时消耗额度',
								},
								busy ? '探测中…' : keyless?.state === 'limited' ? '检测是否已恢复' : '试搜一次（会消耗额度）',
							),
					probe ? h('span', { style: { color: MUTED, fontSize: 11, flex: '1 1 auto' } }, probe) : null,
				),

				h(
					'div',
					{ style: { color: MUTED, fontSize: 10, marginTop: 6, lineHeight: 1.45 } },
					'数据来源：',
					...(data?.sources ?? ['主机半段未就绪']).map((line, index) => h('div', { key: index }, `· ${line}`)),
				),
			);

			return ReactDOM.createPortal(body, document.body);
		}

		/** The dock chip: one line, always visible under the composer. */
		function QuotaChip() {
			const { data, error, loading, reload } = useSnapshot();
			const [open, setOpen] = React.useState(false);
			const ref = React.useRef(null);
			const [anchor, setAnchor] = React.useState(null);
			const chip = chipState(data);
			useTick(chip.tone === 'limited', TICK_MS);

			React.useEffect(() => {
				if (!open) return undefined;
				const onMove = () => setOpen(false);
				window.addEventListener('resize', onMove);
				return () => window.removeEventListener('resize', onMove);
			}, [open]);

			const toggle = () => {
				if (open) {
					setOpen(false);
					return;
				}
				const node = ref.current;
				setAnchor({ node, rect: node?.getBoundingClientRect?.() ?? null });
				setOpen(true);
				reload(false);
			};

			return h(
				'span',
				{ style: { display: 'inline-flex', alignItems: 'center' } },
				h(
					'span',
					{
						ref,
						role: 'button',
						tabIndex: 0,
						onClick: toggle,
						onKeyDown: (event) => {
							if (event.key === 'Enter' || event.key === ' ') {
								event.preventDefault();
								toggle();
							}
						},
						title: `${chip.detail ?? '免费搜索额度'}${error ? `（主机半段错误：${error}）` : ''}`,
						style: {
							display: 'inline-flex',
							alignItems: 'center',
							gap: 6,
							height: 22,
							padding: '0 9px',
							borderRadius: 999,
							border: `1px solid ${BORDER}`,
							background: open ? LAYER : 'transparent',
							color: error ? ERR : chip.tone === 'limited' ? WARN : MUTED,
							fontSize: 11,
							lineHeight: 1,
							cursor: 'pointer',
							userSelect: 'none',
							whiteSpace: 'nowrap',
						},
					},
					h(Dot, { tone: error ? 'error' : chip.tone }),
					chip.text,
				),
				open
					? h(Panel, {
							anchor,
							data,
							error,
							loading,
							reload,
							onClose: () => setOpen(false),
						})
					: null,
			);
		}

		function apply(ctx) {
			ctx.effect(
				() =>
					ctx.slots.inject(SLOT, () =>
						ctx.slots.register(
							{
								name: SLOT,
								id: NAME,
								order: 40,
								label: () => '免费搜索额度',
							},
							QuotaChip,
						),
					),
				'dsh-websearch-quota: composer dock chip',
			);
		}

		exports.name = NAME;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
