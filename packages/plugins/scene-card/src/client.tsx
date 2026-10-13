import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type {} from '@deepseek-ai/dsh-client-ui-tool/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type {} from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import { SchemeCompareCard } from './client/SchemeCompareCard.js';

export const name = 'workdsh-scene-card-client';

// sidebarRightTabs：声明 tab 类型；sidebarRight：打开它（卡上的「查看详情」要用）；
// sessions：读会话 id（openTabIn 是按会话的）；conversation：拿轮次（面板的步骤按轮）
export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'sessions', 'conversation'] as const;

// 面板按调用（callId）参数化：卡上的「查看详情」把同一个 tab 重新绑到那一次调用。
declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap { 'workdsh-scene-deliverable': { callId: string }; }
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: 'workdsh-scene-deliverable', kind: 'workdsh-scene-deliverable', title: () => '交付物' }));
  // 键是 wire 工具名（`mcp__<连接器 serverName>__<工具名>`）—— 连接器不叫 geoclar 就键不上，回落通用卡片。
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'mcp__geoclar__geoclar_recommend_schemes',
    // 会话 id 由框架按槽位作用域解析（tool.call.toolview 是会话级），不必从 owner props 里找。
    inject: (sessionId) => ({
      openDeliverable: (callId: string) => {
        ctx.sidebarRight.openTabIn(sessionId, 'workdsh-scene-deliverable', { params: { callId } });
      },
    }),
  }, SchemeCompareCard));
}
