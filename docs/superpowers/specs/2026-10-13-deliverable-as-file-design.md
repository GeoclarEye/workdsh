# 交付物即文件（格式 · 生产者 · 渲染器）设计

日期：2026-10-13
上位相关：geoclar-java `docs/superpowers/specs/2026-10-12-agent-recommend-conditions-card-design.md`（那张卡与那个面板的**前身**，本期把它的数据来源换掉）

---

## 1. 范围与目标

**目标**：把"交付物"从**活会话里的一次工具出参**改成**工作区里的一份文件** —— 面板按文件渲染，文件由插件在工具返回时自动落。并且这份文件是**可进下一阶段的凭据**，不只是渲染物。

**本期做四件**（合一，因为它们合起来才是可交付的特性）：

| # | 做什么 |
|---|---|
| 1 | **文件格式与目录约定**：一份交付物长什么样、放哪 |
| 2 | **生产者**：插件 Host 半区认出那次工具返回、自动落文件（不经模型、不经用户） |
| 3 | **渲染器**：客户端面板改绑**文件路径**、并跟随文件变化 |
| 4 | **凭据**：文件里存下**意图**（AOI + 条件链 + 方案 key），使这份交付物日后**能进下一阶段**（下单 / 复现），而不是只能看 |

**4 和 1–3 是一件事，不是两件**：只做 1–3，文件就是"当时的出参快照"——而**快照会过期**，且出参处在**掩码边界内**、本来就不是订单载荷（见 §11）。存下意图才能既渲染又交接，也让**格式一次定对**：将来接上下单时不用推翻格式。

**不在本期**：交付物的目录与入口（怎么列、怎么挑、怎么从会话外打开）、`generic` 类型与相关技能。两者各自独立，见 §10。

---

## 2. 为什么要换（现状的三处脆弱）

用户报的三条**都在本机与部署实例上证过**：

1. **旧交付物会消失** —— 面板读的是**活会话快照**（`useChat` → `readTurnTools`），而会话窗口会被截断/压缩（我们自己的代码里就有 `callTime === null` 这条"窗口截断把 call 落在窗外"的记录）。一旦那份 `tool/result` 不在快照里，面板显示"已过期"空态。
2. **切换时丢状态** —— 面板绑的是 `callId`，而 `callId` 只在那次对话的时间线里成立；绑定账（`panel-binding.ts`）还是内存里的。
3. **换会话就丢** —— tab 是会话级的，交付物不跟着工作区走。

**根因是同一个**：交付物的身份建立在**会话时间线**上。改成文件之后：

- ①「旧交付物会消失」**直接消失** —— 面板读的是磁盘上的文件，与时间线是否截断无关。
- ③「换会话就丢」**只解决一半**：文件按绝对路径寻址，在别的会话里**读得到**；但唯一的**发现**手段（`list`）绑在会话的工作区根上（§5、§9.3），而"从会话外打开"的入口属于浏览侧（§10）。所以"数据不丢"成立，"你还能找到它"要等 §10。
- ②「切换时丢状态」的**根因**（绑 `callId` + 内存绑定账）随本期退休，但**"怎么挑到另一件"属于浏览侧**（列表、入口、从会话外打开），见 §10。**本期只保证"面板能按给定的文件渲染"，不保证"你能挑到它"。**

**②③ 有一个共同的、可复现的触发场景**：tab 布局会被**撤销/重载恢复**（右侧栏的 slots 契约里写明 "a tab restored by undo / seeded guide"，`panel-binding.ts` 的注释也提到"刚重载、布局被恢复"）。恢复出来的 tab 带着 `params.callId`，而那份内存绑定账已经没了——今天这一下必然空态。改成 path 之后，恢复出来的 tab 自己就带着完整地址。

---

## 3. 文件格式与目录约定

**目录**：工作区根下 `交付物/`，一次产出一个子目录：

```
交付物/20261013-125800-hormuz-3mo/
  manifest.json
  v1.json
```

**`manifest.json`** —— "这是一份交付物"的凭据 + 版本清单：

```json
{
  "format": "workdsh-deliverable",
  "schemaVersion": 1,
  "slug": "20261013-125800-hormuz-3mo",
  "subject": "霍尔木兹海峡近三月影像组合",
  "callId": "call_…",
  "current": "v1.json",
  "versions": [
    { "file": "v1.json", "at": "2026-10-13T12:58:00+08:00", "note": "" }
  ]
}
```

`callId` 是**来路**（哪个工具调用产出了它），客户端靠它经宿主路由把「卡上的某次调用」解析到「磁盘上的哪一份」（§9 待定段）。它**不是身份** —— 身份是 `slug` + 路径。

**`v1.json`** —— `type` 决定用哪套渲染器：

```json
{
  "format": "workdsh-deliverable",
  "type": "scene-schemes",
  "title": "霍尔木兹海峡近三月影像组合",
  "summary": "在云量 ≤ 20% 的口径下，这套盖到 52.7%，¥6,176,934。",
  "intent": {
    "tool": "geoclar_recommend_schemes",
    "scheme": "CUSTOM",
    "aoi": "POLYGON((…))",
    "conditions": { "maxCloud": 20, "budget": 8000000, "dateFrom": "2025-01-01" }
  },
  "payload": { "…与 geoclar_recommend_schemes 出参同形…" }
}
```

**约定与硬规矩**：

- **目录与后缀负责"找到候选"，内容里的 `format` 负责"确认是交付物"** —— 与专家包同形（`.expert.zip` 外壳 + `manifest.json` 里的 `format`；已核 `experts/src/services/portability.ts` 的 `EXPERT_FORMAT` 与 `record.format !== 'workdsh-expert'` 校验）。改名、挪位置都不丢身份。
- **`schemaVersion` 是格式演进的闸** —— 同样照专家包（它有 `EXPERT_SCHEMA_VERSION`，且 preflight 明确拒"未知 schema 主版本"）。**主版本读不懂 ⇒ 整份不画**，回落"当前版本打不开"，而不是猜着渲染。本期写 `1`。
- **不列逐文件校验和**：专家包的 manifest 逐文件列 `size` + `sha256`，因为它是**导入**格式、内容来自外部。交付物由我们自己写出、不经导入，所以省掉；这是**有意省略**，不是漏。将来若引入外部导入，再补。
- **`format` 不对 ⇒ 不是交付物，一个字节都不碰。`type` 不认识 ⇒ 不画**，回落成"这份交付物当前版本打不开"，而不是渲染半张。沿用现有那套严格度（缺 ⇒ 少一块；有但读不懂 ⇒ 整份不画）。
- **`summary` 与 `payload` 分开**：`summary` 是写给人看的一句话（列表页与面板顶部用，不必读整份 payload），`payload` 是给渲染器看的结构化数据。
- **`intent` 是这份文件的"凭据"半边** —— 它记的是**怎么算出这套方案的**（工具名、选中的方案 `key`、AOI、条件链），不是"算出了什么"。`payload` 会过期（景会被订走、价格会变），`intent` 不会：**下单必须用服务端当下的数据重新取**，所以文件存的是**可重算的输入**。
  - **字段名与工具的 `arguments` 逐字对应**（`wkt` / `maxCloud` / `maxGsd` / `budget` / `dateFrom` / `dateTo` / `datasetIds` / `offNadirMax` / `preferConsistent`），生产者**直接抄、不做重命名**——两边因此不必维护一套映射。未给的条件不写进 `conditions`。
  - `intent` **不是**可选的锦上添花：**没有它，这份文件就只是一张会过期的快照**，"能进下一阶段"无从谈起（§11）。
- **`next` 不进文件**：文件是"方案规划的内容"本身。`scene-schemes` 那条「下一步」仍由渲染器**从 payload 派生**。
- **版本只增不改**：改条件写新 `vN.json` 并更新 manifest，旧版永不覆盖。**但本期生产端只写一条**（见 §4）。

---

## 4. 生产者：插件 Host 半区自动落

**不经模型判断、不经用户操作** —— 工具返回方案的那一刻就落。

**机制**（本仓现成，`packages/plugins/projects/src/runtime/deliverable-attribution.ts:143` 是同一个挂法）：

```ts
ctx.on('session/event', (session, event) => { … })
```

- **`tool/result` 确实是会话事件**（`@deepseek-ai/dsh-session` 的 `lib/types/invariant.js:92`、`lib/types/index.js:110` 都在处理它），所以它能被这条流看到。发射路径**没有任何 type 过滤**（`Session.append`，`lib/index.js:1441-1474`），事件是"exactly as recorded"——不是一份策展过的子集。
- **必须挂在 root context 上** —— agent-scoped context 的监听器**只收到经该 agent 进入的会话**的事件（`lib/types/index.d.ts:57-58`）。先例的注释正是 "on the root context (all Sessions)"。挂错层会静默少收。
- **seed 事件不发布**（`lib/types/index.d.ts:126`）：恢复/分叉出来的历史**不会重放**，只有实时 append 才发。这不影响"工具返回那一刻落盘"，但 §8 那条"截断后重开"的验收**只能真机做**，构造恢复事件测不到它。
- **它的载荷里没有工具名** —— 名字在配对的 `tool/call` 上（`tool/result` 顶层**既无 `callId` 也无 `name`**）。所以先认 `tool/call` 得到 `callId` → 工具名，再等同一个 `callId` 的 `tool/result` 取数据。
- **配对可以用更硬的依据**：`tool/result` 的 append 带 `sourceEventSeqs: [callSeq]`，直接指回调用那条；配对 id 落在 `event.data.message.source.callId`。优先用 `sourceEventSeqs`，比按 `callId` 重配更不容易错。（`invariant.js:101-107` 那条"tool/result 之前必须有同步骤的 tool/call"说明配对是被跟踪的。）
- **意图必须从 `tool/call` 的 `arguments` 抄** —— AOI（`wkt`）与整条条件链**只在入参里，出参不回显**（§11 已核）。方案 `key` 从出参的 `schemes[]` 取。这三样合起来就是 §3 的 `intent`。**这是"凭据"能否成立的关键**：丢了它，文件就只剩一张会过期的快照。
- **写文件用 `ctx.fs`** —— Host 半区有它（`deliverable-attribution.ts` 已在用 `ctx.fs.readBytes`；写是 `writeText`）。落盘的栅栏根是"该会话的 `cwd`"，与项目归属无关（§9.2）。

**落盘规则**：

- 每次产出落**一份新的**子目录（`时间戳-短标题`），**不归并**。
- **为什么不做归并**：插件不去推断会话、AOI 或"这是哪一件"（产品定的边界：**插件只认文件**）。既然没有可靠依据判"这次与上次是同一件"，硬判会把不同的事揉进一份。
- **代价（明说）**：本期**没有"第 N 版"这层关系** —— 历史是一串并列的交付物，你去里面挑。回看与切换仍然成立（文件都在、都能打开），缺的只是"同一件的演进"。
- 格式里的 `versions[]` **保留**（将来要归并时不用改格式），本期生产端只写一条。

---

## 5. 渲染器：面板改绑文件路径

**通道**：`@deepseek-ai/dsh-api-workspace-files`（部署实例已在）：

> 面向 Web GUI 的工作区文件服务：**有界文件读取**、**按目标监听文件系统变化**，以及 **Session 工作区根内的目录列举**。……可以跟随一个文件或一个目录直接子项的变化。

**实际 API 面**（引言那段是准确的，但接口名不是）：

- **方法就五个**：`read` / `readBytes` / `stat` / `changes` / `list`。**订阅变化叫 `changes`，没有 `follow`。**
- **两套路径词汇**：`read` / `readBytes` / `stat` / `changes` 按**绝对路径**寻址；`list` 说的是**工作区根相对路径**。所以"列目录找候选 → 读文件拿内容"是两套地址的接续，不是一套。
- **浏览器半区的正统用法**不是直接调服务，而是本包注册进 `ctx.resources` 的 **`file` 提供方**，按 `dsh-resource://file/session/<sessionId>/<path>` 寻址（组件用 `useResource<'file'>(address)` 读元数据）。任何 UI 访问同一完整地址都共享观察。
- **`absolute/<path>` 寻址今天是坏的**：它没有授权 Session，以 `workspace-file/unknown-workspace` 失败，**不借用当前或 Tab Session**。也就是说"从会话外打开"连寻址兜底都不存在——这支持把它划到 §10。
- **读是分页的**：`read` 按行返回一个窗口（`maxLines` 默认 5000），单页 `maxBytes` 2 MiB，超限返回 `too-large` 而**不截断**。消费方要逐页拼到 `eof` 再 `JSON.parse`。
- **它不提供修改操作** —— 这一条从机制上钉死了"写只能由 Host 半区/模型做"，与 §4 的分工天然吻合。

**面板改成**：绑**文件地址**（tab 的 `navigation.params` 从 `callId` 换成 `path`），用 `changes(<sessionId>, <绝对路径>, signal)` 订阅变化。

**列举限定在"会话工作区根"内** —— 而这个根就是**该会话的 `header.cwd`**（缺 `cwd` 时回落 `scope.sandboxPolicy.workspaceRoot`）。所以"同一工作区下的不同会话看到同一批交付物"**等价于"两个会话的 `header.cwd` 相同"**：这是一条在部署实例上可实测的判据（§9.3），不是可以默认成立的前提。

**拆掉什么**：现在那套"绑 `callId` + 读活会话快照"（`panel-binding.ts` 的绑定账、`turn-tools.ts` 的 `readTurnTools`、自动弹里的轮次反查）**整条可以退休** —— 它们存在的唯一理由是"从会话里取交付物"，现在交付物在文件里。自动弹的**其余**耦合不在此列，见 §6。

**保留什么**：卡与面板的**渲染层**（`scheme-view.ts` 的视图模型、`SchemeCompareCard.tsx` 的四列网格与 `SchemeMetrics`、`DeliverablePanel.tsx` 的六块与页脚固定、`styles.ts`）**几乎不用改** —— 换的是它**从哪拿数据**，不是它长什么样。

唯一要动的一处很薄：`buildDeliverableView` 的入参类型是 `{ phase?, result? }`，且 `phase !== 'result'` 直接回落，而 `phase` 是"toolview 交来的**阶段**"——**会话时间线的概念，文件里没有**。适配成 `{ phase: 'result', result: <payload> }` 即可（`payload` 与出参同形这条设计正是为此），改动只落在调用点约一行。

---

## 6. 与现有实现的关系

| 现有 | 本期 |
|---|---|
| 面板读 `useChat` 快照 + 按 `callId` 取那一轮 | 改读文件 + `changes` |
| 卡挂在 `tool.call.toolview`（按 wire 工具名键控） | **保留**（卡是"就地看见"，与文件并行；它读的仍是那次调用的出参） |
| `panel-binding.ts` / `turn-tools.ts` / 自动弹的轮次反查 | **退休** |
| 自动弹的其余 `callId` 耦合：`turnOfCall`、per-turn 的 `openedTurns` 账、`panelOpenFacts` | **随本期重做** —— 改绑 path 后这几处判据都得换。其中 `openedThisTurn`（"本轮别再弹"）在 path 绑定下**没有对应物**：文件没有"轮"。语义要重新定义（"这个 path 别弹第二次"或"这次会话别弹第二次"），**不是改个键** |
| 卡 → 面板的接线（`client.tsx` 的 `openDeliverable` 闭包 + `SidebarRightTabParamsMap`） | **改参数不改卡** —— 卡与自动弹都汇进同一个闭包，在那里把 `callId → path` 解出来即可，卡上的 `openDeliverable(callId)` **一行不用改**。跨 Host/客户端边界的机制见 §9 |
| `scheme-view.ts` / `SchemeCompareCard.tsx` / `DeliverablePanel.tsx` / `styles.ts` | **保留**（渲染层不动；`buildDeliverableView` 的函数体也不动，只在其**调用点**加一层 `{ phase: 'result', result: payload }` 薄适配，见 §5） |
| 技能的"不要连发重试"等口径 | **不动**（本期不改技能与专家） |

---

## 7. 降级与错误

| 情形 | 要求 |
|---|---|
| `交付物/` 不存在或为空 | 面板出空态并说明；**不报错、不白屏** |
| `format` 不是 `workdsh-deliverable` | 当作普通文件，**不碰** |
| `schemaVersion` 主版本读不懂 | 按"这份交付物当前版本打不开"处理，**不猜着渲染** |
| `type` 不认识 | 不画那块的渲染，回落"当前版本打不开"；**不渲染半张** |
| manifest 指向的 `current` 文件不存在 | 按"打不开"处理，不猜、不挑别的版本 |
| 文件正在被写（读到半份 JSON） | 解析失败 ⇒ 按"打不开"处理；`changes` 的下一次变化会自愈 |
| 文件大过一个 `read` 页（2 MiB / 5000 行） | **逐页读到 `eof` 再解析**；`too-large` 是解析失败的一种，按"打不开"，**不半解析** |
| `not-text`（非法 UTF-8 或含 NUL） | 按"打不开"处理 |
| 会话没有 `cwd`（持久化层把这类会话落进 `_no-cwd`）/ 面板拿不到会话上下文 | 生产者：**记一条日志**（沿用先例口径）；面板：保持上一帧，不闪空 |

---

## 8. 验收

- **单元**：格式的**校验与分派**是纯函数（`format` 判定、`type` 分派、manifest 与版本的形状校验），照本仓先例导出直测；非法输入各一条。
- **生产者**：喂一段合成的 `tool/call` + `tool/result` 事件序列，断言**恰好落了一份**、目录名与 manifest 字段符合约定、`payload` 与事件里的返回**逐字一致**。
- **渲染器**：给一份夹具文件，断言面板渲染出六块、页脚固定；`changes` 到变化后重渲染（判据是"文件改了 ⇒ 面板读数变了"）。
- **真机验收（不可省）**：装到部署实例上跑一次真实检索，确认 `交付物/` 下出现文件、右侧面板按它渲染；**再让会话窗口被截断后重开**，确认面板**仍能渲染** —— 这条是本期要治的病，必须直接验它。**注意 `seed` 事件不发布，恢复出来的历史不会重放，所以这条只能在真机上做，构造恢复事件测不到它。**
- 仓库门：`corepack yarn check` 全绿；插件单测进 CI 白名单。

---

## 9. 已核实 / 待定

**1–3、5 开工前已结案**（对着引擎代码与先例核过，不必再验）：

| # | 事项 | 裁定 |
|---|---|---|
| 1 | `ctx.on('session/event')` 是否把**全部**会话事件发给插件 | **是。** 发射路径无 type 过滤，事件是 "exactly as recorded"；`tool/call` 与 `tool/result` 都是普通已提交事件。**两个前提必须写进实现**：挂 **root context**（agent-scoped 只听自己进入的会话），且 **seed 事件不发布**。 |
| 2 | Host 半区在**没有项目/工作区归属**的会话里能否拿到 `cwd` 并写文件 | **能。** `cwd` 在会话创建时独立赋值（工作区路径 → `request.cwd` → 进程 cwd），与项目归属无关；`ctx.fs.writeText` 可用。**真正的边界是"会话有没有 `cwd`"**，不是"有没有项目归属"——先例里 `presented without cwd, skipped` 说的是前者，另有一个"缺项目归属"的**静默**跳过，两者不能混作一条。缺 `cwd` 时有兜底根 `scope.sandboxPolicy.workspaceRoot`。 |
| 3 | 交付物的"工作区根"到底是哪个目录 | **就是该会话的 `header.cwd`**（缺则回落 `sandboxPolicy.workspaceRoot`）。会话目录名 `--root-geoclar--` 由 `projectKey(cwd)` 编码而来，解码即 `/root/geoclar`。**跨会话可见性 ⟺ 两个会话的 `header.cwd` 相同。** |
| 5 | 面板改绑 path 后，卡上的「查看详情」怎么改 | **卡一行不用改。** 卡与自动弹都汇进同一个闭包（`client.tsx` 的 `openDeliverable`），在那里把 `callId → path` 解出来、params 换成 `{ path }` 即可（连带 declaration merging 的 `SidebarRightTabParamsMap`）。**不要试图让卡自己推路径**：`cwd` 只给目录基址，子目录名含 slug，重推等于复制生产者的命名算法。 |

**4 仍是待验**：`subject` / `slug` 从哪来——出参里确无可命名字段。默认取"该轮用户消息"当 `subject`、时间戳当 `slug` 前缀，**但"生产者能拿到该轮用户消息"尚未核实**；若不可得则退回只用时间戳。

**待定：`callId → path` 靠什么跨 Host/客户端边界**

生产者跑在 Host 半区，卡与客户端闭包**读不到 Host 内存**。本期取**宿主路由**方案：`manifest.json` 记下产出它的 `callId`，客户端经既有的 `/api/workdsh-scene-card` 路由（§3、`client/portal.ts` 已在用）问 Host「这个 `callId` 落到了哪个 path」，Host 扫 `交付物/*/manifest.json` 回答。

- **为什么不用"发会话事件"**：`Session.append` 虽然是公开方法，但自定义事件类型要模块增补、且**只对在线客户端有效**（seed 不重放）。路由方案**可跨重载**——这正是 §2 的 ②③ 要治的病。而且它顺带就是 §10 浏览侧要的列举接口，不必再造一个。
- **它不是"内存绑定账"**：答案从**磁盘上的 manifest** 现扫得出，进程重启后照样答得出。§2 退休的是"只有内存里那一份"，不是"有映射"。
- **代价（明说）**：一次同源往返，且落盘是异步的——客户端要**有界重试**（文件毫秒级出现），拿不到就先不给入口，而不是开一个空面板。

`manifest.json` 因此多一个字段：

```json
{ "format": "workdsh-deliverable", "schemaVersion": 1, "callId": "call_…", … }
```

`callId` 是**来路**（溯源用），不是身份——身份仍是 `slug` + 路径。

**开工前要实测一条**：实例上各会话是否共享同一个 `header.cwd`。这决定 §5 那句"同一工作区下的不同会话看到同一批交付物"是否成立——若不一致，本期就得改成"按绝对路径读得到，发现靠入口传"。

```
# 试用实例上（DSH_HOME=/srv/dsh）
cat $DSH_HOME/storages/workspace.json
```

---

## 10. 不在本期（各自独立）

- **交付物的目录与入口**：怎么列、怎么挑、怎么从会话外打开（用户明确要的"来回切换"的**浏览侧**）。本期只保证"文件在、面板能按它渲染"。
  - 这块**没有现成机制可借**：`absolute/<path>` 寻址今天以 `workspace-file/unknown-workspace` 失败（§5），右侧栏 tab 的导航契约也只有 `address` / `params` / `revision`，**没有 URL 路由或深链**。所以"从会话外打开"的入口要自建，这是把它划出本期的实质理由，不只是工作量问题。
- **`generic` 类型与相关技能**：格式已在本期预留 `type` 分派，`blocks` 骨架与"模型写交付物"留给有明确生产者时再做 —— 它需要模型判断，与本期"不靠模型判断"相反。

---

## 11. 外部依赖（不在本仓，需 geoclar 侧配合）

§1 的第 4 件（凭据）让"交付物可进下一阶段"**在格式上成立**，但**执行的另一端在 geoclar**。已定的方向是：**在 agent/MCP 层开写工具**（而不是让 portal 接受意图）。这条路要 geoclar 侧补四件事，并且要**作废一条已签字的决策**。

**本节只登记依赖，不在本仓实现。** 本仓能独立完成的只有 §1 的 1–3 件与 `intent` 的落盘。

### 11.1 被作废的决策（要产品/架构确认，不是技术问题）

`geoclar-java/docs/superpowers/specs/2026-10-11-agent-capability-design.md` 原文：

- `:17` —— "**下单 / 写操作 ❌ 不在本设计内**"
- `:19` —— "**不做下单：本设计止于'给出方案与结果'。下单仍在 portal 由人操作。**"
- `2026-10-12-agent-recommend-conditions-card-design.md:37` —— "采用 / 下单 → **无（预期，本层不下单）**"

**开写工具即推翻这三条。** 需要有人明确作废并留下新的裁定，否则实现与文档长期冲突——而这三条恰是别人签字的设计约束，不能由本仓单方面绕过。

### 11.2 四件缺失的能力

| # | 缺什么 | 现状（已核） |
|---|---|---|
| 1 | **写工具** | 现有 5 个工具全是 `readOnlyHint = true, destructiveHint = false`。要新增一个调 `IGcOrderService.createArchiveOrder` 的工具；**classpath 已具备**（`ruoyi-geoclar-agent` 已依赖 `ruoyi-geoclar` + `ruoyi-geoclar-app`），无需新模块 |
| 2 | **raw 的服务端承载** | 下单**必须带真实源**（vendor 提交用 raw 里解析出的**真实场景号**；不给 raw 会把**掩码值**提交给厂商）。但 spec `:52` 禁止出参带 `_raw` / 厂商标识 —— 所以必须**服务端内部取、输出里一个字节都不出** |
| 3 | **写权限身份** | PAT **只有"是谁"、没有权限**（`AgentActor` 注释原话），且 `/mcp` 走 RouterFunction、**不在 SecurityConfig 拦截范围内**，`AgentActorContextExtractor` 是唯一闸门。写路径需要 scope 语义（他们自己的 spec `:147` 列为未决）+ 幂等（`@RepeatSubmit` 只挂在 HTTP 控制器上）+ 确认步骤 |
| 4 | **方案重建** | 推荐**不落库**（"不落库、不进任务队列"），方案是**瞬时的**、无标识。写工具要么接受 §3 的 `intent` **重算**，要么后端把方案持久化 |

### 11.3 一条风险，明说

`readOnlyHint = false, destructiveHint = true` 的写工具意味着**模型可以花钱**。原来那条"下单由人操作"保护的正是这件事。真要开，**人在环的确认步骤不是可选项**。

### 11.4 三个有利条件

- **最后一公里已存在且被测过**：`SceneRecommendOrderParityTest.itemsOf(SceneSchemeVo, …)` 已在把 `sceneSids` 转成 `ArchiveSubmitItemBo`，并断言推荐金额 == 逐景订单小计之和。缺的不是这段逻辑。
- **传输层无障碍**：MCP 无大小限制；`MAX_SCHEME_SCENES = 20` 纯是域决策（其注释自称"上限在此只作护栏"），不是传输约束。
- **本仓不挡路**：连接器超时已按部署配到 600s（`connectors/cordis.patch.yml`），不再是阻塞项。
