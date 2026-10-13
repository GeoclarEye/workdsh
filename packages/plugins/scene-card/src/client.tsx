import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type {} from '@deepseek-ai/dsh-client-ui-tool/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import { shouldAutoOpen, viewportIsNarrow } from './client/auto-open.js';
import { turnOfCall } from './client/turn-tools.js';
import { DeliverablePanel } from './client/DeliverablePanel.js';
import { SchemeCompareCard } from './client/SchemeCompareCard.js';

export const name = 'workdsh-scene-card-client';

// sidebarRightTabs：声明 tab 类型；sidebarRight：开它（卡上的「查看详情」与受控自动弹都要用）；
// uiConversation：自动弹要判"这一轮弹过没有"，得由 callId 反查轮次。
export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'uiConversation'] as const;

/** tab 类型 id 与 kind 同名：`sidebar.right.pane.tab` 的键就是类型定义里的 `id`（槽位契约如此）。 */
const KIND = 'workdsh-scene-deliverable';

// 面板按调用（callId）参数化：卡上的「查看详情」与自动弹都把同一个 tab 重绑到某一次调用。
declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap { 'workdsh-scene-deliverable': { callId: string }; }
}

/**
 * 会话 → **已经在哪一轮自动弹过**。
 *
 * 为什么放在模块里而不是组件状态里：这是"这一轮发生过什么"，不是渲染状态 ——
 * 卡每次工具调用都会重挂，放组件里等于每挂一次就忘一次。
 *
 * 它承担的是 Task 1 §9-6 那条**拿不到**的信号：`registerCloseHandler` 是清理钩子、
 * 还被 `replaceTab` 调用，区分不出"用户关掉"；所以"用户关掉后本轮不再弹"只能退化成
 * "本轮只弹第一次"，而那是我们自己的记账。
 */
const openedTurns = new Map<string, number>();

/** 从 tab 记录里读本插件的 kind；记录来自运行时，按形状读。 */
function kindOf(tab: unknown): string | undefined {
  if (typeof tab !== 'object' || tab === null) return undefined;
  const kind = (tab as { kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : undefined;
}

/** 从 tab 记录里读它绑的 `callId`（`navigation.params` 是开这个 tab 的人给的）。 */
function boundCallIdOf(tab: unknown): string | undefined {
  if (typeof tab !== 'object' || tab === null) return undefined;
  const navigation = (tab as { navigation?: unknown }).navigation;
  if (typeof navigation !== 'object' || navigation === null) return undefined;
  const params = (navigation as { params?: unknown }).params;
  if (typeof params !== 'object' || params === null) return undefined;
  const callId = (params as { callId?: unknown }).callId;
  return typeof callId === 'string' && callId !== '' ? callId : undefined;
}

/**
 * 这一次调用所在轮次的对话快照 —— 只**读一次**，不订阅（订阅是面板那边 `useChat` 的事）。
 *
 * 两个失败模式都是"读不出轮次"，而不是"猜一个轮次"：会话未绑定/已换（`binding` 会抛），
 * 或 chat 这个 View 还没注册（`target` 会抛）。读不出来就按"本轮没弹过"处理 ——
 * 那只会让判定更保守，不会误弹。
 */
function chatSnapshotOf(ctx: Context, sessionId: Parameters<Context['sidebarRight']['tabsIn']>[0]): unknown {
  try {
    return ctx.uiConversation.binding(sessionId).target('chat').getSnapshot();
  } catch {
    return undefined;
  }
}

export function apply(ctx: Context): void {
  // 插件的清理：`openedTurns` 是模块级的，卸载时要跟着走，否则重载后带着上一轮的账。
  ctx.effect(() => () => { openedTurns.clear(); });
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: KIND, kind: KIND, title: () => '交付物' }));
  // 门户地址：没配就不放"点了没反应的按钮"（见 DeliverablePanel 的导出按钮）。
  // 读法是防御性的 —— 客户端插件拿不到配置时这一项就是 undefined，不是错误。
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: KIND,
    inject: () => ({ portalOrigin: readPortalOrigin(ctx) }),
  }, DeliverablePanel));
  // 键是 wire 工具名（`mcp__<连接器 serverName>__<工具名>`）—— 连接器不叫 geoclar 就键不上，回落通用卡片。
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'mcp__geoclar__geoclar_recommend_schemes',
    // 会话 id 由框架按槽位作用域解析（tool.call.toolview 是会话级），不必从 owner props 里找。
    inject: (sessionId) => ({
      openDeliverable: (callId: string) => {
        ctx.sidebarRight.openTabIn(sessionId, KIND, { params: { callId } });
      },
      /**
       * 受控自动弹（spec §4.5）。返回值就是判据：**该不该调用 `openTabIn`**。
       *
       * 五维事实都在这里当场算；纯函数只管判（`auto-open.ts` 可直测）。
       * `hasDeliverable` 由调用方给 —— 它必须含"有方案"（`primary !== undefined`），
       * 空池时 `buildDeliverableView` 是有返回的。
       */
      autoOpenDeliverable: (callId: string, hasDeliverable: boolean): boolean => {
        const tabs = ctx.sidebarRight.tabsIn(sessionId);
        const mine = tabs.find((tab) => kindOf(tab) === KIND);
        const boundCallId = boundCallIdOf(mine);
        // 轮次读不出来时不记账：`openedThisTurn` 保持 false，判定退回"tab 还没开 ⇒ 可以弹"。
        const turn = hasDeliverable ? turnOfCall(chatSnapshotOf(ctx, sessionId), callId) : undefined;
        const opened = turn !== undefined && openedTurns.get(sessionId) === turn;
        const should = shouldAutoOpen({
          hasDeliverable,
          // "已开着"取"开着**且就是这一件**"：开着但绑着别的 callId 是另一维（不夺焦点）。
          alreadyOpen: mine !== undefined && boundCallId === callId,
          openedThisTurn: opened,
          narrow: viewportIsNarrow(typeof window === 'undefined' ? undefined : window.innerWidth),
          boundToOtherCall: mine !== undefined && boundCallId !== callId,
        });
        if (!should) return false;
        if (turn !== undefined) openedTurns.set(sessionId, turn);
        ctx.sidebarRight.openTabIn(sessionId, KIND, { params: { callId } });
        return true;
      },
    }),
  }, SchemeCompareCard));
}

/** 插件配置里的门户地址（`cordis.patch.yml` 的 `config.portalOrigin`）；没有就当没配。 */
function readPortalOrigin(ctx: Context): string | undefined {
  const config = (ctx as unknown as { config?: unknown }).config;
  if (typeof config !== 'object' || config === null) return undefined;
  const origin = (config as { portalOrigin?: unknown }).portalOrigin;
  return typeof origin === 'string' && origin !== '' ? origin : undefined;
}
