# WorkDSH 交付物（场景方案）

状态：**Alpha**。对话内的简版对比卡已注册（`tool.call.toolview`，按 wire 工具名键控）；右侧交付物面板尚未落地。

把 Agent 产出的场景方案（`geoclar_recommend_schemes` 的出参）摆成**两个面**：对话里的一张简版对比卡，和右侧栏的交付物详情面板。两面读**同一份视图模型**，不各自解释一遍工具出参。

- 实现阶段：P1
- 主任务：P1-13，详见 [需求与范围](../../../apps/web/docs/REQUIREMENTS.md)
- 职责：把一次工具调用的结构化结果渲染成可读的对比与明细。
- 边界：不重算覆盖、金额或候选池；服务层给什么就读什么。

## 开发前阅读

[规则](../../../apps/web/AGENTS.md)、[验收要求](../../../apps/web/docs/ACCEPTANCE.md)、[契约](../../../apps/web/docs/CONTRACTS.md)、[插件交付](../../../apps/web/docs/PLUGIN-DELIVERY.md)。

## 一个插件、两个面

两个面都在同一个插件里注册，不拆成两个包：

1. **对话内的卡**：`ctx.slots.register({ name: 'tool.call.toolview', key: 'mcp__geoclar__geoclar_recommend_schemes' }, SchemeCompareCard)`。这个 keyed slot 的 `key` 是 **wire 工具名**（`mcp__<连接器 serverName>__<工具名>`），连接器不叫 `geoclar` 就键不上，自动回落官方通用卡片。

   卡画几列由出参的 `mode` 决定：**精算**（`mode=custom`）并排画 `CUSTOM` 与三套同池对照；**不给条件**（`mode=presets`，12 套预设）只画主推那一套（`VALUE`／性价比，与技能第三节同口径），另用一行说清还有多少套、怎么把它们变成精算 —— 那是一张菜单，不是结论，不倒整张表。`mode` 只有这两个值且**必须有** —— 缺失或读不懂就是"认不出形状"，回落通用卡片（不拿它猜列数）。
2. **右侧面板**：`ctx.sidebarRightTabs.register({ id, kind, title })` 声明 tab 类型，再由 `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: <同一个 id> }, Component)` 提供内容。`key` 与 `id` 必须一致。

卡底的「查看详情」调 `ctx.sidebarRight.openTabIn(sessionId, 'workdsh-scene-deliverable', { params: { callId } })`，把面板绑到**这一次**调用上 —— 面板是按调用的活状态，几天后早换成了别的东西，历史那一件只能从它自己那张卡回去。

## 数据边界

视图模型（`src/client/scheme-view.ts`）是纯函数，只吃工具结果、不取网络：认得出形状就给读数，认不出就返回 `undefined`，由调用方回落到官方通用卡片。工具出参未声明的字段（如未盖满 WKT、计费面积）不渲染，也不假装有。

出参里的 `scenes` 是**可选**的：老后端没有这个键时读成空清单（新卡装在旧后端前面只是少一列景），不当作形状不认识。

## 验收与下一步

先跑 [契约探针](tests/probe-contract.test.mjs) 确认官方接口的形状，再在同一份类型上实现两个面。构建通过不等于验收通过；真实界面与打包运行时验收在后续任务里。
