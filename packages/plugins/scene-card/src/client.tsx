import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';

export const name = 'workdsh-scene-card-client';

// sidebarRightTabs：声明 tab 类型；sidebarRight：打开它（Task 3 卡上的「查看详情」要用）；
// sessions：读会话 id（openTabIn 是按会话的）；conversation：拿轮次（面板的步骤按轮）
export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'sessions', 'conversation'] as const;

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: 'workdsh-scene-deliverable', kind: 'workdsh-scene-deliverable', title: () => '交付物' }));
}
