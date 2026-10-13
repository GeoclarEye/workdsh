# WorkDSH 交付物（场景方案）

状态：**Alpha 骨架**。本步只建包与构建接线，尚未注册任何卡片或面板。

把 Agent 产出的场景方案（`geoclar_recommend_schemes` 的出参）摆成**两个面**：对话里的一张简版对比卡，和右侧栏的交付物详情面板。两面读**同一份视图模型**，不各自解释一遍工具出参。

- 实现阶段：P1
- 主任务：P1-13，详见 [需求与范围](../../../apps/web/docs/REQUIREMENTS.md)
- 职责：把一次工具调用的结构化结果渲染成可读的对比与明细。
- 边界：不重算覆盖、金额或候选池；服务层给什么就读什么。

## 开发前阅读

[规则](../../../apps/web/AGENTS.md)、[验收要求](../../../apps/web/docs/ACCEPTANCE.md)、[契约](../../../apps/web/docs/CONTRACTS.md)、[插件交付](../../../apps/web/docs/PLUGIN-DELIVERY.md)。

## 两个注册点、一个插件

通道类型与面板内容都在同一个插件里注册，不拆成两个包：

1. `ctx.sidebarRightTabs.register({ id, kind, title })` 声明 tab 类型；
2. `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: <同一个 id> }, Component)` 提供该 tab 的内容。

`key` 与 `id` 必须一致 —— 后者是前者在 `sidebar.right.pane.tab` 席位上的注册名。

## 数据边界

视图模型是纯函数，只吃工具结果、不取网络：认得出形状就给读数，认不出就返回 `undefined`，由调用方回落到官方通用卡片。工具出参未声明的字段（如未盖满 WKT、计费面积）不渲染，也不假装有。

## 验收与下一步

先跑 [契约探针](tests/probe-contract.test.mjs) 确认官方接口的形状，再在同一份类型上实现两个面。构建通过不等于验收通过；真实界面与打包运行时验收在后续任务里。
