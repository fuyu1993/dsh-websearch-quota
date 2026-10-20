# dsh-websearch-quota

基于 modsearch 做的免费额度次数查询的小插件。

给 DSH（DeepSeek Harness）Web GUI 加一个常驻小徽章，回答一个问题：**这台机器现在还能免费用多少次 web 搜索？**

徽章挂在输入框下方的环境行（client slot `conversation.composer.dock`），点开是一张明细卡片：限流窗口、本机记账、真实余额、手动探测。

```
┌─ 输入框 ─────────────────────────────────────────────┐
│                                                      │
└──────────────────────────────────────────────────────┘
 ● 免费搜索 · 15h57m 后恢复        ← 徽章（常驻）
```

> **一句话立场**：Firecrawl keyless（`@liustack/modsearch` 的默认免费引擎）**官方不提供剩余次数**。所以本插件不编数字，只显示三类能证实的信息：**限流窗口**（还能不能用、多久恢复）、**本机记账**（这台机器实际用了几次）、**带 key 时的真实余额**。

---

## 目录

- [徽章与面板](#徽章与面板)
- [安装](#安装)
- [配置](#配置)
- [数据来源与诚实边界](#数据来源与诚实边界)
- [本地状态与隐私](#本地状态与隐私)
- [HTTP 接口](#http-接口)
- [故障排查](#故障排查)
- [开发与测试](#开发与测试)
- [许可证](#许可证)

---

## 徽章与面板

### 徽章状态

| 状态 | 徽章文字 | 含义 |
| --- | --- | --- |
| 限流中 | `免费搜索 · 15h57m 后恢复` | 观测到过 Firecrawl keyless 的 429，倒计时到响应里 `retry_after_seconds` 给出的恢复时刻 |
| 有 key 余额 | `免费搜索 · 剩余 842` | 配了 Firecrawl / Tavily key 时显示真实剩余额度，取余额最低的那个引擎 |
| 可用 | `免费搜索 · 可用` | 上次观测时 keyless 可用（悬停显示本机今日调用次数） |
| 未探测 | `免费搜索 · 未探测` | 还没有任何限流证据，只按本机记账显示今日次数 |
| 待连接 | `免费搜索 · 待连接` | 宿主半段没起来（快照请求失败） |

### 明细卡片

点击徽章展开，自上而下：

1. **Firecrawl keyless 状态**：限流窗口 + 恢复的具体时刻，并注明是**精确**窗口（来自 429 的 `retry_after_seconds`）还是**估算**窗口（没有任何秒数时的 45 分钟兜底）。
2. **本机今日调用**：`N 次`，以及其中搜索 / 抓取各几次、出错几次。
3. **本机本月调用**、**自设预算剩余**（配了 `dailyBudget` 才有）、**最近一次调用**（工具名 + 时间）。
4. **各引擎一行**：Firecrawl、Tavily、Exa、Antigravity CLI 的可用性、真实余额（有 key 时）、以及一句说明。
5. **modsearch 自身冷却**：`~/.modsearch/state.json` 里的条目，明确标注「**不是**真实恢复时间」。
6. **探测按钮**：限流中显示「检测是否已恢复」（免费），可用时显示「试搜一次（会消耗额度）」。
7. **数据来源脚注**：三行，说明每个数字是怎么来的。

### 交互

- 点击徽章开 / 关卡片；`Esc` 或点击卡片外部关闭；键盘 `Enter` / `Space` 也能打开。
- 卡片 30 秒自动轮询一次；标签页切到后台时停止轮询，切回立即刷新。
- 卡片里的倒计时每秒走一格。
- 「刷新」按钮会**强制**重新查询带 key 的余额（绕过 5 分钟缓存）。

---

## 安装

前置条件：

- DSH Web 形态（`dsh.client.platform` 为 `web`），登录态可访问 GUI。
- 建议同时装有 [`@liustack/modsearch`](https://www.npmjs.com/package/@liustack/modsearch)（徽章监控的就是它的免费引擎）；没装也能用，只是引擎行会显示「未配置」。

### 方式 A：GUI 插件页安装（最省事）

在 DSH GUI 的插件管理里安装本地包：

```text
plugin_manager install_bundle   target: link:/绝对路径/dsh-websearch-quota
```

或从 npm 装（已发布时）：

```text
plugin_manager install_bundle   target: dsh-websearch-quota
```

装完确认它在 `dsh.profile.bundles` 里并且处于启用状态。

### 方式 B：命令行（非 Electron 托管的 profile）

```bash
dsh plugin --profile <profile名> add link:/绝对路径/dsh-websearch-quota
```

然后把包名加进该 profile `package.json` 的 `dsh.profile.bundles` 数组：

```jsonc
{
  "dependencies": {
    "dsh-websearch-quota": "link:/绝对路径/dsh-websearch-quota"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-websearch-quota"]
    }
  }
}
```

> **只加依赖、不加 bundle** 时状态是 `installed: true, enabled: false`——包在，但不会加载。

### 方式 C：手工编辑（Electron App 托管的 profile）

Electron App 独占管理自己的 profile，`dsh plugin --profile desktop ...` 会被拒绝：

```text
profile "desktop" is managed exclusively by the Electron application
```

改 `${DSH_HOME}/profiles/<profile>/package.json` 即可（上面方式 B 的两处改动），保存后 App 会**热应用**：

- 宿主半段注册路由（诊断日志出现 `route-registered`）；
- 浏览器半段注册到 `conversation.composer.dock`。

改动前建议备份 `package.json`；撤销时还原备份并刷新页面。

### 启用 / 禁用 / 卸载

| 操作 | 做法 |
| --- | --- |
| 禁用 | 插件页关闭，或从 `dsh.profile.bundles` 里删掉包名 |
| 卸载 | 插件页卸载，或删依赖 + 删 bundle 条目 + 删 `node_modules` 里的链接 |
| 保留账本 | 卸载不会删 `<DSH_HOME>/websearch-quota/state.json`，需要清空请手动删 |

---

## 配置

配置写在 bundle 行上（`cordis.patch.yml` 的 `config:` 块），**全部可选**：

```yaml
- insert:
    - id: dsh-websearch-quota
      name: 'dsh-websearch-quota'
      config:
        dailyBudget: 50
        probeEnabled: true
```

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `dailyBudget` | `null` | 自设每日预算（次数），面板显示「剩余 X / N」 |
| `probeEnabled` | `true` | `false` 隐藏探测按钮，`POST /probe` 返回 403 |
| `probeMinIntervalMs` | `30000` | 两次探测的最小间隔 |
| `keyQuotaTtlMs` | `300000` | 带 key 真实余额的缓存时长（5 分钟） |
| `trackTools` | `["web_search","web_fetch","x_search","read_page"]` | 计入账本的工具集合 |
| `stateFile` | `<DSH_HOME>/websearch-quota/state.json` | 本地账本路径 |
| `modsearchConfigPath` | `~/.modsearch/config.json` | 读 API key 的位置 |
| `modsearchStatePath` | `~/.modsearch/state.json` | 读 modsearch 冷却的位置 |

工具 → 用途的归类：`web_search` → 搜索，`x_search` → X 搜索，`web_fetch` / `read_page` → 抓取。

---

## 数据来源与诚实边界

### 1. Firecrawl keyless：没有剩余次数可读

- 响应头里**没有** `x-ratelimit-*`；
- keyless 调 `GET /v2/team/credit-usage` 返回 **401** `This endpoint is not supported by the keyless free tier`；
- 上限官方只说是「每 IP 每天」（requests 与 credits 双限额），**数值从未公布**。

所以插件对 keyless 只做两件事：

- **解析 429**：从响应体 / 头里取 `retry_after_seconds`（也支持 `Resets in 16h47m`、`try again in 90 seconds` 等写法），得到恢复时刻；一个秒数都取不到时才用 **45 分钟估算**，并在面板里标注「约」。
- **本机记账**：`tools/result` 事件里观测到的 web 工具调用，跨会话累计。

> 网上常见的「modsearch keyless 1000 次/月」其实是 Firecrawl **带 key 的 Free plan** 额度，不是 keyless 层。

### 2. `~/.modsearch/state.json` 的冷却不能当配额源

modsearch 把 keyless 的普通 429 归类成「持续性限额」时，会写一个**固定 45 分钟**的冷却（`DEFAULT_COOLDOWN_MS`），而不是真实恢复时间；`cooldown: "off"` 还能整体关掉。
插件把这份冷却放在「参考」一栏并明确标注；徽章用的是自己观测到的窗口，两者冲突时以前者为准。

### 3. 带 key 才有真实余额

| 引擎 | 接口 | 字段 |
| --- | --- | --- |
| Firecrawl | `GET https://api.firecrawl.dev/v2/team/credit-usage` | `data.remainingCredits` / `data.planCredits` / 账期 |
| Tavily | `GET https://api.tavily.com/usage` | `key.usage` / `key.limit` / `account.plan_usage` / `account.plan_limit` |
| Exa | — | 无公开余额接口（唯一 usage API 需要 Team Management 的 service key） |

key 的读取顺序：`~/.modsearch/config.json` 的 `engines.<engine>.apiKey`（支持逗号分隔多个 key，取第一个）→ 环境变量 `FIRECRAWL_API_KEY` / `TAVILY_API_KEY` / `EXA_API_KEY`。

### 4. 计量范围

账本只统计**本机、本 DSH profile、本插件安装之后**的调用。别的机器、别的客户端、直接 `curl` 的调用都不在内。

---

## 本地状态与隐私

- 账本写在 `<DSH_HOME>/websearch-quota/state.json`（`DSH_HOME` 默认 `~/.dsh`），**只在本机**，不上传任何地方；写入是原子写（先写 `.tmp` 再 rename），并且 1.5 秒防抖。
- 记录内容只有：日期分桶的调用计数、最近调用时间、限流窗口与一段特征文本（`evidence`，截断到 240 字符）。
- **所有对外字符串都会过 `redactSecrets`**：`fc-` / `tvly-` / `exa-` / `sk-` 前缀的 key 以及 32 字符以上的长串会被替换成 `***`。API key 本身从不写入账本、从不返回给浏览器。
- 诊断日志 `$TMPDIR/dsh-websearch-quota.log` 一行一事件，只记事件名与必要的错误信息，永不抛错。

---

## HTTP 接口

挂载在宿主 `webServer` 上的 `prefix` 路由，**每个 handler 都自己复核对端是回环 socket**（`connection.requestRejection`），并沿用宿主的 Host / Origin 与会话校验：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/websearch-quota` | 快照（限流窗口、账本、真实余额、modsearch 冷却） |
| `GET` | `/websearch-quota/health` | 同上（探活） |
| `GET` | `/websearch-quota?refresh=1` | 强制刷新带 key 的余额（绕过缓存） |
| `POST` | `/websearch-quota/probe` | 手动探测一次 Firecrawl keyless（受 `probeMinIntervalMs` 节流） |

快照主要字段：

```jsonc
{
  "ok": true,
  "version": "0.1.0",
  "now": 1791882532528,
  "ledger": {
    "today": { "day": "2026-10-13", "calls": 2, "search": 2, "fetch": 0, "x": 0, "errors": 1, "credits": null },
    "monthCalls": 2, "allTime": 2, "trackedDays": 1,
    "lastCallAt": 1791882532528, "lastSuccessAt": null,
    "dailyBudget": null, "remainingToday": null
  },
  "keyless": {
    "state": "limited",              // limited | ok | unknown
    "until": 1791940002528,
    "remainingMs": 57470000,
    "exact": true,                    // false = 45 分钟估算窗口
    "source": "tool-result",          // tool-result | probe
    "evidence": "…429 body…",
    "probe": { "enabled": true, "running": false, "lastAt": 1791882469000, "lastStatus": 429, "lastMessage": "…", "allowedInMs": 0 }
  },
  "engines": [
    { "id": "firecrawl", "kind": "keyless", "status": "limited", "remaining": null, "limit": null, "detail": "16h47m 后恢复（09:06）", "note": "官方未公开 keyless 每日剩余额度；search ≈ 2 credits / 10 条，scrape 1 credit" }
    // tavily / exa / agy 同理：status ∈ ok | limited | unknown | error | missing-key | missing
  ],
  "modsearch": { "configFound": false, "engine": null, "keylessFetch": null, "keysConfigured": [], "cooldowns": [] },
  "config": { "dailyBudget": null, "trackTools": ["…"], "keyQuotaTtlMs": 300000 },
  "paths": { "stateFile": "…", "modsearchConfig": "…", "diagnostics": "…" },
  "sources": ["…三行数据来源…"]
}
```

错误码：`401/403 unauthorized`（非回环 / 会话校验失败）、`403 probe-disabled`、`405 method-not-allowed`（探测用了 GET）、`429 rate-limited`（探测太频繁）、`404 unknown-action`。

---

## 故障排查

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 徽章一直是「待连接」 | 宿主半段没加载，或快照请求被拒 | 看 `$TMPDIR/dsh-websearch-quota.log` 有没有 `route-registered`；确认包在 `dsh.profile.bundles` 里且启用 |
| 完全没有徽章 | 浏览器半段没加载 | 刷新页面；确认 App 日志里 client bundle 被加载（`dsh.client.platform: web`） |
| 徽章显示「未探测」很久 | 确实没遇到过 429，也没有 key | 正常状态；想看当前能不能用就点「试搜一次」 |
| 探测按钮返回 429 | 探测太频繁（默认 30 秒）或 keyless 真在限流 | 等倒计时结束；`rate-limited` 是插件自己的节流 |
| 探测按钮返回 403 | `probeEnabled: false` | 改配置为 `true` |
| 带 key 余额显示「查询失败」 | key 无效 / 网络不通 / 该 key 权限不足 | 面板会显示厂商返回的原文（已脱敏）；`?refresh=1` 重试 |
| 账本数字比实际少 | 只统计 `trackTools` 里的工具，且只从现在开始 | 用 `trackTools` 加工具；历史调用无法回溯 |
| profile 的 pnpm 装不上 | 例如 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` | 与该包无关；按 pnpm 提示 `pnpm clean --lockfile && pnpm install` 重建 lockfile，或直接用 `link:` 本地安装 |

---

## 开发与测试

```bash
npm test     # quota 16 例 + host 10 例 + client 44 项检查
```

> Node 24 下 `node --test test/` 会把目录当模块解析（`MODULE_NOT_FOUND`），所以脚本里写死了测试文件。

| 文件 | 职责 |
| --- | --- |
| `lib/quota.js` | 纯逻辑：工具名归类、限流特征识别与窗口解析、账本聚合、格式化、脱敏。无 IO、无 DSH 依赖 |
| `lib/index.js` | 宿主半段：`tools/result` 观察者、本地账本落盘、厂商余额查询、`webServer` 路由 |
| `lib/client.js` | 浏览器半段：手写 lazy-CJS（`window.__ModuleLoader__.load`），`ctx.inject(['slots'])` 注册徽章，无构建步骤 |

改动的生效方式：

- `lib/client.js`：刷新页面即可（bundle 版本按 mtime/size 计算）。
- `lib/index.js`：宿主 ESM 模块有缓存，需重启 App（或重启 `dsh web`）。重新安装/禁用再启用**不会**命中新代码。

数据流：

```text
tools/result (web_search / web_fetch / x_search / read_page)
        │
        ├─→ applyCall()  ──→ state.json（账本 + 429 窗口）
        │
GET /websearch-quota ──→ snapshot() ──→ 徽章 + 明细卡片
POST /websearch-quota/probe ──→ applyProbe() ──→ state.json
```

## 许可证

[MIT](./LICENSE)
