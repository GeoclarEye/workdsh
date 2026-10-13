# 交付物即文件 · 生产侧 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 scene-card 插件的 Host 半区在 `geoclar_recommend_schemes` 工具返回时，自动把这次交付物落成工作区里的一份文件（`交付物/<slug>/manifest.json` + `v1.json`，含 `intent`），并提供一个宿主路由让客户端把「哪次调用」解析成「哪个路径」。

**Architecture:** 三段式，每段都可单独直测。① `deliverable-document.ts` 是**纯函数**：把（工具入参、出参、callId、当轮用户消息）拼成两份 JSON 的内容与目录 slug，不碰 IO。② `deliverable-store.ts` 只做**文件读写**：落盘、列举、按 `callId` 反查路径。③ `deliverable-producer.ts` 订阅 `session/event`，配对 `tool/call` 与 `tool/result`，把①②串起来。`index.ts` 把生产者挂进根 context，并在既有的 `/api/workdsh-scene-card` 路由上加 `deliverables` 端点。

**Tech Stack:** TypeScript（ESM，`.js` 后缀导入）、cordis 插件（`ctx.fs` / `ctx.on('session/event')` / `ctx.connection.fetch.register`）、`node --test` + `node:assert/strict`、构建后跑 `dist/`。

**Spec:** `docs/superpowers/specs/2026-10-13-deliverable-as-file-design.md`（§3 格式、§4 生产者、§7 降级、§9.2/9.3/9.4、§11 外部依赖）

## Global Constraints

- **本计划只做生产侧。** 面板改绑文件、自动弹重做属于消费侧，另立计划；本计划完成后交付物**正确落盘**，但 UI 仍走老路。
- **产物是纯数据，不含任何供应商侧字段。** 写进文件的只有工具出参原样的 `payload` 与工具入参的 `intent`；**不得**引入 `_raw`、真实场景号、`geometry`、`thumbUrl`（spec §11.2 的掩码边界）。
- **出参出什么就存什么**：`payload` 逐字来自 `tool/result`；`intent.conditions` 的字段名与工具 `arguments` **逐字对应**，生产者不做重命名（spec §3）。
- **严格度沿用本仓口径**：`format` 不对 ⇒ 一个字节都不碰；`type` 不认识 ⇒ 不写；形状读不懂 ⇒ 整份不写，**不写半份**。
- **不写则不报错**：任何"这次不落"的情形都只记日志、不抛到会话事件流上（spec §7）。
- 只在 **root context** 上订阅 `session/event`（spec §4：agent-scoped 只听自己进入的会话）。
- 文件用 UTF-8、`JSON.stringify(value, null, 2)` 两个空格缩进、结尾不加换行——与仓库里其它手写 JSON 产物一致，便于人直接读。
- 跑测试用 `node --test`，测试文件放 `packages/plugins/scene-card/tests/`，导入 `../dist/…js`（构建产物），与 `scene-card-host.test.mjs` 同形。
- **构建命令**（下面每个任务的 `Run:` 都按这条，均在**仓根**执行）：

  ```bash
  (cd apps/web && corepack pnpm --filter workdsh-plugin-scene-card build) && node --test packages/plugins/scene-card/tests/<file>.mjs
  ```

  **不要用根目录的 `corepack yarn build`** —— 根 Yarn workspace 只含 `apps/desktop`（根 `package.json` 的 `workspaces` 就一项），scene-card 属于 **`apps/web` 的 pnpm workspace**（`apps/web/pnpm-workspace.yaml` 收了 `../../packages/plugins/*`）。根 `yarn build` / `yarn check` 都不构建、不测试本插件。

---

### Task 1: 交付物文档的构造（纯函数）

把"一次工具调用"变成"两份 JSON 的内容"，全程不碰 IO，因此可以直测。

**Files:**
- Create: `packages/plugins/scene-card/src/runtime/deliverable-document.ts`
- Test: `packages/plugins/scene-card/tests/deliverable-document.test.mjs`

**Interfaces:**
- Consumes: 无（叶子模块）
- Produces:
  - `type DeliverableDocuments = { readonly slug: string; readonly manifest: Record<string, unknown>; readonly version: Record<string, unknown> }`
  - `type BuildInput = { readonly callId: string; readonly toolName: string; readonly args: unknown; readonly result: unknown; readonly subject: string; readonly at: Date }`
  - `function buildDeliverableDocuments(input: BuildInput): DeliverableDocuments | undefined`
  - `function slugOf(subject: string, at: Date): string`

- [ ] **Step 1: 写失败的测试**

创建 `packages/plugins/scene-card/tests/deliverable-document.test.mjs`：

```js
/**
 * 纯函数：一次工具调用 → 两份 JSON 的内容。不碰 IO，所以直接喂真形状。
 * 跑法：node --test packages/plugins/scene-card/tests/deliverable-document.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeliverableDocuments, slugOf } from '../dist/runtime/deliverable-document.js';

/** 工具调用的入参（`tool/call` 的 arguments，已解析）。 */
const args = {
  wkt: 'POLYGON((116 39, 117 39, 117 40, 116 40, 116 39))',
  maxCloud: 20,
  budget: 8000000,
  dateFrom: '2025-01-01',
};

/** 出参（`tool/result` 里那段 JSON，已解析）——夹具与 scheme-view 测试共用同一形状。 */
const result = {
  mode: 'custom',
  poolAtLimit: false,
  schemes: [{ key: 'CUSTOM', sceneCount: 235, coveragePercent: 65.16, uncoveredAreaKm2: 19239.18,
    estimatedAmount: 5564229.98, pricingComplete: true, budgetCapped: false,
    budgetFullCoverageAmount: null, dateFrom: '2024-12-06', dateTo: '2026-10-09',
    gsdMin: 0.25, gsdMax: 0.5, cloudCoverMax: 33, cloudCoverMean: 1.33, scenes: [] }],
};

const at = new Date('2026-10-13T12:58:00+08:00');

test('正常一次调用 → 两份文档都在，字段与约定一致', () => {
  const built = buildDeliverableDocuments({
    callId: 'call_abc', toolName: 'mcp__geoclar__geoclar_recommend_schemes',
    args, result, subject: '霍尔木兹海峡近三月影像组合', at,
  });
  assert.ok(built);
  assert.equal(built.manifest.format, 'workdsh-deliverable');
  assert.equal(built.manifest.schemaVersion, 1);
  assert.equal(built.manifest.callId, 'call_abc');
  assert.equal(built.manifest.subject, '霍尔木兹海峡近三月影像组合');
  assert.equal(built.manifest.current, 'v1.json');
  assert.deepEqual(built.manifest.versions.map((v) => v.file), ['v1.json']);
  assert.equal(built.version.format, 'workdsh-deliverable');
  assert.equal(built.version.type, 'scene-schemes');
  // payload 逐字来自出参 —— 同一个对象，不是重建的。
  assert.equal(built.version.payload, result);
  // 目录名以时间戳打头（UTC：12:58+08:00 = 04:58Z），且不含路径分隔符。
  assert.match(built.slug, /^20261013-045800-/);
  assert.ok(!built.slug.includes('/'));
});

test('intent 逐字抄入参：AOI + 给过的条件，未给的不出现', () => {
  const built = buildDeliverableDocuments({
    callId: 'call_abc', toolName: 'mcp__geoclar__geoclar_recommend_schemes', args, result,
    subject: 's', at,
  });
  assert.equal(built.version.intent.tool, 'geoclar_recommend_schemes');
  assert.equal(built.version.intent.scheme, 'CUSTOM');
  assert.equal(built.version.intent.aoi, args.wkt);
  assert.deepEqual(built.version.intent.conditions,
    { maxCloud: 20, budget: 8000000, dateFrom: '2025-01-01' });
  // 没给的 maxGsd / dateTo / datasetIds / offNadirMax / preferConsistent 一个都不写。
  assert.equal('maxGsd' in built.version.intent.conditions, false);
});

test('summary 由生产者派生：口径来自入参、读数来自主推那套', () => {
  const built = buildDeliverableDocuments({
    callId: 'c', toolName: 't', args, result, subject: 's', at });
  assert.equal(built.version.summary, '在云量 ≤ 20% 的口径下，这套盖到 65.16%，¥5,564,230。');
});

test('summary 缺哪个数就省哪个分句；一个都没有就是空串，不编套话', () => {
  const built = buildDeliverableDocuments({
    callId: 'c', toolName: 't', args: {}, result: { mode: 'custom', schemes: [{ key: 'CUSTOM' }] },
    subject: 's', at });
  assert.equal(built.version.summary, '');
});

test('工具名里剥出裸名：线格式是 mcp__<连接器>__<工具>', () => {
  const built = buildDeliverableDocuments({
    callId: 'c', toolName: 'mcp__geoclar__geoclar_recommend_schemes', args, result, subject: 's', at,
  });
  assert.equal(built.version.intent.tool, 'geoclar_recommend_schemes');
});

test('不认识形状 ⇒ 整份不写，而不是写半份', () => {
  const bad = [
    { ...result, mode: '别的' },            // mode 读不懂
    { ...result, schemes: 'x' },            // schemes 不是数组
    { ...result, schemes: [{ key: 1 }] },   // 方案缺 key
    undefined, null, 'x',
  ];
  for (const value of bad) {
    const built = buildDeliverableDocuments({
      callId: 'c', toolName: 't', args, result: value, subject: 's', at });
    assert.equal(built, undefined, `应拒绝：${JSON.stringify(value)}`);
  }
});

test('subject 为空时退回时间戳，不编一句话', () => {
  const built = buildDeliverableDocuments({
    callId: 'c', toolName: 't', args, result, subject: '', at });
  assert.equal(built.manifest.subject, '');
  assert.match(built.slug, /^20261013-045800$/);
});

test('slugOf：保留中日韩与字母数字，其余压成单个连字符，且限长', () => {
  assert.equal(slugOf('霍尔木兹海峡 near 3 mo!!', at), '20261013-045800-霍尔木兹海峡-near-3-mo');
  assert.equal(slugOf('', at), '20261013-045800');
  assert.ok(slugOf('啊'.repeat(200), at).length <= 64);
});

test('截断按码点，不切出落单的代理（否则 manifest.slug 与磁盘目录名会不一致）', () => {
  // U+20000 每个占两个 UTF-16 单元：按单元截会切出半对，落单的代理写到盘上变 U+FFFD。
  const slug = slugOf('𠀀'.repeat(80), at);
  assert.equal(Array.from(slug).length, 64);   // 按码点截，正好到上限
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test packages/plugins/scene-card/tests/deliverable-document.test.mjs`
Expected: FAIL —— `Cannot find module '../dist/runtime/deliverable-document.js'`

- [ ] **Step 3: 写实现**

创建 `packages/plugins/scene-card/src/runtime/deliverable-document.ts`：

```ts
/**
 * 一次工具调用 → 一份交付物的**内容**（`manifest.json` + `v< N >.json`）。纯函数，不碰 IO。
 *
 * 三条硬规矩直接来自 spec §3：
 *   · `format` 不对 ⇒ 不是交付物，一个字节都不碰；
 *   · `type` 不认识 / 形状读不懂 ⇒ **整份不写**，绝不写半份；
 *   · `payload` 逐字来自出参、`intent` 逐字来自入参 —— 生产者**不重命名、不补齐**。
 *
 * 与 `scheme-view.ts` 同一套严格度：缺 → 少一块，有但读不懂 → 整份不画。
 */

export interface DeliverableDocuments {
  /** 目录名：`<时间戳>-<短标题>`。 */
  readonly slug: string;
  readonly manifest: Record<string, unknown>;
  readonly version: Record<string, unknown>;
}

export interface BuildInput {
  /** 产出它的那次工具调用（记进 manifest 作溯源，客户端靠它反查路径）。 */
  readonly callId: string;
  readonly toolName: string;
  /** `tool/call` 的 arguments，**已解析**（解析失败时调用方给 `undefined`）。 */
  readonly args: unknown;
  /** `tool/result` 里那段 JSON，**已解析**。 */
  readonly result: unknown;
  /** 该轮用户消息（生产者从 `user/message` 事件记下的）；空串表示拿不到。 */
  readonly subject: string;
  readonly at: Date;
}

/** 本格式的标识；与专家包的 `workdsh-expert` 同构。 */
export const DELIVERABLE_FORMAT = 'workdsh-deliverable';
/** 格式主版本（spec §3：读不懂主版本 ⇒ 整份不画）。 */
export const DELIVERABLE_SCHEMA_VERSION = 1;
/** `type` → 渲染器。本期只有一个。 */
const TYPE_SCENE_SCHEMES = 'scene-schemes';

/**
 * `intent.conditions` 的键 —— **与工具 `arguments` 逐字对应**（spec §3）。
 *
 * 这里刻意用一张表而不是遍历 `args`：多抄一个键就是把不属于意图的东西写进凭据，
 * 而凭据是给下游当输入用的。表外的键一律不写。
 */
const CONDITION_KEYS = ['maxCloud', 'maxGsd', 'budget', 'dateFrom', 'dateTo',
  'datasetIds', 'offNadirMax', 'preferConsistent'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 线格式 `mcp__<连接器 serverName>__<工具名>` → 裸工具名；不匹配则原样返回。 */
function bareToolName(toolName: string): string {
  const parts = toolName.split('__');
  return parts.length >= 3 && parts[0] === 'mcp' ? parts.slice(2).join('__') : toolName;
}

/**
 * `20261013-045800` —— **UTC** 的 `YYYYMMDD-HHmmss`，用作目录名前缀。
 *
 * 用 UTC 而**不是**本地时间，三条理由：
 *   1. `manifest.versions[].at` 存的就是 `toISOString()`（UTC）——同一份 manifest 里两个时间
 *      不该一个 UTC 一个本地；
 *   2. 生产者在部署实例的容器里跑，**容器时区不该改变目录名**（否则本地跑与线上跑产出不同名）；
 *   3. 定长的字典序仍等于时间序，这是前缀的用途。
 *
 * 形状与 spec §3 的目录示例一致（`20261013-125800-hormuz-3mo`）。
 */
function stamp(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}`
    + `-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
}

/**
 * 目录名：时间戳 + 短标题。保留中日韩与字母数字，其余压成**单个**连字符（连续分隔符只出一个），
 * 整体截断到 64 字符。没有可用标题时**只有时间戳** —— 不编一句话。
 */
export function slugOf(subject: string, at: Date): string {
  const prefix = stamp(at);
  const body = subject
    .replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  if (body === '') return prefix;
  // **按码点**截断，不是按 UTF-16 单元：`.slice()` 会把代理对切成两半，落单的那半个写到盘上
  // 变成 U+FFFD，于是 `manifest.slug` 与磁盘目录名不一致 —— 而这份交付物的身份正是 slug + 路径。
  const room = 64 - prefix.length - 1;
  return `${prefix}-${Array.from(body).slice(0, room).join('')}`;
}

/** 出参形状闸：这一层只认它要显示的那些读数，读不懂就整份放弃。 */
function resultIsRenderable(result: unknown): result is Record<string, unknown> {
  if (!isRecord(result)) return false;
  if (result.mode !== 'custom' && result.mode !== 'presets') return false;
  if (!Array.isArray(result.schemes)) return false;
  if (result.schemes.length === 0) return false;
  return result.schemes.every((scheme) => isRecord(scheme) && typeof scheme.key === 'string');
}

/** 入参 → `intent.conditions`：只抄表内的键，未给的不出现。 */
function conditionsOf(args: unknown): Record<string, unknown> {
  if (!isRecord(args)) return {};
  const out: Record<string, unknown> = {};
  for (const key of CONDITION_KEYS) {
    const value = args[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

/** 主推那一套（`CUSTOM` 优先，其次 `VALUE`，再次第一套）—— 与 `scheme-view.ts` 同一口径。 */
function primaryOf(result: Record<string, unknown>): Record<string, unknown> | undefined {
  const schemes = result.schemes as Record<string, unknown>[];
  return schemes.find((scheme) => scheme.key === 'CUSTOM')
    ?? schemes.find((scheme) => scheme.key === 'VALUE')
    ?? schemes[0];
}

/**
 * 写给人看的一句话（spec §3：列表页与面板顶部用，不必读整份 payload）。
 *
 * 出参里**没有** `summary` 字段（已核 `RecommendTools` 的 `out.put` 无此项），所以这句由生产者
 * **派生**，口径照 spec §3 给的那句示例：条件口径（云量，来自**入参**）+ 主推那套的覆盖率与金额
 * （来自**出参**）。缺哪个数就省哪个分句；一个都缺就写空串 —— 不编一句套话。
 */
function summaryOf(result: Record<string, unknown>, args: unknown): string {
  const primary = primaryOf(result);
  const clauses: string[] = [];
  const maxCloud = isRecord(args) ? args.maxCloud : undefined;
  if (typeof maxCloud === 'number' && Number.isFinite(maxCloud)) {
    clauses.push(`在云量 ≤ ${maxCloud}% 的口径下`);
  }
  const coverage = primary?.coveragePercent;
  if (typeof coverage === 'number' && Number.isFinite(coverage)) clauses.push(`这套盖到 ${coverage}%`);
  const amount = primary?.estimatedAmount;
  if (typeof amount === 'number' && Number.isFinite(amount)) {
    clauses.push(`¥${Math.round(amount).toLocaleString('en-US')}`);
  }
  return clauses.length === 0 ? '' : `${clauses.join('，')}。`;
}

export function buildDeliverableDocuments(input: BuildInput): DeliverableDocuments | undefined {
  const { result } = input;
  // 形状读不懂 ⇒ 这次不落。**不抛**：生产者跑在会话事件流上，抛出去会污染别人的提交。
  if (!resultIsRenderable(result)) return undefined;
  const scheme = primaryOf(result)?.key;
  if (typeof scheme !== 'string') return undefined;

  const at = input.at;
  const iso = at.toISOString();
  const versionFile = 'v1.json';
  const summary = summaryOf(result, input.args);

  const version: Record<string, unknown> = {
    format: DELIVERABLE_FORMAT,
    type: TYPE_SCENE_SCHEMES,
    title: input.subject,
    summary,
    // 凭据半边：**怎么算出来的**。字段名与工具 arguments 逐字对应，不做重命名。
    intent: {
      tool: bareToolName(input.toolName),
      scheme,
      aoi: isRecord(input.args) ? input.args.wkt ?? null : null,
      conditions: conditionsOf(input.args),
    },
    // 展示半边：**算出了什么**。逐字来自出参。
    payload: result,
  };

  const manifest: Record<string, unknown> = {
    format: DELIVERABLE_FORMAT,
    schemaVersion: DELIVERABLE_SCHEMA_VERSION,
    slug: slugOf(input.subject, at),
    subject: input.subject,
    callId: input.callId,
    current: versionFile,
    versions: [{ file: versionFile, at: iso, note: '' }],
  };

  return { slug: manifest.slug as string, manifest, version };
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `(cd apps/web && corepack pnpm --filter workdsh-plugin-scene-card build) && node --test packages/plugins/scene-card/tests/deliverable-document.test.mjs`
Expected: PASS（9 个 test）

- [ ] **Step 5: 提交**

```bash
git add packages/plugins/scene-card/src/runtime/deliverable-document.ts packages/plugins/scene-card/tests/deliverable-document.test.mjs
git commit -m "feat(scene-card): 交付物文档构造（纯函数，含 intent）"
```

---

### Task 2: 落盘与反查（只做文件读写）

> **⚠ 本节的代码块是初版，已被评审推翻。以 `packages/plugins/scene-card/src/runtime/deliverable-store.ts`（commit `2c866183a9`）为准。**
>
> 本任务已完成为四个 commit（`e72d244c7a` / `b342c69e89` / `8b2b6ef89a` / `2c866183a9`），评审与复评均通过。下列差异是评审改出来的，**读本节时要用它们覆盖下面的代码**：
>
> 1. **读写都走 `ctx.fs`**（这是最重要的一条）。`StoreFs` 扩成 `resolve` / `writeText` / `listDir` / `readText` / `processPath`，并加 `StoreDirEntry { name, type, target }`。读路径原先走 `node:fs`，与写路径可能落在**不同文件系统**上——这是初版的真缺陷。`node:fs` 现在只剩 `mkdir`，那是 `ctx.fs` 唯一的能力缺口。
> 2. **`deliverableSubPathOf(slug)`**：`writeDeliverable` 只做**一次** `join` 并把相对路径交给 `fs.resolve(path, { cwd })`。初版写的是 `fs.resolve(deliverableDirOf(cwd, slug), { cwd })`，而那个串里已含 `cwd`，相对 `cwd` 下会叠成 `<cwd>/<cwd>/交付物/…`。`deliverableDirOf` 保留为纯字符串 helper。
> 3. **`readManifest` 多一道位置闸**：`record.slug !== dir.name` 即整份不认 —— 列表报的 `slug` 来自 manifest、`path` 来自目录名，不符时同一份交付物会以两个身份出现。这把"两侧一致"从**断言**变成**读侧强制**。
> 4. **路径取值统一**：`DeliverableEntry.path` 与 `writeDeliverable` 的返回值都取自 `fs.processPath`（**执行世界**里的绝对路径），不再自拼。
> 5. **列举不再自己排序**（`listDir` 契约即稳定名称序），且只认 `type === 'directory'` 的子项。
> 6. **测试 6 → 10 条**：补 `format` 与 `schemaVersion` 各一份**真目录**（初版那个坏夹具是个文件，读 `.../manifest.json` 先抛 ENOTDIR 被吞，根本走不到闸）、slug 与目录名不符、相对 `cwd`、以及正文写失败不留 manifest。

**Files:**
- Create: `packages/plugins/scene-card/src/runtime/deliverable-store.ts`
- Test: `packages/plugins/scene-card/tests/deliverable-store.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `DeliverableDocuments`
- Produces:
  - `const DELIVERABLE_DIR = '交付物'`
  - `type StoreFs = { resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<unknown>; writeText(target: unknown, content: string): Promise<unknown> }`
  - `function deliverableDirOf(cwd: string, slug: string): string` —— 纯函数，返回 `<cwd>/交付物/<slug>`
  - `async function writeDeliverable(fs: StoreFs, cwd: string, documents: DeliverableDocuments): Promise<string>` —— 返回写入的目录**绝对路径**
  - `async function listDeliverables(fs: StoreFs, cwd: string): Promise<readonly { path: string; slug: string; callId?: string; subject?: string }[]>`
  - `async function resolveCallId(fs: StoreFs, cwd: string, callId: string): Promise<string | undefined>`

- [ ] **Step 1: 写失败的测试**

创建 `packages/plugins/scene-card/tests/deliverable-store.test.mjs`：

```js
/**
 * 落盘与反查。用真临时目录 + 一个把 `ctx.fs` 映射到 node:fs 的薄壳，
 * 这样测的是**真文件**，而不是又一次打桩。
 * 跑法：node --test packages/plugins/scene-card/tests/deliverable-store.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { deliverableDirOf, listDeliverables, resolveCallId, writeDeliverable }
  from '../dist/runtime/deliverable-store.js';

/** `ctx.fs` 的最小面：resolve 返回自己的绝对路径，writeText 写下去。 */
const fs = {
  resolve: async (path) => ({ targetKey: path, absolute: path }),
  writeText: async (target, content) => { await writeFile(target.absolute, content, 'utf8'); },
};

const docs = (slug, callId) => ({
  slug,
  manifest: { format: 'workdsh-deliverable', schemaVersion: 1, slug, subject: 's',
    callId, current: 'v1.json', versions: [{ file: 'v1.json', at: '2026-10-13T00:00:00.000Z', note: '' }] },
  version: { format: 'workdsh-deliverable', type: 'scene-schemes', title: 's', summary: '',
    intent: { tool: 'geoclar_recommend_schemes', scheme: 'CUSTOM', aoi: 'POLYGON EMPTY', conditions: {} },
    payload: { mode: 'custom', schemes: [{ key: 'CUSTOM' }] } },
});

async function withDir(body) {
  const cwd = await mkdtemp(join(tmpdir(), 'wd-deliv-'));
  try { await body(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

test('deliverableDirOf：工作区根下 交付物/<slug>', () => {
  assert.equal(deliverableDirOf('/root/geoclar', '20261013-045800-x'), '/root/geoclar/交付物/20261013-045800-x');
});

test('落盘：两个文件都写出；目录自己建出来；正文是两空格缩进、结尾无换行', async () => {
  await withDir(async (cwd) => {
    // 这个 slug 在磁盘上不存在 ⇒ 顺带验证"目录不存在时自己建出来"（`ctx.fs` 没有 mkdir）。
    const path = await writeDeliverable(fs, cwd, docs('20261013-045800-a', 'call_1'));
    assert.equal(path, join(cwd, '交付物', '20261013-045800-a'));
    const manifestText = await readFile(join(path, 'manifest.json'), 'utf8');
    assert.equal(JSON.parse(manifestText).callId, 'call_1');
    // 真正的格式断言（不是只 round-trip 一遍 JSON）：缩进是两空格、结尾不留换行。
    assert.match(manifestText, /^\{\n {2}"format":/);
    assert.ok(!manifestText.endsWith('\n'), '结尾不该有换行');
    const versionText = await readFile(join(path, 'v1.json'), 'utf8');
    assert.equal(JSON.parse(versionText).type, 'scene-schemes');
    assert.match(versionText, /^\{\n {2}"format":/);
    // 两侧一致：建出来的目录名 == 磁盘上那份 manifest 记的 slug。
    // （"`documents.slug` 与 `documents.manifest.slug` 本是同一个值"由 Task 1 的构造保证，
    //   不在这一层重复证明。）
    assert.equal(basename(path), JSON.parse(manifestText).slug);
  });
});

test('正文写失败 ⇒ 不留 manifest，列表里也就看不到半份交付物', async () => {
  await withDir(async (cwd) => {
    // 写正文那一步抛错。manifest 是提交标记 ⇒ 它不该已经落盘。
    // 这条**真的能分辨写入顺序**：先写 manifest 的实现会在这里留下一个可被列举的半份。
    const failing = {
      resolve: fs.resolve,
      writeText: async (target, content) => {
        if (String(target.absolute).endsWith('v1.json')) throw new Error('写正文失败');
        await writeFile(target.absolute, content, 'utf8');
      },
    };
    await assert.rejects(() => writeDeliverable(failing, cwd, docs('20261013-045800-a', 'call_1')));
    assert.deepEqual(await listDeliverables(fs, cwd), []);
  });
});

test('列举：目录不存在 ⇒ 空数组，不抛', async () => {
  await withDir(async (cwd) => {
    assert.deepEqual(await listDeliverables(fs, cwd), []);
  });
});

test('列举：只认 manifest.format 正确的那些，别的一律跳过', async () => {
  await withDir(async (cwd) => {
    await writeDeliverable(fs, cwd, docs('20261013-045800-a', 'call_1'));
    await writeDeliverable(fs, cwd, docs('20261013-045801-b', 'call_2'));
    // 一份普通目录：不是交付物，不该被算进去
    await writeFile(join(cwd, '交付物', 'not-a-deliverable.json'), '{}', 'utf8');
    const listed = await listDeliverables(fs, cwd);
    assert.deepEqual(listed.map((entry) => entry.slug).sort(), ['20261013-045800-a', '20261013-045801-b']);
    assert.equal(listed.find((e) => e.slug === '20261013-045800-a').callId, 'call_1');
  });
});

test('反查：按 callId 找到路径；找不到给 undefined', async () => {
  await withDir(async (cwd) => {
    const path = await writeDeliverable(fs, cwd, docs('20261013-045800-a', 'call_1'));
    assert.equal(await resolveCallId(fs, cwd, 'call_1'), path);
    assert.equal(await resolveCallId(fs, cwd, 'call_nope'), undefined);
  });
});

test('反查：半份 JSON（写到一半）⇒ 跳过那一份，不抛', async () => {
  await withDir(async (cwd) => {
    const path = await writeDeliverable(fs, cwd, docs('20261013-045800-a', 'call_1'));
    await writeFile(join(path, 'manifest.json'), '{"format":"workdsh-deliv', 'utf8');
    assert.equal(await resolveCallId(fs, cwd, 'call_1'), undefined);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test packages/plugins/scene-card/tests/deliverable-store.test.mjs`
Expected: FAIL —— `Cannot find module '../dist/runtime/deliverable-store.js'`

- [ ] **Step 3: 写实现**

创建 `packages/plugins/scene-card/src/runtime/deliverable-store.ts`：

```ts
/**
 * 交付物的**文件读写**：落一份、列一批、按 `callId` 反查路径。不构造内容、不判断业务。
 *
 * 为什么反查是**扫盘**而不是记账：spec §9 待定段定的就是这条 —— 答案从磁盘上的 manifest
 * 现扫得出，进程重启后照样答得出。这跟 §2 要退休的"内存绑定账"是两件事。
 *
 * `ctx.fs` 没有 mkdir，所以建目录走 `node:fs/promises`（先例：`projects/src/runtime/project-workspace.ts`）。
 */
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DELIVERABLE_FORMAT, DELIVERABLE_SCHEMA_VERSION, type DeliverableDocuments }
  from './deliverable-document.js';

/** 工作区根下的交付物目录名（spec §3）。 */
export const DELIVERABLE_DIR = '交付物';

/** 本模块用到的 `ctx.fs` 那一小块；写成结构类型便于直测。 */
export interface StoreFs {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<unknown>;
  writeText(target: unknown, content: string): Promise<unknown>;
}

/** 一份交付物在磁盘上的位置。**纯字符串**，不碰盘。 */
export function deliverableDirOf(cwd: string, slug: string): string {
  return join(cwd, DELIVERABLE_DIR, slug);
}

/** 两空格缩进、UTF-8、结尾不加换行 —— 人直接打得开。 */
function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * 落一份交付物，返回它的目录绝对路径。目录不存在时建出来。
 *
 * **正文先写、manifest 后写**：manifest 是"这一份完整了"的**提交标记** ——
 * `listDeliverables` 正是以 manifest 为闸，先写它会让半份交付物被列出来
 * （那份的 `current` 还指不到任何文件）。
 */
export async function writeDeliverable(fs: StoreFs, cwd: string, documents: DeliverableDocuments): Promise<string> {
  const dir = deliverableDirOf(cwd, documents.slug);
  await mkdir(dir, { recursive: true });
  const current = documents.manifest.current;
  const versionFile = typeof current === 'string' && current !== '' ? current : 'v1.json';
  const version = await fs.resolve(join(dir, versionFile), { cwd });
  await fs.writeText(version, serialize(documents.version));
  const manifest = await fs.resolve(join(dir, 'manifest.json'), { cwd });
  await fs.writeText(manifest, serialize(documents.manifest));
  return dir;
}

/** 列举出来的一份（只读得懂的那几个字段；读不懂的一律跳过）。 */
export interface DeliverableEntry {
  readonly path: string;
  readonly slug: string;
  readonly callId?: string;
  readonly subject?: string;
}

/**
 * 读一份 manifest。**形状不认识就给 `undefined`** —— 与 `scheme-view.ts` 同一条严格度：
 * 正在被写（半份 JSON）、`format` 不对、主版本读不懂，都不算交付物。
 */
async function readManifest(dir: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, 'manifest.json'), 'utf8');
  } catch {
    return undefined;                      // 还没写出 / 不是目录：跳过
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;                      // 写到一半：跳过。下一次变化会自愈。
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.format !== DELIVERABLE_FORMAT) return undefined;
  // 主版本读不懂 ⇒ 整份不认（spec §3、§7）。只认 1。
  if (record.schemaVersion !== DELIVERABLE_SCHEMA_VERSION) return undefined;
  if (typeof record.slug !== 'string' || record.slug === '') return undefined;
  return record;
}

/** 列工作区里的全部交付物。目录不存在 ⇒ 空数组（spec §7：不报错、不白屏）。 */
export async function listDeliverables(fs: StoreFs, cwd: string): Promise<readonly DeliverableEntry[]> {
  const root = join(cwd, DELIVERABLE_DIR);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const out: DeliverableEntry[] = [];
  for (const name of names.sort()) {
    const dir = join(root, name);
    const manifest = await readManifest(dir);
    if (manifest === undefined) continue;
    out.push({
      path: dir,
      slug: manifest.slug as string,
      ...(typeof manifest.callId === 'string' ? { callId: manifest.callId } : {}),
      ...(typeof manifest.subject === 'string' ? { subject: manifest.subject } : {}),
    });
  }
  return out;
}

/** 按 `callId` 反查路径。找不到（还没落盘 / 不是我们写的）给 `undefined`。 */
export async function resolveCallId(fs: StoreFs, cwd: string, callId: string): Promise<string | undefined> {
  if (callId === '') return undefined;
  const entries = await listDeliverables(fs, cwd);
  return entries.find((entry) => entry.callId === callId)?.path;
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `(cd apps/web && corepack pnpm --filter workdsh-plugin-scene-card build) && node --test packages/plugins/scene-card/tests/deliverable-store.test.mjs`
Expected: PASS（7 个 test）

- [ ] **Step 5: 提交**

```bash
git add packages/plugins/scene-card/src/runtime/deliverable-store.ts packages/plugins/scene-card/tests/deliverable-store.test.mjs
git commit -m "feat(scene-card): 交付物落盘、列举与按 callId 反查"
```

---

### Task 3: 配对器（纯函数，可直测）

把"一串会话事件"变成"一次完整的工具调用"。**这一步是纯的**，因为配对逻辑最容易错，而它不该需要造一个假 Session 才能测。

**Files:**
- Create: `packages/plugins/scene-card/src/runtime/tool-call-pairing.ts`
- Test: `packages/plugins/scene-card/tests/tool-call-pairing.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface PairedCall { readonly callId: string; readonly toolName: string; readonly args: unknown; readonly result: unknown }`
  - `interface PairingInput { readonly type: string; readonly data: unknown }` —— 只要 `type` 与 `data` 两个字段，所以会话事件对象可以直接喂进来
  - `class ToolCallPairing`：
    - `note(input: PairingInput): void` —— 记一条事件
    - `take(callId: string): PairedCall | undefined` —— 取走并清除那次配好的调用
    - `latestUserMessage(): string` —— 该会话最近一条用户消息（空串表示没有）
  - `function parseJsonText(value: unknown): unknown` —— 从 `tool/result` 的 `message` 里取出那段 JSON

- [ ] **Step 1: 写失败的测试**

创建 `packages/plugins/scene-card/tests/tool-call-pairing.test.mjs`：

```js
/**
 * 配对器：`tool/call` 给名字与入参，`tool/result` 给数据，两者靠 callId 对上。
 * 为什么单独一个纯类：配对顺序、丢 call、重复 result 这几个错法最容易漏，而它们不需要真会话就能测。
 * 跑法：node --test packages/plugins/scene-card/tests/tool-call-pairing.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallPairing, parseJsonText } from '../dist/runtime/tool-call-pairing.js';

const call = (callId, name, args) => ({
  type: 'tool/call',
  data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) },
});

/** `tool/result` 的形状：顶层**既无 callId 也无 name**，id 落在 message.source.callId。 */
const result = (callId, payload) => ({
  type: 'tool/result',
  data: { turn: 1, step: 1,
    message: { role: 'tool', source: { kind: 'tool', callId },
      toolCallId: callId, content: [{ type: 'text', text: JSON.stringify(payload) }] } },
});

const userMessage = (text) => ({ type: 'user/message', data: { message: { role: 'user',
  content: [{ type: 'text', text }] } } });

test('call 之后 result ⇒ 配得上一对，两个字段都在', () => {
  const pairing = new ToolCallPairing();
  pairing.note(call('c1', 'mcp__geoclar__geoclar_recommend_schemes', { wkt: 'W' }));
  pairing.note(result('c1', { mode: 'custom' }));
  const paired = pairing.take('c1');
  assert.equal(paired.toolName, 'mcp__geoclar__geoclar_recommend_schemes');
  assert.deepEqual(paired.args, { wkt: 'W' });
  assert.deepEqual(paired.result, { mode: 'custom' });
});

test('take 之后清除：同一 callId 不会配出第二次', () => {
  const pairing = new ToolCallPairing();
  pairing.note(call('c1', 't', {}));
  pairing.note(result('c1', { a: 1 }));
  assert.ok(pairing.take('c1'));
  assert.equal(pairing.take('c1'), undefined);
});

test('只有 result 没有 call（窗口截断）⇒ 取不到，而不是拼半份', () => {
  const pairing = new ToolCallPairing();
  pairing.note(result('c9', { a: 1 }));
  assert.equal(pairing.take('c9'), undefined);
});

test('只有 call 没有 result（还在跑）⇒ 取不到', () => {
  const pairing = new ToolCallPairing();
  pairing.note(call('c1', 't', {}));
  assert.equal(pairing.take('c1'), undefined);
});

test('入参不是 JSON ⇒ 整个配对放弃，不拿半个入参去写文件', () => {
  const pairing = new ToolCallPairing();
  pairing.note({ type: 'tool/call', data: { callId: 'c1', name: 't', arguments: '不是 JSON' } });
  pairing.note(result('c1', { a: 1 }));
  assert.equal(pairing.take('c1'), undefined);
});

test('结果里那段文本不是 JSON ⇒ 放弃', () => {
  const pairing = new ToolCallPairing();
  pairing.note(call('c1', 't', {}));
  pairing.note({ type: 'tool/result', data: { message: { source: { callId: 'c1' },
    content: [{ type: 'text', text: '不是 JSON' }] } } });
  assert.equal(pairing.take('c1'), undefined);
});

test('用户消息被记住，取最近一条', () => {
  const pairing = new ToolCallPairing();
  pairing.note(userMessage('第一句'));
  pairing.note(userMessage('霍尔木兹海峡近三月影像组合'));
  assert.equal(pairing.latestUserMessage(), '霍尔木兹海峡近三月影像组合');
});

test('没有用户消息时给空串（调用方据此退回时间戳）', () => {
  assert.equal(new ToolCallPairing().latestUserMessage(), '');
});

test('parseJsonText：单块 text 才认，多块/非 text 一律不认', () => {
  assert.deepEqual(parseJsonText({ content: [{ type: 'text', text: '{"a":1}' }] }), { a: 1 });
  assert.equal(parseJsonText({ content: [{ type: 'text', text: '{}' }, { type: 'text', text: '{}' }] }), undefined);
  assert.equal(parseJsonText({ content: [{ type: 'image', text: '{}' }] }), undefined);
  assert.equal(parseJsonText({}), undefined);
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test packages/plugins/scene-card/tests/tool-call-pairing.test.mjs`
Expected: FAIL —— `Cannot find module '../dist/runtime/tool-call-pairing.js'`

- [ ] **Step 3: 写实现**

创建 `packages/plugins/scene-card/src/runtime/tool-call-pairing.ts`：

```ts
/**
 * 把会话事件流里的 `tool/call` 与 `tool/result` 配成一对。**纯逻辑**，不碰 ctx、不碰盘。
 *
 * 为什么必须配对（spec §4）：`tool/result` 的载荷里**既无工具名也无顶层 callId** ——
 * 名字在配对的 `tool/call` 上，id 埋在 `message.source.callId` 里。所以"先认 call、再等 result"。
 *
 * 为什么不按 `sourceEventSeqs` 配：那需要访问事件的 seq 与事件表，而本类只吃 `{type, data}` 两个字段
 * （会话事件对象直接喂得进来）。按 `callId` 配对的错法在这里被测试逐条钉住，够用。
 *
 * 输入是**运行时数据**，形状没有保证：读不懂就放弃这一次，绝不拼半份。
 */

export interface PairedCall {
  readonly callId: string;
  readonly toolName: string;
  /** `tool/call` 的 arguments，**已解析**。 */
  readonly args: unknown;
  /** `tool/result` 里那段 JSON，**已解析**。 */
  readonly result: unknown;
}

/** 事件里本类用到的部分；会话事件对象直接喂。 */
export interface PairingInput {
  readonly type: string;
  readonly data: unknown;
}

interface PendingCall {
  readonly toolName: string;
  readonly args: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 从结果的那块内容里取出 JSON。**只在恰好一块、且是 text 时**认 ——
 * 多块就意味着这次结果不止一段 JSON，猜哪一段都是编。
 */
export function parseJsonText(message: unknown): unknown {
  if (!isRecord(message)) return undefined;
  const content = message.content;
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const only = content[0];
  if (!isRecord(only) || only.type !== 'text' || typeof only.text !== 'string') return undefined;
  try {
    return JSON.parse(only.text);
  } catch {
    return undefined;
  }
}

/** `tool/call` 的 `arguments` 是一段 JSON 文本；解析不了就整次放弃。 */
function parseArguments(raw: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof raw !== 'string') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/**
 * `tool/result` 里那个配对 id：顶层没有，落在 `message.source.callId`（退回 `message.toolCallId`）。
 *
 * **导出**：生产者也要读同一个 id（`deliverable-producer.ts`）。这条读法最容易写错（id 埋在
 * `message` 里而不是顶层），两处各写一份必然漂移。
 */
export function callIdOfResult(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const message = data.message;
  if (!isRecord(message)) return undefined;
  const source = message.source;
  if (isRecord(source) && typeof source.callId === 'string' && source.callId !== '') return source.callId;
  const direct = message.toolCallId;
  return typeof direct === 'string' && direct !== '' ? direct : undefined;
}

/** 从用户消息里取第一段文本（subject 的来源，spec §9.4）。 */
function textOfUserMessage(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const message = data.message;
  const parsed = parseJsonText(message);
  if (typeof parsed === 'string') return parsed;
  if (!isRecord(message)) return undefined;
  const content = message.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      return block.text;
    }
  }
  return undefined;
}

/**
 * 一个会话的配对器。**每个会话一个实例** —— callId 只在会话内唯一。
 *
 * 待配的 call 只保留最近 `MAX_PENDING` 条：一次会话里排队的调用不该无界增长，
 * 而超出的那些本来就是"很久没等到 result"的，丢了也不影响正确性（取不到就不落）。
 */
const MAX_PENDING = 64;

export class ToolCallPairing {
  private readonly pending = new Map<string, PendingCall>();
  private readonly settled = new Map<string, unknown>();
  private userMessage = '';

  note(input: PairingInput): void {
    // 用户消息也走这条流 —— 生产者订阅的是**全部**事件，所以 subject 是顺手就有，
    // 不必另问一次会话服务（spec §9.4 原本列为待核，这里解决）。
    if (input.type === 'user/message') {
      const text = textOfUserMessage(input.data);
      if (text !== undefined) this.userMessage = text;
      return;
    }
    if (input.type === 'tool/call') {
      if (!isRecord(input.data)) return;
      const callId = input.data.callId;
      const name = input.data.name;
      if (typeof callId !== 'string' || callId === '' || typeof name !== 'string') return;
      const parsed = parseArguments(input.data.arguments);
      if (!parsed.ok) return;                       // 入参读不懂 ⇒ 这次不落，别拿半个入参去写文件
      this.pending.set(callId, { toolName: name, args: parsed.value });
      if (this.pending.size > MAX_PENDING) {
        const oldest = this.pending.keys().next();
        if (!oldest.done) this.pending.delete(oldest.value);
      }
      return;
    }
    if (input.type === 'tool/result') {
      const callId = callIdOfResult(input.data);
      if (callId === undefined) return;
      const payload = parseJsonText(isRecord(input.data) ? input.data.message : undefined);
      if (payload === undefined) return;            // 结果读不懂 ⇒ 放弃
      if (!this.pending.has(callId)) return;        // 没有配对的 call（窗口截断）：不拼半份
      this.settled.set(callId, payload);
    }
  }

  /** 取走并清除一次配好的调用。没配齐 / 已取过 ⇒ `undefined`。 */
  take(callId: string): PairedCall | undefined {
    const pending = this.pending.get(callId);
    const result = this.settled.get(callId);
    if (pending === undefined || result === undefined) return undefined;
    this.pending.delete(callId);
    this.settled.delete(callId);
    return { callId, toolName: pending.toolName, args: pending.args, result };
  }

  /** 该会话最近一条用户消息；没有时是空串（调用方据此退回只用时间戳）。 */
  latestUserMessage(): string {
    return this.userMessage;
  }
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `(cd apps/web && corepack pnpm --filter workdsh-plugin-scene-card build) && node --test packages/plugins/scene-card/tests/tool-call-pairing.test.mjs`
Expected: PASS（9 个 test）

- [ ] **Step 5: 提交**

```bash
git add packages/plugins/scene-card/src/runtime/tool-call-pairing.ts packages/plugins/scene-card/tests/tool-call-pairing.test.mjs
git commit -m "feat(scene-card): 会话事件配对器（tool/call ↔ tool/result，含 subject 来源）"
```

---

### Task 4: 生产者（接线到会话事件流）

> **⚠ 本节的测试代码有错，施工前必须先读这里。**（本任务是全计划里唯一一份"照做会把文件写到仓根"的 brief。）
>
> 1. **假 `fs` 少三个方法，而且是危险的。** 本节写的 `fs` 只有 `resolve` 与 `writeText`。Task 2 的评审把 `StoreFs` 加宽成了 `{ resolve, writeText, listDir, readText, processPath }`，缺任何一个都会让 `writeDeliverable` 抛 `TypeError` —— 而这个错会被生产者自己的 `.catch` 咽成一条日志，**看起来像"目录不存在所以没写"**，去重闸门也根本走不到。更糟的是：只补 `processPath` 而不补 `cwd` 语义，会把文件写到**进程 cwd**（实测把 `manifest.json` / `v1.json` / `交付物/` 落到了仓根）。
>    **改用 `deliverable-store.test.mjs` 里那份完整的薄壳**，它已经过评审。
> 2. **`settle` 用 `setTimeout(0)` 是 flaky 的。** 实测 100 次只有 76 次看得见文件；改成 3 拍单独跑够、整套并行仍偶发红。**改成条件等待**：等到 manifest（提交标记）出现且通道静默，而不是等固定拍数。
> 3. **用例 2 不钉行为。** 抽掉去重闸它照样绿 —— 同一秒的 slug 相同，所以"重复写"只是覆盖同一份。要在用例内补一条**manifest 字节未变**的断言，否则去重没有测试保护。
>
> 另：`take` 必须**在同一个 `tool/result` 事件里同步调用**（Task 3 的上界安全论证依赖它）。变异测试显示"把 take 挪进微任务"**整套仍绿** —— 说明这条约束当时无测试保护；已要求补一条"突发灌入 N 对、N 份全部落盘"的用例。
>
> **本节已完成（`d98d1082b0..c59be876b9`），评审与复评均通过。除上面三条 brief 错误外，实现最终还比本节代码多了四项 —— 读本节时一并覆盖：**
>
> 4. **工具名闸**：`PRODUCER_TOOL = 'geoclar_recommend_schemes'`，用 `bareToolName(paired.toolName)` 比对（**不可写死 `mcp__geoclar__`**，连接器名是部署配置的），位置在 `take` 之后、微任务之前，不匹配时**静默**返回。为此 `deliverable-document.ts` 的 `bareToolName` 加了 `export`（该文件唯一的改动）。
> 5. **slug 撞名消歧**：slug 是 `YYYYMMDD-HHmmss-<subject>`，同一秒同 subject 的两个不同 callId 会落进同一目录、后者静默覆盖前者（违反"不归并"）。`freeSlug` 用**已有的那次列举**（去重同源地）找空位、退 `-2`/`-3`…，并**同时改 `documents.slug` 与 `documents.manifest.slug`** —— Task 2 的位置闸会拒掉只改一边的，那比冲突更糟。后缀仍守 64 码点。
> 6. **`subject`/`at` 在同步点捕获**（事件到达时），不在微任务里读 —— 否则窗口内到达的新用户消息会串成上一条的 subject。
> 7. **落盘串行化**：模块级 `writeChain`，每份 `writeChain = writeChain.then(body).catch(noteWriteFailure).catch(() => {})`。最后那个 catch **只为吸收处理器自身的抛出**（`logger.warn` 是宿主代码可能抛；`String(cause)` 对 `toString` 会炸的对象也抛），**别当冗余删掉** —— 没有它，处理器一抛就把链留成 rejected，之后每一份交付物被永久跳过、静默丢失。
>    已知代价（接受并留档）：串行是**进程级**的（撞名域是工作区目录），一次**挂住**的 fs 调用会让后面每一份排队等；`ctx.fs.writeText` 本就接受 `AbortSignal`，所以将来要修只需定策略值，不必发明机制。
>
> 测试从 4 条增至 11 条。四条裁定各自都有能分辨的用例（变异逐条只红对应那条）。



**Files:**
- Create: `packages/plugins/scene-card/src/runtime/deliverable-producer.ts`
- Test: `packages/plugins/scene-card/tests/deliverable-producer.test.mjs`

**Interfaces:**
- Consumes: Task 1 `buildDeliverableDocuments`、Task 2 `writeDeliverable`、Task 3 `ToolCallPairing`
- Produces:
  - `function registerDeliverableProducer(ctx: ProducerContext): void`
  - `interface ProducerContext { readonly fs: StoreFs; on(event: 'session/event', handler: (session: SessionLike, event: PairingInput) => void): void; readonly logger: (name: string) => { warn(message: string): void } }`
  - `interface SessionLike { readonly id: unknown; readonly header?: { readonly cwd?: string } }`

- [ ] **Step 1: 写失败的测试**

创建 `packages/plugins/scene-card/tests/deliverable-producer.test.mjs`：

```js
/**
 * 生产者：事件进 → 文件出。用假 ctx + 真临时目录，测的是"真的落了盘、内容对"。
 * 跑法：node --test packages/plugins/scene-card/tests/deliverable-producer.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerDeliverableProducer } from '../dist/runtime/deliverable-producer.js';

const fs = {
  resolve: async (path) => ({ targetKey: path, absolute: path }),
  writeText: async (target, content) => { await writeFile(target.absolute, content, 'utf8'); },
};

const payload = { mode: 'custom', poolAtLimit: false,
  schemes: [{ key: 'CUSTOM', sceneCount: 235 }] };

const events = (callId, args) => [
  { type: 'user/message', data: { message: { content: [{ type: 'text', text: '霍尔木兹海峡' }] } } },
  { type: 'tool/call', data: { callId, name: 'mcp__geoclar__geoclar_recommend_schemes',
    arguments: JSON.stringify(args) } },
  { type: 'tool/result', data: { message: { source: { kind: 'tool', callId },
    content: [{ type: 'text', text: JSON.stringify(payload) }] } } },
];

/** 装一个假 ctx，把 on 收到的 handler 抓住，返回一个"喂事件"的函数。 */
function harness(cwd, warnings = []) {
  let handler;
  registerDeliverableProducer({
    fs,
    on: (name, fn) => { assert.equal(name, 'session/event'); handler = fn; },
    logger: () => ({ warn: (message) => { warnings.push(message); } }),
  });
  const session = { id: 'sess-1', header: { cwd } };
  return {
    feed: (event) => handler(session, event),
    /** 生产者把落盘挂在 `queueMicrotask` 上（不阻塞会话提交），喂完等一拍。 */
    settle: () => new Promise((resolve) => { setTimeout(resolve, 0); }),
  };
}

async function withDir(body) {
  const cwd = await mkdtemp(join(tmpdir(), 'wd-producer-'));
  try { await body(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

test('一串事件 ⇒ 恰好落一份，目录名与 manifest 符合约定', async () => {
  await withDir(async (cwd) => {
    const h = harness(cwd);
    for (const event of events('call_1', { wkt: 'POLYGON EMPTY', maxCloud: 20 })) h.feed(event);
    await h.settle();
    const names = await readdir(join(cwd, '交付物'));
    assert.equal(names.length, 1);
    const manifest = JSON.parse(await readFile(join(cwd, '交付物', names[0], 'manifest.json'), 'utf8'));
    assert.equal(manifest.callId, 'call_1');
    assert.equal(manifest.subject, '霍尔木兹海峡');
    const version = JSON.parse(await readFile(join(cwd, '交付物', names[0], 'v1.json'), 'utf8'));
    assert.deepEqual(version.payload, payload);
    assert.deepEqual(version.intent.conditions, { maxCloud: 20 });
  });
});

test('同一个 callId 再来一次 result ⇒ 不落第二份', async () => {
  await withDir(async (cwd) => {
    const h = harness(cwd);
    const list = events('call_1', { wkt: 'W' });
    for (const event of list) h.feed(event);
    await h.settle();
    for (const event of list) h.feed(event);     // 重放
    await h.settle();
    assert.equal((await readdir(join(cwd, '交付物'))).length, 1);
  });
});

test('会话没有 cwd ⇒ 不落盘，且记一条日志（spec §7）', async () => {
  await withDir(async (cwd) => {
    const warnings = [];
    let handler;
    registerDeliverableProducer({ fs,
      on: (_name, fn) => { handler = fn; },
      logger: () => ({ warn: (message) => { warnings.push(message); } }) });
    const session = { id: 's2', header: {} };
    for (const event of events('call_1', { wkt: 'W' })) handler(session, event);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /没有 cwd/);
    assert.deepEqual(await readdir(join(cwd, '交付物')).catch(() => []), []);
  });
});

test('形状不认识 ⇒ 不落盘、不打日志噪音', async () => {
  await withDir(async (cwd) => {
    const warnings = [];
    const h = harness(cwd, warnings);
    h.feed({ type: 'tool/call', data: { callId: 'c', name: 't', arguments: '{"wkt":"W"}' } });
    h.feed({ type: 'tool/result', data: { message: { source: { callId: 'c' },
      content: [{ type: 'text', text: JSON.stringify({ mode: '别的' }) }] } } });
    await h.settle();
    assert.deepEqual(await readdir(join(cwd, '交付物')).catch(() => []), []);
    assert.equal(warnings.length, 0);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test packages/plugins/scene-card/tests/deliverable-producer.test.mjs`
Expected: FAIL —— `Cannot find module '../dist/runtime/deliverable-producer.js'`

- [ ] **Step 3: 写实现**

创建 `packages/plugins/scene-card/src/runtime/deliverable-producer.ts`：

```ts
/**
 * 生产者（spec §4）：**不经模型判断、不经用户操作** —— 工具返回方案的那一刻就把交付物落到工作区。
 *
 * 两条与先例一致的做法（`projects/src/runtime/deliverable-attribution.ts`）：
 *   · 订阅挂在**根 context**上，监听**全部**会话（agent-scoped 只听自己进入的会话，spec §4）；
 *   · 监听器**立刻返回**，落盘在微任务里跑 —— 一次慢写不该拖住别人的会话提交。
 *
 * 每个会话一个配对器（callId 只在会话内唯一），随会话第一次出现时创建。
 */
import { buildDeliverableDocuments } from './deliverable-document.js';
import { resolveCallId, writeDeliverable, type StoreFs } from './deliverable-store.js';
import { callIdOfResult, ToolCallPairing, type PairingInput } from './tool-call-pairing.js';

/** 会话对象里本模块用到的部分。 */
export interface SessionLike {
  readonly id: unknown;
  readonly header?: { readonly cwd?: string } | undefined;
}

export interface ProducerContext {
  readonly fs: StoreFs;
  on(event: 'session/event', handler: (session: SessionLike, event: PairingInput) => void): void;
  readonly logger: (name: string) => { warn(message: string): void };
}

export function registerDeliverableProducer(ctx: ProducerContext): void {
  const logger = ctx.logger('workdsh-scene-card');
  /** 会话 id → 配对器。会话数量有界（一次进程的活跃会话），不必淘汰。 */
  const pairings = new Map<string, ToolCallPairing>();

  ctx.on('session/event', (session, event) => {
    const sessionId = String(session.id);
    let pairing = pairings.get(sessionId);
    if (pairing === undefined) {
      pairing = new ToolCallPairing();
      pairings.set(sessionId, pairing);
    }
    pairing.note(event);
    if (event.type !== 'tool/result') return;

    // 只有"刚配齐"的那次才继续；其余的（还在跑、读不懂、已取过）在这里就被挡掉。
    const callId = callIdOfResult(event.data);
    if (callId === undefined) return;
    const paired = pairing.take(callId);
    if (paired === undefined) return;

    // 立刻返回，落盘在微任务里跑 —— 慢写不拖住会话提交。
    void Promise.resolve().then(async () => {
      const cwd = session.header?.cwd;
      if (cwd === undefined || cwd === '') {
        // spec §7：会话没有 cwd（持久化层把这类会话落进 _no-cwd）⇒ 记一条日志，不抛。
        logger.warn('交付物跳过：会话没有 cwd');
        return;
      }
      const documents = buildDeliverableDocuments({
        callId: paired.callId, toolName: paired.toolName, args: paired.args, result: paired.result,
        subject: pairing.latestUserMessage(), at: new Date(),
      });
      // 形状读不懂 ⇒ 这次不落。**不记日志**：那是"这个工具返回了别的东西"，不是异常。
      if (documents === undefined) return;
      // 同一个 callId 已经落过（重复的 result 事件）⇒ 不落第二份。
      if (await resolveCallId(ctx.fs, cwd, paired.callId) !== undefined) return;
      await writeDeliverable(ctx.fs, cwd, documents);
    }).catch((cause: unknown) => {
      // 落盘失败不该冒到会话事件流上：流是 fire-and-forget，别人还在提交。
      logger.warn(`交付物落盘失败：${cause instanceof Error ? cause.message : String(cause)}`);
    });
  });
}

// 配对 id 的读法只有一份：`callIdOfResult`（从 `tool-call-pairing.js` 导入）。

```

- [ ] **Step 4: 跑测试，确认通过**

Run: `(cd apps/web && corepack pnpm --filter workdsh-plugin-scene-card build) && node --test packages/plugins/scene-card/tests/deliverable-producer.test.mjs`
Expected: PASS（4 个 test）

- [ ] **Step 5: 提交**

```bash
git add packages/plugins/scene-card/src/runtime/deliverable-producer.ts packages/plugins/scene-card/tests/deliverable-producer.test.mjs
git commit -m "feat(scene-card): Host 半区交付物生产者（工具返回即落盘）"
```

---

### Task 5: 接线与宿主路由

> **⚠ 本节的路由契约已在终审后被改掉，读下面代码前先看这里。**（本任务已完成：`286fff0045` + `b01453d648`，终审的修复波为 `921c74a286`。）
>
> 1. **路由不接受请求里的 `cwd`。** 本节写的 `payload: { action, sessionId, cwd }` 是错的 —— 由调用者**指定**工作区，就能列举任意路径下的 `交付物/*/manifest.json`。终审还查明：**仓里没有任何客户端代码读 `header.cwd`**，所以那个参数下游根本拿不到。
>    **改成**：按 `sessionId` 由**宿主**解析会话的 `header.cwd`（与 `dsh-api-workspace-files` 的 `workspaceFileScope` 同源，也正是生产者写盘用的那个根）。错误分类也要跟着改：**认不出会话 → 400 `scene-card/unknown-session`**（不要回空列表，那会被读成"一份都没有"）；有会话但无 cwd → 如实回空；缺 `fs` → 503 并说明原因。
> 2. **`fs` 不能加在导出级 `inject` 上。** cordis 的注入语义是"**等到齐**"，所以导出级加了 `fs`，在没有 fs 的组合里**整个插件都不生效**，连带把既有的 `portal` 端点静默干掉。而且**只把它从导出级删掉仍然不够** —— 路由原先与生产者同层，仍在 fs 闸后面。**正解**：路由留在**只依赖 `connection`** 的那层，生产者单独 `ctx.inject(['fs'])`。先例：`projects/src/index.ts:10` vs `:21`。
> 3. **适配层的理由订正**（行为不变，仍是显式构造）：真正的理由是**让生产者的边界在测试里可构造** —— 假 `ProducerContext` 满足不了 cordis 完整的 `Context`，直接传 `ctx` 会让调用点不可测。原写的"结构上未必可赋值"**不成立**（实测直接传能编译）。
> 4. **测试 3 条 → 15 条**：补齐了"生产者确实被挂载""适配层转发保真（`fs`/`on`/`logger` 三面各自可观测）""`cwd` 经由会话解析后真的落到存储"这三类判别用例。


把生产者挂进 `index.ts`，并在既有的 `/api/workdsh-scene-card` 上加 `deliverables` 端点（`list` 与 `resolve`）。**这一步是本计划的可验收边界**：做完之后，真机跑一次检索就能在 `交付物/` 下看到文件。

**Files:**
- Modify: `packages/plugins/scene-card/src/index.ts`
- Test: `packages/plugins/scene-card/tests/scene-card-host.test.mjs`（追加用例）

**Interfaces:**
- Consumes: Task 2 的 `listDeliverables` / `resolveCallId`、Task 4 的 `registerDeliverableProducer`
- Produces: 路由端点
  - 请求 `{ endpoint: 'deliverables', payload: { action: 'list', sessionId, cwd } }` → `{ ok: true, value: { entries: [...] } }`
  - 请求 `{ endpoint: 'deliverables', payload: { action: 'resolve', sessionId, cwd, callId } }` → `{ ok: true, value: { path: string | null } }`

- [ ] **Step 1: 写失败的测试**

在 `packages/plugins/scene-card/tests/scene-card-host.test.mjs` 末尾追加（该文件已有 `host(options)` 与 `request(body)` 两个助手；把 `host` 扩成也接受 `fs` 与 `sessions`）：

```js
test('deliverables/resolve：没有这个 callId ⇒ path 为 null，不是报错', async () => {
  const entry = await host({}, { fs: emptyFs, sessions: new Map() });
  const response = await entry.fetch(request({ endpoint: 'deliverables',
    payload: { action: 'resolve', sessionId: 's1', cwd: '/tmp/none', callId: 'call_x' } }));
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.value.path, null);
});

test('deliverables：未知 action ⇒ 400，且错误码稳定', async () => {
  const entry = await host({}, { fs: emptyFs, sessions: new Map() });
  const response = await entry.fetch(request({ endpoint: 'deliverables',
    payload: { action: '别的', sessionId: 's1', cwd: '/tmp/none' } }));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, 'scene-card/invalid-request');
});

test('deliverables/list：目录不存在 ⇒ 空数组', async () => {
  const entry = await host({}, { fs: emptyFs, sessions: new Map() });
  const response = await entry.fetch(request({ endpoint: 'deliverables',
    payload: { action: 'list', sessionId: 's1', cwd: '/tmp/none' } }));
  const body = await response.json();
  assert.deepEqual(body.value.entries, []);
});
```

文件顶部补两个替身（`emptyFs` 用真临时目录也行，但这一层测的是路由契约，用空实现更快）：

```js
const emptyFs = {
  resolve: async (path) => ({ targetKey: path, absolute: path }),
  writeText: async () => {},
};
```

并把 `host(options)` 改成 `host(options, extras = {})`，把 `extras.fs` 与 `extras.sessions` 塞进那个假 `child` 对象，使 `apply` 拿到它们。

- [ ] **Step 2: 跑测试，确认失败**

Run: `(cd apps/web && corepack pnpm --filter workdsh-plugin-scene-card build) && node --test packages/plugins/scene-card/tests/scene-card-host.test.mjs`
Expected: FAIL —— `deliverables` 走到未知请求分支，`body.value` 为 `undefined`

- [ ] **Step 3: 写实现**

改 `packages/plugins/scene-card/src/index.ts`：

1. `inject` 加上 `'fs'`，`SceneCardOptions` 不变；
2. `apply` 里多传一层：子插件 `inject: ['connection', 'fs']`，`apply` 时先挂生产者、再挂路由：

```ts
    apply: (integration: Context) => {
      // **不要**把 cordis 的 `ctx` 直接当 `ProducerContext` 传：它的 `on` 是泛型 + 重载的，
      // 与简化签名的结构类型未必可赋值。显式构造一层适配，把不确定性收在这一处
      // （与 `deliverable-attribution.ts` 在内部构造 `deps` 是同一手法）。
      registerDeliverableProducer({
        fs: integration.fs as unknown as StoreFs,
        on: (event, handler) => {
          integration.on(event, (session, payload) => {
            handler(session as unknown as SessionLike, payload as unknown as PairingInput);
          });
        },
        logger: (name) => integration.logger(name),
      });
      registerSceneCardConnection(integration, options);
    },
```
3. `registerSceneCardConnection` 的 `fetch` 里加一个分支：

```ts
      const body = record(await request.json());
      if (body?.endpoint === 'portal') {
        return Response.json(ok({ portalOrigin: portalOrigin ?? null }),
          { headers: { 'cache-control': 'no-store' } });
      }
      if (body?.endpoint === 'deliverables') {
        const payload = record(body.payload);
        const cwd = typeof payload?.cwd === 'string' ? payload.cwd : undefined;
        if (cwd === undefined || cwd === '') {
          return Response.json(fail('scene-card/invalid-request', '缺少工作区根。'), { status: 400 });
        }
        const fs = (ctx as Context & { fs: StoreFs }).fs;
        if (payload?.action === 'list') {
          return Response.json(ok({ entries: await listDeliverables(fs, cwd) }),
            { headers: { 'cache-control': 'no-store' } });
        }
        if (payload?.action === 'resolve') {
          const callId = typeof payload.callId === 'string' ? payload.callId : '';
          const path = await resolveCallId(fs, cwd, callId);
          return Response.json(ok({ path: path ?? null }),
            { headers: { 'cache-control': 'no-store' } });
        }
        return Response.json(fail('scene-card/invalid-request', '未知的交付物面板请求。'), { status: 400 });
      }
      return Response.json(fail('scene-card/invalid-request', '未知的交付物面板请求。'), { status: 400 });
```

顶部补导入：

```ts
import { listDeliverables, resolveCallId, type StoreFs } from './runtime/deliverable-store.js';
import { registerDeliverableProducer, type SessionLike } from './runtime/deliverable-producer.js';
import type { PairingInput } from './runtime/tool-call-pairing.js';
```

> **注意**：`cwd` 由客户端上送，是**该会话的工作区根**。这一版直接信它 —— 它只用来读同源工作区里的一个固定目录，且路由本身已经在 `connection.fetch` 的信任边界之内（`rpc.d.ts`：handler 跑在"物理载体已施加信任与认证策略"之后）。**不要**据此扩展成任意路径读写。

- [ ] **Step 4: 跑测试，确认通过**

Run: `(cd apps/web && corepack pnpm --filter workdsh-plugin-scene-card build) && node --test packages/plugins/scene-card/tests/scene-card-host.test.mjs`
Expected: PASS（原有用例 + 3 个新用例）

- [ ] **Step 5: 跑本插件的全部测试**

Run: `node --test packages/plugins/scene-card/tests/`
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add packages/plugins/scene-card/src/index.ts packages/plugins/scene-card/tests/scene-card-host.test.mjs
git commit -m "feat(scene-card): 接线生产者，宿主路由加 deliverables 端点"
```

---

### Task 6: 接进 CI 白名单并跑仓库门

**Files:**
- Modify: `.github/workflows/*`（scene-card 单测所在的那条白名单；上一次同类改动见 `68209d3638`）

**Interfaces:**
- Consumes: 无
- Produces: 无（仓库门）

- [ ] **Step 1: 找到白名单**

Run: `git show 68209d3638 --stat` 与 `git show 68209d3638`
Expected: 看到上次把 scene-card 单测接进白名单改的是哪个文件、哪个列表。

- [ ] **Step 2: 按同一形状补上新测试文件**

把 `tests/deliverable-document.test.mjs`、`tests/deliverable-store.test.mjs`、`tests/tool-call-pairing.test.mjs`、`tests/deliverable-producer.test.mjs` 加进同一个列表。

- [ ] **Step 3: 跑仓库门**

Run: `corepack yarn check`
Expected: 全绿。若 `check:desktop-dsh-alignment` / `check:web-dsh-alignment` 之类与本改动无关的门失败，记录并**不要**在本次顺手改版本。

然后跑**本插件自己的**两道门（根 `check` 不覆盖它，见 Global Constraints）：

```bash
(cd apps/web && corepack pnpm --filter workdsh-plugin-scene-card typecheck)
(cd apps/web && corepack pnpm --filter workdsh-plugin-scene-card test)
```

- [ ] **Step 4: 提交**

```bash
git add .github/workflows
git commit -m "ci(scene-card): 把交付物生产侧的四份单测接进白名单"
```

---

## Self-Review

**Spec 覆盖**

| spec 要求 | 落在哪 |
|---|---|
| §3 格式（manifest + v1.json 字段） | Task 1（含 `schemaVersion`、`callId`） |
| §3 `intent` 逐字抄入参 | Task 1 `conditionsOf` + `CONDITION_KEYS`，用例钉"未给的不出现" |
| §4 配对（callId、无工具名） | Task 3 |
| §4 root context / 立即返回 | Task 4（订阅在根 ctx，落盘挂微任务） |
| §4 意图从 `tool/call` 抄 | Task 3 `parseArguments` → Task 4 → Task 1 |
| §7 `format` 不对不碰 / 主版本读不懂不认 / 半份 JSON / 无 cwd 记日志 | Task 2 `readManifest`、Task 4 无 cwd 分支，各有用例 |
| §9.2 落盘边界是"有没有 cwd" | Task 4 无 cwd 用例 |
| §9.4 `subject` 来源 | Task 3 `user/message` + `latestUserMessage`，有用例 |
| §9 待定：路由反查 callId→path | Task 2 `resolveCallId` + Task 5 路由 |
| §11 payload 不含供应商字段 | 全局约束 + Task 1 只透传出参（不做字段提取） |

**明确不在本计划**（消费侧，另立计划）：面板改绑 path、`changes` 订阅、自动弹重做、`openedThisTurn` 语义重定义、`panel-binding.ts` / `turn-tools.ts` 退休。

**类型与命名一致性**（自查过）：`DeliverableDocuments` / `StoreFs` / `PairedCall` / `PairingInput` / `SessionLike` 在各任务间同名同形；`DELIVERABLE_FORMAT`、`DELIVERABLE_SCHEMA_VERSION`、`DELIVERABLE_DIR` 只在 Task 1/2 定义，后续引用不重复定义；`buildDeliverableDocuments` 的入参字段（`callId`/`toolName`/`args`/`result`/`subject`/`at`）在 Task 4 的调用点一一对上。

**两处留给实现者的判断**（已写明，不是占位符）：
1. Task 5 的 `cwd` 由客户端上送、这一版直接信它 —— 理由与边界都写在任务的注意块里。
2. Task 6 的 CI 白名单文件路径要按 `68209d3638` 的实际改动确认 —— 步骤里给了怎么查。
