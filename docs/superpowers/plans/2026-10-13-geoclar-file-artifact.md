# 交付物即 `.geoclar` 文件 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 一份交付物 = 一个 `.geoclar` 文件；工具返回时落盘并发事件，对话当轮露出卡片，点开在右侧按现有渲染逻辑呈现；旧的 toolview 卡与 callId 绑定那套拆掉。

**Architecture:** 四段。① 生产者改写文件名与事件载荷（已实现的代码，改动小）；② `turnTail` 卡片（新挂载点，不在折叠区）；③ tab 注册加 `patterns`（同一处改动）；④ 面板从 `navigation.address` 解析路径、按 `dsh-resource://file/…` 读文件喂给**不改一行**的 `scheme-view.ts`。

**Tech Stack:** TypeScript（ESM，`.js` 后缀导入）、cordis 插件（`ctx.fs` / `ctx.on('session/event')` / `ctx.slots.register` / `ctx.sidebarRightTabs`）、`node --test`。

**Spec:** `docs/superpowers/specs/2026-10-13-geoclar-file-artifact-design.md`

## Global Constraints

- **渲染逻辑一行不改**：`scheme-view.ts` 的视图模型、`SchemeMetrics`、`DeliverablePanel` 的六块与页脚全部保留，只换数据来源。
- **扩展名 `.geoclar`**，`patterns: ['*.geoclar']`。**不要**改成别的名字，也不要写死 `mcp__geoclar__`（新形态不依赖那个硬编码键）。
- **先写 `<slug>.tmp`、成功后 `rename` 成 `.geoclar`** —— 扩展名本身即"写完了"的标记，取代原先"manifest 后写"的约定。
- **`format` 不对 / 主版本读不懂 ⇒ 不碰**，一个字节都不读；`type` 不认识 ⇒ 不画那块的渲染。**绝不渲染半张**。
- 落盘失败**只记日志**，不让异常冒到会话事件流上；串行落盘链（`writeChain`）保留。
- 构建/测试（**仓根**执行；根 `corepack yarn build` **不**构建本插件）：
  ```
  (cd apps/web && corepack pnpm --filter workdsh-plugin-scene-card build) && node --test packages/plugins/scene-card/tests/<file>.mjs
  ```
- 新增文件用 `feat/` 或 `fix/` 分支，合回 main 用合并提交。

---

### Task 1: 落盘改成单个 `.geoclar`（生产者 + 存储层）

**Files:**
- Modify: `packages/plugins/scene-card/src/runtime/deliverable-document.ts`（manifest 与 version 合并成一个对象）
- Modify: `packages/plugins/scene-card/src/runtime/deliverable-store.ts`（文件名、列举、反查）
- Test: `packages/plugins/scene-card/tests/deliverable-document.test.mjs`、`deliverable-store.test.mjs`

**Interfaces:**
- Consumes: Task 1 旧版的 `buildDeliverableDocuments`、`writeDeliverable`、`listDeliverables`、`resolveCallId`
- Produces:
  - `DeliverableDocument { readonly slug: string; readonly file: string; readonly document: Record<string, unknown> }`
    —— `file` 是**文件基名** `<slug>.geoclar`，`document` 是单文件全部内容
  - `buildDeliverableDocument(input: BuildInput): DeliverableDocument | undefined`
  - `DELIVERABLE_EXTENSION = '.geoclar'`
  - `deliverablePathOf(cwd: string, slug: string): string` —— `<cwd>/交付物/<slug>/<slug>.geoclar`
  - `writeDeliverable(fs, cwd, doc): Promise<string>` —— 先写 `<slug>.tmp` 再 `rename`，返回 `.geoclar` 的绝对路径
  - `listDeliverables(fs, cwd): Promise<readonly DeliverableEntry[]>` —— `DeliverableEntry { path, slug, callId?, subject?, summary?, title? }`（新增 `summary`/`title` 供卡片用）
  - `resolveCallId(fs, cwd, callId): Promise<string | undefined>` —— 语义不变

- [ ] **Step 1: 改测试**

`deliverable-document.test.mjs`：
```js
test('一份交付物 = 一个文件：manifest 的身份字段并进同一份文档', () => {
  const doc = buildDeliverableDocument({ callId: 'c1', toolName: 'mcp__geoclar__geoclar_recommend_schemes',
    args, result, subject: '霍尔木兹', at });
  assert.equal(doc.file, '20261013-045800-霍尔木兹.geoclar');
  assert.equal(doc.document.format, 'workdsh-deliverable');
  assert.equal(doc.document.schemaVersion, 1);
  assert.equal(doc.document.slug, doc.file.replace(/\.geoclar$/, ''));
  assert.equal(doc.document.callId, 'c1');
  assert.equal(doc.document.type, 'scene-schemes');
  assert.equal(doc.document.summary, '在云量 ≤ 20% 的口径下，这套盖到 65.16%，¥5,564,230。');
  assert.deepEqual(doc.document.intent.conditions, { maxCloud: 20, budget: 8000000, dateFrom: '2025-01-01' });
  assert.equal(doc.document.payload, result);          // 仍是同一个对象，逐字
  assert.equal('versions' in doc.document, false);    // 版本清单随 manifest 一起去掉
  assert.equal('current' in doc.document, false);
});
```

`deliverable-store.test.mjs` 里把旧的 `manifest.json`/`v1.json` 夹具换成 `.geoclar`，并加三条：
```js
test('先写 .tmp 再 rename 成 .geoclar ⇒ 写到一半的那份不可列举', async () => {
  await withDir(async (cwd) => {
    // 只留下 .tmp（模拟写到一半崩了）
    await mkdir(join(cwd, '交付物', 'x'), { recursive: true });
    await writeFile(join(cwd, '交付物', 'x', 'x.tmp'), JSON.stringify({ format: 'workdsh-deliverable' }), 'utf8');
    assert.deepEqual(await listDeliverables(fs, cwd), []);
  });
});

test('落盘返回 .geoclar 的绝对路径，磁盘上确实只有它与目录', async () => {
  await withDir(async (cwd) => {
    const path = await writeDeliverable(fs, cwd, doc('20261013-045800-a', 'call_1'));
    assert.ok(path.endsWith(join('20261013-045800-a', '20261013-045800-a.geoclar')));
    assert.deepEqual((await readdir(join(cwd, '交付物', '20261013-045800-a'))), ['20261013-045800-a.geoclar']);
  });
});

test('列举带出 summary 与 title，卡片不必再读一遍文件', async () => {
  await withDir(async (cwd) => {
    await writeDeliverable(fs, cwd, { ...doc('20261013-045800-a', 'call_1'),
      document: { ...doc('20261013-045800-a', 'call_1').document, summary: '盖到 65.16%。', title: '霍尔木兹' } });
    const [entry] = await listDeliverables(fs, cwd);
    assert.equal(entry.summary, '盖到 65.16%。');
    assert.equal(entry.title, '霍尔木兹');
  });
});
```
> 假 `fs` 需补一个 `rename(from, to)`（见 Step 3）。

- [ ] **Step 2: 跑测试确认失败**

Run: `(cd apps/web && corepack pnpm --filter workdsh-plugin-scene-card build) && node --test packages/plugins/scene-card/tests/deliverable-document.test.mjs`
Expected: FAIL —— `buildDeliverableDocument is not a function`

- [ ] **Step 3: 实现**

`deliverable-document.ts`：把原来的 `manifest` 与 `version` 合成一个对象，`versions[]` / `current` 去掉（版本概念随单文件消失），新增 `file`：

```ts
export const DELIVERABLE_EXTENSION = '.geoclar';

export interface DeliverableDocument {
  /** 目录名，同时也是文件基名。 */
  readonly slug: string;
  /** `<slug>.geoclar` —— 扩展名即"这一份写完了"的标记。 */
  readonly file: string;
  readonly document: Record<string, unknown>;
}

export function buildDeliverableDocument(input: BuildInput): DeliverableDocument | undefined {
  const { result } = input;
  if (!resultIsRenderable(result)) return undefined;
  const scheme = primaryOf(schemesOf(result))?.key;
  if (typeof scheme !== 'string') return undefined;
  const at = input.at;
  const slug = slugOf(input.subject, at);
  const document: Record<string, unknown> = {
    format: DELIVERABLE_FORMAT,
    schemaVersion: DELIVERABLE_SCHEMA_VERSION,
    slug,
    subject: input.subject,
    callId: input.callId,
    type: TYPE_SCENE_SCHEMES,
    title: input.subject,
    summary: summaryOf(result, input.args),
    intent: { tool: bareToolName(input.toolName), scheme, aoi: isRecord(input.args) ? input.args.wkt ?? null : null,
      conditions: conditionsOf(input.args) },
    payload: result,
  };
  return { slug, file: `${slug}${DELIVERABLE_EXTENSION}`, document };
}
```
（`BuildInput`、`resultIsRenderable`、`summaryOf`、`conditionsOf` 等沿用原样，只是不再需要 `DeliverableDocuments`。）

`deliverable-store.ts`：
- `StoreFs` 加 `rename(from: string, to: string): Promise<void>`（绝对路径对）
- 新增 `export function deliverablePathOf(cwd: string, slug: string): string`
- `writeDeliverable`：解析 `<slug>.geoclar` 的 target → 写 `<slug>.tmp` → `fs.rename` → 返回 `processPath`。**rename 失败也要记日志、不得抛到事件流**（上层已有 `.catch`，这里只要不吞异常即可）
- `listDeliverables`：`listDir` 后只认 `type==='directory'`；逐个读该目录里**唯一**的 `.geoclar`（`readdir`/`listDir` 找后缀匹配），读它、按原来的闸校验（`format` / `schemaVersion` / `slug` 与目录名相符），然后带出 `path`/`slug`/`callId`/`subject`/`summary`/`title`
- `resolveCallId`：语义不变

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2，再跑 `deliverable-store.test.mjs`
Expected: PASS

- [ ] **Step 5: 跑全套并提交**

```bash
(cd apps/web && corepack pnpm --filter workdsh-plugin-scene-card build) && node --test packages/plugins/scene-card/tests/*.test.mjs
git add packages/plugins/scene-card/src/runtime packages/plugins/scene-card/tests
git commit -m "refactor(scene-card): 一份交付物写成单个 .geoclar 文件"
```

---

### Task 2: 卡片的数据从哪来 —— 用 `list`，不用自造事件

**Files:**
- Modify: `packages/plugins/scene-card/src/runtime/deliverable-producer.ts`（事件载荷）
- Create: `packages/plugins/scene-card/src/client/deliverables-feed.ts`（客户端数据源）
- Test: `packages/plugins/scene-card/tests/deliverable-feed.test.mjs`（新建）

**Interfaces:**
- Consumes: Task 1 的 `listDeliverables`；既有宿主路由 `/api/workdsh-scene-card` 的 `deliverables/list` action
- Produces: `interface FeedEntry { slug: string; path: string; callId?: string; subject?: string; summary?: string; title?: string }`
  - `type Feed = (onChange: (entries: readonly FeedEntry[]) => void) => () => void`
  - `createDeliverablesFeed(fetchImpl): Feed` —— 列一次 `deliverables/list`，并在文件变化时重列，见下

- [ ] **Step 1: 先定通道（不猜）**

**已核实**：`deliverables/presented` 由官方 `present` 工具产生（`dsh-session` 运行时内），仓库里所有插件都只**消费**它，**没有任何插件主动 append 过自定义会话事件**。所以"插件发事件"这条路**没有先例**，不要拿它当既成事实。

因此本任务取**两条都已验证可用**的通道之一，按实现时能跑通的选，并在报告里写明选了哪条：

- **甲（首选）**：`listDeliverables` 经宿主路由 `deliverables/list` 返回该工作区的全部交付物；客户端订阅文件变化（`dsh-api-workspace-files` 的 `changes` 流）在变化时重列。**不新增任何事件通道**。
- **乙（备选）**：若确认 `Session.append` 扩展 `SessionEventMap` 后可由插件调用，才发 `deliverables/produced`；**必须先用一个最小探针验证它真的会到达客户端订阅者**，验证不过就回到甲。

> 两条都不可用 ⇒ 如实报 BLOCKER。**不要**造一个"看起来在工作"的事件通道。

- [ ] **Step 2: 写测试**（`Feed` 是纯数据源，好直测）
```js
test('甲通道：列出的条目按 callId 归到"这一轮"，其余不给卡片', async () => {
  const feed = createDeliverablesFeed(fakeFetch([
    { slug: 'a', path: '/…/a.geoclar', callId: 'call_1', summary: '盖到 65.16%。' },
    { slug: 'b', path: '/…/b.geoclar', callId: 'call_2' },
  ]));
  await feed.refresh();
  assert.deepEqual(feed.forCall('call_1').map(e => e.slug), ['a']);
});
```
- [ ] **Step 3: 跑测试确认失败** → FAIL
- [ ] **Step 4: 实现** `deliverables-feed.ts`（`refresh()` / `forCall(callId)` / 订阅变化后自动 `refresh`）
- [ ] **Step 5: 全套 + 提交**

```bash
git commit -m "feat(scene-card): 客户端交付物数据源（列 + 变化订阅）"
```

---

### Task 3: `turnTail` 卡片（不在折叠区）

**Files:**
- Create: `packages/plugins/scene-card/src/client/DeliverableCard.tsx`
- Modify: `packages/plugins/scene-card/src/client.tsx`
- Test: `packages/plugins/scene-card/tests/deliverable-card.test.mjs`（新建）

**Interfaces:**
- Consumes: Task 2 的 `Feed`
- Produces: 注册进 `conversation.chat.turnTail`（`kind:'list'`，**新 id**），owner props 提供 `openFile(path)`

- [ ] **Step 1: 写测试**（渲染纯函数化，便于直测）
```js
test('卡片只显示 summary 那一行与「打开」', () => {
  // 断言纯函数 cardTextOf({summary:'盖到 65.16%，¥5,564,230。', title:'霍尔木兹'}) 的输出
});
```
- [ ] **Step 2: 跑测试确认失败** → FAIL
- [ ] **Step 3: 实现**
```ts
ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
  name: 'conversation.chat.turnTail',
  id: 'workdsh-scene-deliverable',       // 新 id ⇒ 追加到平台那一列，而不是替换
  inject: (owner) => ({ openFile: owner.openFile }),
}, DeliverableCard));
```
组件用 Task 2 的 `Feed`：按 owner 的 `turn`/`seq` 找到 `callId`，过滤出该轮的交付物，渲染一行 `summary` + 一个按钮 → `openFile(path)`。
- [ ] **Step 4: 跑测试 + 提交**

```bash
git commit -m "feat(scene-card): 交付物卡改挂在 turnTail，不再埋在折叠的工具调用里"
```

---

### Task 4: tab 认领 `*.geoclar` + 面板按文件渲染

**Files:**
- Modify: `packages/plugins/scene-card/src/client.tsx`（tab 注册加 `patterns`）
- Modify: `packages/plugins/scene-card/src/client/DeliverablePanel.tsx`（数据来源换成读文件）
- Test: `packages/plugins/scene-card/tests/deliverable-panel-render.test.mjs`（扩）

**Interfaces:**
- Consumes: Task 1 的文件格式；`useResource<'file'>(dsh-resource://file/session/<sessionId>/<path>)`
- Produces: `function fileAddressOf(sessionId: string, path: string): string`；`function pathFromAddress(address: string): { path: string; sessionId: string } | undefined`（纯函数，可直测）

- [ ] **Step 1: 写测试**
```js
test('地址往返：session 化 ↔ 解析出路径', () => {
  const a = fileAddressOf('s1', '/root/geoclar/交付物/x/x.geoclar');
  assert.match(a, /^dsh-resource:\/\/file\/session\/s1\//);
  const back = pathFromAddress(a);
  assert.equal(back.path, '/root/geoclar/交付物/x/x.geoclar');
  assert.equal(back.sessionId, 's1');
});
```
- [ ] **Step 2: 跑测试确认失败** → FAIL
- [ ] **Step 3: 实现**
- `client.tsx`：`ctx.sidebarRightTabs.register({ id: KIND, kind: KIND, patterns: ['*.geoclar'], title: () => '交付物' })`
- `DeliverablePanel.tsx`：从 `useTabInfo().tab.navigation.address` 解析路径 → 读文件（**分页读到 `eof` 再 `JSON.parse`**，`too-large`/`not-text` 按"打不开"处理）→ `buildDeliverableView({ phase: 'result', result: payload })`
- [ ] **Step 4: 跑测试 + 全套 + 提交**

```bash
git commit -m "feat(scene-card): tab 认领 *.geoclar，面板按文件渲染"
```

---

### Task 5: 修 `subject` 取不到 + 拆掉旧实现

**Files:**
- Modify: `packages/plugins/scene-card/src/runtime/tool-call-pairing.ts`、`deliverable-producer.ts`（subject）
- Delete: `src/client/auto-open.ts`、`src/client/panel-binding.ts`、`src/client/turn-tools.ts`、`src/client/portal.ts`
- Modify: `src/client.tsx`、`src/client/DeliverablePanel.tsx`、`src/client/SchemeCompareCard.tsx`、`src/index.ts`
- Test: 相应删改

- [ ] **Step 1: 先查 `subject` 为空的真因**（不猜）
在试用实例上核对：生产者收到的 `user/message` 事件**到底有没有、长什么样**（`data.message.content` 是否为数组、文本在哪个字段）。把结论写进报告，再改代码。**不要**用"改成读别的字段"糊过去。
- [ ] **Step 2: 修 subject**，加一条测试（真机那个案例：`subject` 非空）
- [ ] **Step 3: 拆旧实现** —— 先让新形态端到端跑通并手动点过，再删；删除与测试调整同一个提交
- [ ] **Step 4: 全套 + 仓库门 + 提交**

```bash
(cd apps/web && node --test ../../packages/plugins/scene-card/tests/*.test.mjs) && corepack yarn check
git commit -m "refactor(scene-card): 修 subject 取不到；拆掉旧的 toolview 卡与 callId 绑定"
```

---

### Task 6: CI 与仓库门

- [ ] **Step 1: 确认 CI 通配覆盖新测试文件**（`ci.yml` 跑 `tests/*.test.mjs`，新文件自动覆盖；**不要**改成逐文件列举）
- [ ] **Step 2: `corepack yarn check` + 插件 `typecheck` 与 `test` 全绿**
- [ ] **Step 3: 真机验收**（不可省）
跑一次真实检索 ⇒ 对话当轮出现卡 ⇒ 点开右侧渲染 ⇒ `交付物/<slug>/` 下**只有** `<slug>.geoclar` ⇒ 会话窗口截断后重开仍能渲染（这一条本期第一次真正可验）
- [ ] **Step 4: 若有问题，按 `docs/superpowers/plans/2026-10-13-deliverable-real-machine-acceptance.md` 记录缺口，不得称候选完整**

---

## Self-Review

**Spec 覆盖**：§3 目标形状 → Task 1/2/3/4；§4 单文件格式 → Task 1；§5 组件表（拆旧） → Task 5；§6 数据流（**已改：事件改为"列 + 变化订阅"**） → Task 2；§8 subject 待修 → Task 5 第 1-2 步；§9 验收 → 各任务的测试步骤 + Task 6。

**明确不在计划内**：浏览侧（§7）、下单（§7）、多类型（§7）。

**已核实的外部事实**（写计划时逐条查过，不是凭记忆）：
- tab 注册契约 `patterns` 按扩展名 glob：`dsh-client-ui-sidebar-right/lib/types/client/tab-registry.d.ts:80-116`
- `turnTail` 是 `kind:'list'` 且带 `openFile`：`dsh-client-ui-chat/lib/types/client/contract/slots.d.ts:272`、`TurnTailOwnerProps:33`
- 客户端 `file` 资源提供方：`dsh-api-workspace-files/lib/types/client/types.d.ts:5-8`；**部署里已装**（真机确认）
- 平台那张 `.md` 卡的数据源只认 `write`/`edit`/`str_replace_editor` 三个工具 —— 故不能照抄（spec §2 已留档）
- **`deliverables/presented` 由官方 `present` 工具产生；插件只消费、从未主动 append 自定义会话事件** —— 故 Task 2 取"列 + 变化订阅"为主通道

**留了一处判断给实现者**：Task 2 第 1 步在甲（列 + 变化订阅）与乙（自造事件）之间按实测选，**但两条都不可用时必须报 BLOCKER**，不许造一个"看起来在工作"的通道。