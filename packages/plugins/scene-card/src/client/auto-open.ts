/**
 * 受控自动弹（spec §4.5）：判"**要不要调用 `openTabIn`**"。
 *
 * 为什么这值得一个纯函数：`openTabIn` 恒会展开右侧栏（Task 1 §9-8 核实的副作用），
 * 所以"弹"是**抢占用户的布局**，每一次都该有理由。判据与 ctx 无关，只是为了能直测 ——
 * 调用方（`client.tsx` 里的 toolview 注入面）负责把事实算出来。
 *
 * 五维而不是六维：`userDismissed` **没有**（Task 1 §9-6：唯一的关闭信号
 * `registerCloseHandler` 是清理钩子、按 kind 注册、移除前触发，还被 `replaceTab` 调用，
 * 区分不出"用户关掉"）。它原本要表达的"关掉后本轮别再弹"由 {@link AutoOpenFacts.openedThisTurn}
 * 承担 —— 那个信号是我们自己的，拿得到。
 */

/** 决定该不该弹的全部事实。五个都是从前一帧的状态算出来的，函数自己不读任何东西。 */
export interface AutoOpenFacts {
  /**
   * 这一轮**有没有可展示的东西**。
   *
   * 注意**不是**"`buildDeliverableView` 有没有返回"：空池（`schemes: []`）时它有返回、
   * 但 `primary` 是 `undefined`（见 `scheme-view.ts` 的 `primary` 文档）。照"有没有返回"判，
   * 用户会遇到"面板为一个没有东西可展示的结果自动弹开"。
   */
  readonly hasDeliverable: boolean;
  /**
   * 本插件的 tab 已开着，**且就绑着这一件**（`navigation.params.callId` 相同）。
   *
   * "已开着但绑的是别的 callId"是另一维（{@link AutoOpenFacts.boundToOtherCall}）：
   * 两维在调用方那里由同一次 `tabsIn` 读取派生，各自都能单独把结论压成 `false`。
   */
  readonly alreadyOpen: boolean;
  /**
   * 本轮是否已经弹过一次。
   *
   * 这一维不只防"一轮调三次工具弹三下"（那种情况 {@link AutoOpenFacts.alreadyOpen} 也拦得住），
   * 更要紧的是：**用户把面板关掉之后，同一轮里再来一件交付物也不该把它拽回来**。
   */
  readonly openedThisTurn: boolean;
  /**
   * 窄屏（局方阈值 **768px**，Task 1 §9-7：窄屏的右侧栏是**覆盖式全屏**、不保留轨道）。
   *
   * ⚠ 判定留余量：host 的 `viewportWidth` 是 **frame 宽度**，**未证**等于 `window.innerWidth`
   * （Task 1 §9-7 副结论：官方没把 `autoFullscreen` 暴露给插件，只能自测视口）。
   * 所以这一维取的是"明显窄"而不是"精确跨过 768"——见 `client.tsx` 的 `viewportIsNarrow`。
   */
  readonly narrow: boolean;
  /** 面板开着，但绑的是别的 `callId` ⇒ 不夺焦点（用户可能正在看历史那一件）。 */
  readonly boundToOtherCall: boolean;
}

/**
 * 该不该为这一件交付物调用 `openTabIn`。
 *
 * 任何一个"不弹"的理由成立就 `false` —— 顺序无关，它们不是优先级而是与关系。
 */
export function shouldAutoOpen(facts: AutoOpenFacts): boolean {
  if (!facts.hasDeliverable) return false;
  if (facts.alreadyOpen) return false;
  if (facts.openedThisTurn) return false;
  if (facts.narrow) return false;
  if (facts.boundToOtherCall) return false;
  return true;
}

/**
 * 局方的窄屏阈值（Task 1 §9-7 核实：`viewportWidth < 768` ⇒ 右侧栏自动全屏覆盖）。
 *
 * 留余量：官方比的是 **frame 宽度**，这里比的是 `window.innerWidth`；两者在 768px 上
 * 是否严格相等**未证**。所以判定按"明显更窄"来取 —— 宁可少弹一次（用户自己点「查看详情」），
 * 也不要在没有把握的情况下把对话盖掉。
 */
const NARROW_VIEWPORT_WIDTH = 768;

/** 自测视口得到的窄屏判定；`window` 不可用时（SSR/测试）按"不窄"处理。 */
export function viewportIsNarrow(width: number | undefined): boolean {
  if (typeof width !== 'number' || !Number.isFinite(width)) return false;
  return width < NARROW_VIEWPORT_WIDTH;
}
