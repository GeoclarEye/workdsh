/**
 * 本插件的 Host 半区。它做的唯一一件事：**把部署配置交给浏览器那一侧**。
 *
 * 为什么需要它：插件配置写在 `cordis.patch.yml` 的 `config:` 块里（与连接器的
 * `toolCallTimeoutMs` 同形），宿主读得到、**客户端半区读不到** —— 客户端那份 bundle 由
 * boot manifest 装载，而 manifest 的一条只带 `id / url / rev / inject / external / immediately`，
 * 没有 config 字段（实证见报告）；`ctx.config` 在客户端还会直接抛
 * `cannot get property "config" without inject`。所以走宿主自己的那条**同源 fetch 路由**
 * （projects / connectors 都这么做）把值送过去，而不是把地址写死在客户端源码里。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionRpcResult, HostConnectionHandle } from '@deepseek-ai/dsh-client-connection';

export const name = 'workdsh-plugin-scene-card';

export const inject = ['connection'];

/** 本插件的配置面。 */
export interface SceneCardOptions {
  /**
   * 门户地址：面板页脚的「去门户导出」只**跳门户**、不做下载（spec §4.4）。
   * 没配时客户端把那个按钮置为不可用并说明原因，而不是放一个点了没反应的按钮。
   */
  readonly portalOrigin?: string | undefined;
}

/** 浏览器那一侧读这个路径（见 `src/client/portal.ts`）。 */
export const sceneCardPath = '/api/workdsh-scene-card';

const ok = <T>(value: T): ConnectionRpcResult<T> => ({ ok: true, value });
const fail = (code: string, message: string): ConnectionRpcResult<never> =>
  ({ ok: false, error: { code, message, details: {} } });
const record = (value: unknown): Record<string, unknown> | undefined =>
  (value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined);

/**
 * 注册「交付物面板要的那点宿主事实」这一条路由。
 *
 * 现在只有一个 endpoint：`portal` —— 别的都由工具出参驱动，不必问宿主。
 */
export function registerSceneCardConnection(ctx: Context, options: SceneCardOptions = {}): void {
  const connection = (ctx as Context & { connection: HostConnectionHandle }).connection;
  const portalOrigin = typeof options.portalOrigin === 'string' && options.portalOrigin !== ''
    ? options.portalOrigin : undefined;
  const unregister = connection.fetch.register({
    path: sceneCardPath,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const body = record(await request.json());
      if (body?.endpoint === 'portal') {
        return Response.json(ok({ portalOrigin: portalOrigin ?? null }),
          { headers: { 'cache-control': 'no-store' } });
      }
      return Response.json(fail('scene-card/invalid-request', '未知的交付物面板请求。'), { status: 400 });
    },
  });
  ctx.effect(() => unregister, 'workdsh.scene-card.fetch');
}

export async function apply(ctx: Context, options: SceneCardOptions = {}): Promise<void> {
  await ctx.plugin({
    name: 'workdsh-scene-card-integration',
    inject: ['connection'],
    apply: (integration: Context) => { registerSceneCardConnection(integration, options); },
  });
}
