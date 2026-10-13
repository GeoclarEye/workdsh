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
// 只为两样：`ctx.sessions` 的模块增强（`SessionStore`）与那个 brand 类型。
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { ConnectionRpcResult, HostConnectionHandle } from '@deepseek-ai/dsh-client-connection';
import { listDeliverables, resolveCallId, type StoreFs } from './runtime/deliverable-store.js';
import { registerDeliverableProducer, type ProducerContext } from './runtime/deliverable-producer.js';

export const name = 'workdsh-plugin-scene-card';

/**
 * 本插件**整体**要的只有 `connection`。
 *
 * `fs` 只有生产者要（见 `apply` 里那层单独的子插件），**不能**挂在这一层：一个注入的服务缺席时
 * 插件不是"跳过某半边"而是**整个不生效**（cordis 的注入是"等到齐"），于是没有 `fs` 的部署里
 * 连既有的 `portal` 路由都会一起消失 —— 面板据它决定「去门户导出」按钮开不开，那是一次静默的
 * 功能丢失。先例 `projects/src/index.ts:10` vs `:21` 是同一个分工。
 */
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
 * 会话 id 的 brand 只是编译期记号（`Branded<'SessionId'>` 是 `string & {…}`），值就是那个字符串。
 *
 * 这里自己盖一下，而不是引 `@deepseek-ai/dsh-brand` 的 `brandString`：那要多一个本插件没有的依赖，
 * 而它做的事与这一行逐字相同。**只在从请求体读出 id 的那一处用** —— 这条路由不是 typert Remote，
 * 没有线上解码器替我盖 brand，所以裸串进到这里是常态。
 */
const sessionIdOf = (value: string): SessionId => value as SessionId;

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
        // `fs` 与 `sessions` 都在**请求时才取**，而且用 `ctx.get` 而不是 `ctx.fs` / `ctx.sessions`：
        // `get` 的文档就是"读服务，绕开 inject 要求"（有提供者就给，没有就 `undefined`，不抛），
        // 所以这条路由不因为"这个部署有没有 fs / 有没有会话服务"而挂不上 —— 少哪一样，
        // 只在它自己的答复里说出来。
        //
        // `fs` 的标注写明确、**不做断言**：存储层要的是那一小块结构类型（`StoreFs`），
        // 能不能赋值由编译器当场判（`FileSystem` 的五个成员逐个对得上），对不上就编译不过 ——
        // 而不是靠一句 `as` 把不确定性盖过去。
        const fs: StoreFs | undefined = ctx.get('fs');
        const payload = record(body.payload);
        // 工作区根**由宿主按会话 id 解析**，请求里报什么都不算数。
        //
        // 来源与官方 `dsh-api-workspace-files` 的 `workspaceFileScope` 是同一处：会话 header 的
        // `cwd`（`sessions.get(id)?.header.cwd`）。生产者也正是写进这个 `cwd`，读写两边因此同源；
        // 而客户端**不必**、也拿不到会话的 cwd（本仓 `src/client/**` 一处都没读过 `header.cwd`）。
        //
        // 这一版**不跟随** `workspaceFileScope` 那句 `?? sandboxPolicy.workspaceRoot` 的兜底：
        // 生产者只往有 cwd 的会话里写（没有就 warn 并跳过，spec §7），读侧回退到另一个根只会读出
        // "这份会话本来就没写过"的空目录 —— 拿一个看着正常的结果掩盖缺口，正是要避免的那种。
        //
        // **别据此把这层扩展成任意路径读写**：根是宿主按会话定死的，这里只读它下面那个固定子目录
        // （`交付物/`，见 `deliverable-store.ts`），不接受任何由调用者拼进来的路径。
        const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
        if (sessionId === '') {
          return Response.json(fail('scene-card/invalid-request', '缺少会话 id。'), { status: 400 });
        }
        const session = ctx.get('sessions')?.get(sessionIdOf(sessionId));
        if (session === undefined) {
          // 认不出这个会话就**不猜**：回一个空列表会被调用方读成"这一份交付物都没有"。
          return Response.json(
            fail('scene-card/unknown-session', '这个会话不在宿主的活跃会话里。'), { status: 400 });
        }
        const action = payload?.action;
        if (action !== 'list' && action !== 'resolve') {
          return Response.json(fail('scene-card/invalid-request', '未知的交付物面板请求。'), { status: 400 });
        }
        if (fs === undefined) {
          return Response.json(fail('scene-card/unavailable', '这个部署没有文件系统。'), { status: 503 });
        }
        // 没有 cwd 的会话：生产者正是**跳过**它们（spec §7），所以"什么都列不出来"才是实话，
        // 不是错误 —— 别把它做成 4xx，那会让面板把"本来就没有"显示成"出错了"。
        const cwd = session.header?.cwd;
        if (cwd === undefined || cwd === '') {
          return Response.json(ok(action === 'list' ? { entries: [] } : { path: null }),
            { headers: { 'cache-control': 'no-store' } });
        }
        if (action === 'list') {
          return Response.json(ok({ entries: await listDeliverables(fs, cwd) }),
            { headers: { 'cache-control': 'no-store' } });
        }
        const callId = typeof payload?.callId === 'string' ? payload.callId : '';
        const path = await resolveCallId(fs, cwd, callId);
        return Response.json(ok({ path: path ?? null }),
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
    // 这一层只依赖 `connection`：路由与它同层，**不该**因为某个部署没有 `fs` 就跟着挂不上。
    inject: ['connection'],
    apply: (integration: Context) => {
      registerSceneCardConnection(integration, options);
      // 生产者多要一样 `fs`，所以**单独挂一层**（`ctx.inject` 就是 `ctx.plugin({ inject })` 的简写）。
      // 少 `fs` 时只有生产者不挂，上面那条路由照常服务 —— 缺依赖的插件是"等"，等不到的整个不生效，
      // 所以这层必须分出来。
      integration.inject(['fs'], (withFs: Context) => {
        // **不要**把 cordis 的 `ctx` 直接当 `ProducerContext` 传：显式构造一层适配，把
        // `Session` / `SessionEvent` → `SessionLike` / `PairingInput` 这层映射收在一处
        // （与 `deliverable-attribution.ts` 在内部构造 `deps` 是同一手法）。
        //
        // 实测（task-5 报告）：直接传 `integration` 也**编译得过**，所以适配层挡的**不是**编译
        // 错误 —— cordis 的 `on` 是方法语法，参数按双变检查，结构不符它不拦。它买到的是
        // "谁在第几位"只有一份、写在脸上：这两样运行时都是普通对象，接错了不会报错，只会静默不落盘。
        const adapter: ProducerContext = {
          // 与路由同一取法：**用的时候现取**，不把挂载那一刻的服务对象钉死 ——
          // 宿主换过 fs 提供方后，路由与生产者要一起换（`ctx.fs` 本来就是服务取值）。
          get fs(): StoreFs { return withFs.fs; },
          on: (event, handler) => {
            withFs.on(event, (session, payload) => {
              handler(session, payload);
            });
          },
          logger: (name) => withFs.logger(name),
        };
        registerDeliverableProducer(adapter);
      });
    },
  });
}
