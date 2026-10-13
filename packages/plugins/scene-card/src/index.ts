/**
 * 本插件的 Host 半区。它做两件事：
 *
 * 1. **把部署配置交给浏览器那一侧**。为什么需要它：插件配置写在 `cordis.patch.yml` 的
 *    `config:` 块里（与连接器的 `toolCallTimeoutMs` 同形），宿主读得到、**客户端半区读不到** ——
 *    客户端那份 bundle 由 boot manifest 装载，而 manifest 的一条只带
 *    `id / url / rev / inject / external / immediately`，没有 config 字段（实证见报告）；
 *    `ctx.config` 在客户端还会直接抛 `cannot get property "config" without inject`。
 *    所以走宿主自己的那条**同源 fetch 路由**（projects / connectors 都这么做）把值送过去，
 *    而不是把地址写死在客户端源码里。
 * 2. **把交付物生产者挂进会话事件流**（spec §4）：工具返回方案的那一刻就落盘，面板再经同一条
 *    路由把盘上的交付物列出来。
 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-fs';
import type { ConnectionRpcResult, HostConnectionHandle } from '@deepseek-ai/dsh-client-connection';
import { listDeliverables, resolveCallId, type StoreFs } from './runtime/deliverable-store.js';
import { registerDeliverableProducer } from './runtime/deliverable-producer.js';

export const name = 'workdsh-plugin-scene-card';

export const inject = ['connection', 'fs'];

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
 * 两个 endpoint：`portal` 交部署配置；`deliverables` 让面板列出盘上的交付物、并按 `callId`
 * 反查路径。落盘本身不在这里 —— 那是生产者的事，这条路由**只读**。
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
      if (body?.endpoint === 'deliverables') {
        // 现取而不是挂载时取：`ctx.fs` 是服务取值，宿主换过 fs 提供方后这条路由跟着换。
        //
        // 标注写明确、**不做断言**：存储层要的是 `ctx.fs` 那一小块结构类型（`StoreFs`），
        // 能不能赋值由编译器当场判（`FileSystem` 的五个成员逐个对得上），对不上就编译不过 ——
        // 而不是靠一句 `as` 把不确定性盖过去。
        const fs: StoreFs = ctx.fs;
        const payload = record(body.payload);
        // `cwd` 由客户端上送，是**该会话自己的工作区根**，这一版直接信它（spec §4）。
        // 信得起的原因有两条，都写在明面上：它只用来在**调用者自己的工作区里读一个固定目录**
        // （`交付物/`，见 `deliverable-store.ts`），不被拼成任意路径；而这条路由本身已经在
        // `connection.fetch` 的信任边界之内 —— `ConnectionFetchRoute.fetch` 的契约是
        // "after the physical carrier has applied its trust and authentication policy"
        // （`dsh-client-connection/rpc.d.ts`）。**别据此把这层扩展成任意路径读写**：
        // 那两条理由都撑不住任意路径。
        const cwd = typeof payload?.cwd === 'string' ? payload.cwd : undefined;
        if (cwd === undefined || cwd === '') {
          return Response.json(fail('scene-card/invalid-request', '缺少工作区根。'), { status: 400 });
        }
        if (payload?.action === 'list') {
          return Response.json(ok({ entries: await listDeliverables(fs, cwd) }),
            { headers: { 'cache-control': 'no-store' } });
        }
        if (payload?.action === 'resolve') {
          const callId = typeof payload.callId === 'string' ? payload.callId : '';
          const path = await resolveCallId(fs, cwd, callId);
          return Response.json(ok({ path: path ?? null }),
            { headers: { 'cache-control': 'no-store' } });
        }
        return Response.json(fail('scene-card/invalid-request', '未知的交付物面板请求。'), { status: 400 });
      }
      return Response.json(fail('scene-card/invalid-request', '未知的交付物面板请求。'), { status: 400 });
    },
  });
  ctx.effect(() => unregister, 'workdsh.scene-card.fetch');
}

export async function apply(ctx: Context, options: SceneCardOptions = {}): Promise<void> {
  await ctx.plugin({
    name: 'workdsh-scene-card-integration',
    inject: ['connection', 'fs'],
    apply: (integration: Context) => {
      // **不要**把 cordis 的 `ctx` 直接当 `ProducerContext` 传：显式构造一层适配，把
      // `Session` / `SessionEvent` → `SessionLike` / `PairingInput` 这层映射收在一处
      // （与 `deliverable-attribution.ts` 在内部构造 `deps` 是同一手法）。
      //
      // 实测（task-5 报告）：直接传 `integration` 也**编译得过**，所以适配层挡的**不是**编译
      // 错误 —— cordis 的 `on` 是方法语法，参数按双变检查，结构不符它不拦。它买到的是
      // "谁在第几位"只有一份、写在脸上：这两样运行时都是普通对象，接错了不会报错，只会静默不落盘。
      registerDeliverableProducer({
        fs: integration.fs,
        on: (event, handler) => {
          integration.on(event, (session, payload) => {
            handler(session, payload);
          });
        },
        logger: (name) => integration.logger(name),
      });
      registerSceneCardConnection(integration, options);
    },
  });
}
