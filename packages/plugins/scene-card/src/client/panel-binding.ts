/**
 * 「面板现在绑的是哪一件交付物」—— 自动弹的两维（已开着 / 开着但绑别的）从这里来。
 *
 * **为什么要自己记账**：`ctx.sidebarRight.tabsIn(sessionId)` 返回的是 **dockkit 的 layout
 * 记录**，字段只有 `id` / `kind` / `title` / `contentId` —— **没有 `navigation`**。
 * 绑定值（`navigation.params.callId`）只有 `useTabInfo()` 那条路读得到，而那是 tab body
 * 自己的 occurrence，外面拿不到别人的。
 *
 * 所以：**每一次我们调 `openTabIn` 都把绑的那一件记下来**（卡的「查看详情」与自动弹两条路
 * 共用同一个入口）。没记过（刚重载、布局被恢复、别的实例开的）就当作"不知道它绑着谁"，
 * 按**不夺焦点**处理 —— 不猜。
 *
 * 单独成一个模块是为了能直测：`tabsIn()` 的记录形状是承重的（谁按 `navigation` 读都会
 * 永远读到 `undefined`），这里用真形状的夹具把这件事钉住。
 */

/** 运行时数据的形状闸；与视图模型那层同一个读法：不认识就是 `undefined`。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 会话 → 我们记下的"面板绑着哪一次调用"。 */
const bound = new Map<string, string>();

/** 记下这一次绑定（`openTabIn` 的同一时刻调用，两条路都不能漏）。 */
export function rememberPanelBinding(sessionId: string, callId: string): void {
  bound.set(sessionId, callId);
}

/** 我们记得的绑定；没记过时 `undefined`（≠"没绑"，是"不知道"）。 */
export function panelBindingOf(sessionId: string): string | undefined {
  return bound.get(sessionId);
}

/** 插件卸载：账是模块级的，不带走就会跨重载。 */
export function forgetPanelBindings(): void {
  bound.clear();
}

/** layout 记录里本插件的那个 tab 在不在（按 `kind` 认，字段按形状读）。 */
export function panelIsOpen(tabs: readonly unknown[], kind: string): boolean {
  return tabs.some((tab) => isRecord(tab) && tab.kind === kind);
}

/** 自动弹需要的两维事实。 */
export interface PanelOpenFacts {
  /** 开着，**且就绑着这一件**。 */
  readonly alreadyOpen: boolean;
  /** 开着，但绑的是别的（或绑着谁不知道）⇒ 不夺焦点。 */
  readonly boundToOtherCall: boolean;
}

/**
 * 从 layout 记录 + 我们自己的账，算出自动弹要的那两维。
 *
 * 两维互斥但**各自单独成立**：只要面板开着，其中恰好一个为真 —— 于是 `shouldAutoOpen` 里
 * "已开着就不弹"与"绑别的就不夺焦点"是两条各自能挡住它的理由，不是一条的两种说法。
 */
export function panelOpenFacts(tabs: readonly unknown[], kind: string, sessionId: string,
  callId: string): PanelOpenFacts {
  const open = panelIsOpen(tabs, kind);
  const known = open ? panelBindingOf(sessionId) : undefined;
  return { alreadyOpen: open && known === callId, boundToOtherCall: open && known !== callId };
}
