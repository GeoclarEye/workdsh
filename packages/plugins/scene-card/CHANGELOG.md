# Changelog

## 0.1.0-alpha.1 — Unreleased

- 新建插件包骨架：服务端半区（无逻辑）与客户端半区（仅声明 `workdsh-scene-deliverable` tab 类型，尚未注册内容）。
- 接入 Web 的 build / typecheck 链与共享 Profile 功能清单。
- 共享视图模型 `buildDeliverableView`：出参 → 读数（三套并排、金额下界、池诊断、下一步），形状不认识即返回 `undefined` 交给通用卡片。
- 对话内的方案对比卡，注册在 `tool.call.toolview`（按 wire 工具名键控），卡底带「查看详情」把右侧面板绑到该次调用。
