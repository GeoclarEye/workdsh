# 交付物即 `.geoclar` 文件（产出物入口 · 平台渲染器）设计

日期：2026-10-13
取代：`2026-10-13-deliverable-as-file-design.md` 的**消费侧**——那份 spec 的 §5（渲染器）、§6（与现有实现的关系表）作废，其余章节继续有效。
上位：那份 spec 的**生产侧**结论继续有效（格式严格度、manifest 作提交标记、串行落盘等）；本篇改动其中"一份交付物写成 manifest + 正文两个文件"这一点（见 §4）。
已实现：生产侧代码在 `feat/scene-deliverable-surfaces` 合并后的 `main` 上，并已部署到试用实例（alpha.18）。

---

## 1. 要解决的问题

真机上暴露的三条：

1. **卡找不到。** 交付物卡挂在 `tool.call.toolview` 槽位上，而工具调用在"已完成，用时 5 分 2 秒"那行折叠区里（`aria-expanded="false"`）。用户要先展开才看得见卡，看见了才有"查看详情"。
2. **打开了会过期。** 面板按 `callId` 绑活会话快照，会话窗口一截断就显示"已过期"——这正是当初要治的病。
3. **形状不对。** 交付物是"一件产出物"，不该是"某个工具调用的一种渲染"。

---

## 2. 关键发现：目标形态是平台的一等公民

查 `@deepseek-ai/dsh-client-ui-sidebar-right` 的 tab 注册契约（`lib/types/client/tab-registry.d.ts:80-116`）：

```ts
interface SidebarRightTabType {
  readonly id: string;
  readonly kind: string;
  /** Resource-address globs this type recognizes … `*.md` matches `dsh-resource://file/session/s1/home/me/notes.md` */
  readonly patterns?: readonly string[];
  readonly canOpen?: (address: string) => boolean;
  readonly title: (address: string) => string;
}
```

`patterns` 按**扩展名 glob** 认领文件地址 —— `.md`、`.html` 就是这么工作的，**自定义后缀一样能**。所以 `.geoclar` 不必自造机制，只要注册一个 tab。

另外 `conversation.chat.turnTail` 槽位是 `kind:'list'`（`dsh-client-ui-chat/lib/types/client/contract/slots.d.ts:272`），插件**可以注册自己的卡片**进去，且它在回合动作行之前、**不在折叠的工具调用区**；owner 带 `openFile(path)`。

### 一条走不通的路（留档，避免重走）

平台的 `.md` 产物卡**不能**直接照抄：它的数据来自 `GET /api/changes.summary?sessionId&seq`，那个 `seq` 来自 `workspace/changes` 事件，而该事件只由 `write` / `edit` / `str_replace_editor` 三个工具产生。我们的交付物由插件 Host 半区写入、**不经过任何工具**，所以平台的数据源里没有它；而且那份数据"kept in a temp dir, dropped when the Session is disposed"。点击时它也**不调 `openFile`**，而是 `openResource('dsh-resource://changes-review/…')` —— 一个代码 diff 审阅器，不是通用文件预览。

---

## 3. 目标形状

**扩展名定为 `.geoclar`**（单段、无点，与 `.md` / `.html` 同形）。选它不选 `.geoclar-scene` 之类：一段式后缀在 tab 的 `patterns` 里写 `*.geoclar` 最省，也最像用户会自己敲出来的名字。**若将来要区分多种交付物**，再追加更长的后缀并各注册一个 tab —— 单段名留给"geoclar 交付物"这个唯一类别。

```
工具返回（不经模型、不经用户）
  └─ 生产者 ──► 写 <slug>.tmp ──rename──► 交付物/<slug>/<slug>.geoclar
     │                                        （扩展名本身 = "写完了"的标记）
     └─ 发会话事件 { path } ──► 客户端
                                    │
对话回合 ────────────────────────────┤
  turnTail 槽位（我们的卡）           │  「霍尔木兹…99.92% · ¥629,841」+[打开]
                                    ▼
  openFile(path) ──► dsh-resource://file/session/<id>/<path>
                        └─► 命中 patterns:['*.geoclar'] ──► 右侧 tab
                              └─► buildDeliverableView(payload) ──► 现有面板六块
```

**渲染逻辑一行不改**：`scheme-view.ts` 的视图模型、`SchemeMetrics`、面板六块与页脚全部保留，只是喂给它们的数据从"会话快照里的一段文本"换成"文件里的 `payload`"。

---

## 4. 格式：单个自描述文件

一份交付物 = **一个** `.geoclar` 文件。身份字段从 manifest 并进来：

```json
{
  "format": "workdsh-deliverable",
  "schemaVersion": 1,
  "slug": "20261013-114422",
  "subject": "霍尔木兹海峡近三月影像组合",
  "callId": "call_01_nUUtxfmY8VEhF9N7rUc73238",
  "type": "scene-schemes",
  "title": "霍尔木兹海峡近三月影像组合",
  "summary": "在云量 ≤ 10% 的口径下，这套盖到 99.92%，¥629,841。",
  "intent": { "tool": "geoclar_recommend_schemes", "scheme": "CUSTOM", "aoi": "POLYGON((…))", "conditions": { "maxCloud": 10, "maxGsd": 1 } },
  "payload": { "…与 geoclar_recommend_schemes 出参同形…" }
}
```

- **`intent` 仍是凭据半边**：意图不会过期，快照会。它喂给下游（重算、下单），不参与渲染。
- **提交标记 = 扩展名**。先写 `<slug>.tmp`，成功后才 `rename` 成 `.geoclar`。列举只认 `.geoclar`，所以写到一半的那份天然不可见 —— 这取代了原来"manifest 后写"的约定，且**少一次读取、少一处不一致**。

---

## 5. 组件与边界

| 组件 | 职责 | 状态 |
|---|---|---|
| 生产者 | 工具返回即落文件、发事件 | **已实现**，改写文件名与事件即可 |
| `StoreFs` 读写层 | 落/列/反查 | **已实现**，路径与列举规则要改 |
| tab 注册 | `patterns:['*.geoclar']` + `title` | 新增，很小 |
| `turnTail` 卡片 | 显示一份交付物 + [打开] | 新增，很小 |
| 渲染层（`scheme-view.ts` / `SchemeMetrics` / 面板六块） | 出参 → 视图模型 → 界面 | **保留，一行不改** |
| 旧 `toolview` 卡、`callId` 绑定账、`openedTurns` | —— | **拆掉** |

---

## 6. 数据流：事件携带 path

- 生产者落盘成功后发一个会话事件，载荷含**绝对路径**。
- 客户端订阅它，在**当轮**的 `turnTail` 注册一张卡。
- **代价（明说）**：只对**在线**客户端有效 —— 重载/重连后卡不出现（`seed` 事件不重放）。但**数据不丢**：文件在工作区，且 tab 一旦打开过，`params` 里带着 path，重启后照样能渲染。
- 这是"实时"的定义：**工具返回那一刻就露**。不做"扫工作区补历史"，那是另一件事（§7）。

---

## 7. 不在本期

- **浏览侧**：跨会话/归档的交付物列表、从会话外打开。要单独一片。
- **交付物 → 下单**：依赖 geoclar 侧四件事，见 `2026-10-13-deliverable-as-file-design.md` §11。
- **多类型**：`type` 分派只做 `scene-schemes`；`generic` 留给有明确生产者时。

---

## 8. 已知要修的问题

1. **`subject` 取不到。** 真机落盘的 `subject` 是空串 —— 我曾判定"生产者订阅全部会话事件，`user/message` 自然在同一流上，所以 subject 是现成的"，**真机证明我错了**。要查清 `user/message` 是否真的到达生产者、以什么形状到达；取不到就退回只用时间戳，并把旧标题留着不覆盖。
2. **实例上没有 geoclar 连接器**（`storages/workdsh_connectors` 只有 `{"seededExample": true}`），而旧的卡键是硬编码的 `mcp__geoclar__geoclar_recommend_schemes`。新形态**不再依赖这个硬编码键**（事件由生产者自己发），这顺带消掉一个隐患。

---

## 9. 验收

- **单元**：格式校验与 `type` 分派是纯函数，非法输入各一条；`slug` 冲突消歧；`.tmp → .geoclar` 的 rename 语义（半份文件不可列举）。
- **生产者**：合成 `tool/call` + `tool/result`，断言恰好落一份、**扩展名是 `.geoclar`**、事件带正确 path、`subject` 非空（这条会暴露第 8 节第 1 项）。
- **tab**：注册后 `*.geoclar` 地址能命中；点卡 → `openFile` → 右侧渲染出六块。
- **真机（不可省）**：跑一次真实检索 ⇒ 对话里当轮出现卡、点开右侧渲染、`交付物/` 下是单个 `.geoclar` 文件。**旧卡与旧面板此时应当已不存在**（拆干净了）。
- **仓库门**：`corepack yarn check` 全绿；插件单测进 CI 通配。