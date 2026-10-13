/**
 * 生产者（spec §4）：**不经模型判断、不经用户操作** —— 工具返回方案的那一刻就把交付物落到工作区。
 *
 * 两条与先例一致的做法（`projects/src/runtime/deliverable-attribution.ts`）：
 *   · 订阅挂在**根 context**上，监听**全部**会话（agent-scoped 只听自己进入的会话，spec §4）；
 *   · 监听器**立刻返回**，落盘在微任务里跑 —— 一次慢写不该拖住别人的会话提交。
 *     落盘之间还串成一条链（`writeChain`）：并发落盘会双双选中同一个 slug 而互相覆盖。
 *
 * 每个会话一个配对器（callId 只在会话内唯一），随会话第一次出现时创建。
 */
import { bareToolName, buildDeliverableDocuments } from './deliverable-document.js';
import { listDeliverables, writeDeliverable, type StoreFs } from './deliverable-store.js';
import { callIdOfResult, ToolCallPairing, type PairingInput } from './tool-call-pairing.js';

/** 会话对象里本模块用到的部分。 */
export interface SessionLike {
  readonly id: unknown;
  readonly header?: { readonly cwd?: string } | undefined;
}

export interface ProducerContext {
  readonly fs: StoreFs;
  on(event: 'session/event', handler: (session: SessionLike, event: PairingInput) => void): void;
  readonly logger: (name: string) => { warn(message: string): void };
}

/**
 * 只认这个工具（**裸名**）：spec §4 要生产者"认出那次工具返回"。
 *
 * 比裸名而不是线名 `mcp__<连接器 serverName>__geoclar_recommend_schemes`：连接器是部署侧可改的配置，
 * 改名后线名就变了（技能文档把这条写明了），写死 `mcp__geoclar__` 会随改名**静默失效**。
 */
const PRODUCER_TOOL = 'geoclar_recommend_schemes';

/**
 * slug 撞了就往后退一位：`-2`、`-3`…直到空出来。
 *
 * 为什么会撞：slug 的时间戳只到**秒**（`slugOf`），同一秒里同一 subject 的两次调用（模型重试、
 * 换个条件再算一次）算出同一个 slug，而后一份会落进同一个目录 —— spec §4 要的是"每次产出落一份新的
 * 子目录，不归并"，覆盖就等于**无声地丢掉一份**（manifest 也被换掉，`callId` 从此查不到）。
 *
 * 后缀仍在 64 个码点以内：加后缀前先把底裁短（照 `slugOf` 的口径按码点裁，别把代理对劈开）。
 */
function freeSlug(base: string, taken: ReadonlySet<string>): string {
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${Array.from(base).slice(0, 64 - suffix.length).join('')}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * 落盘**串行化**：同一拍里到达的两份交付物，各自"先列举、再写"的链会交错 —— 双方的列举都跑在
 * 对方写入之前，于是双双选中同一个 slug，后写的把先写的**覆盖**掉（又是一份无声丢失，
 * 而 `freeSlug` 挡不住它：那是"撞上已存在的"，这是"同时选同一个"）。
 *
 * 串成一条链就没有交错：对盘上"列举 + 写"这件事，链上的每一段是原子的。
 * 链跨会话共用：撞名判据是**目录**，同一个工作区被两个会话共用时也得串。
 *
 * 链尾挂着**两道** `.catch`（见调用处）：一次落盘失败、乃至"记账本身抛错"，都不能把后面每一份
 * 毒死 —— 所以 `writeChain` 永远是一条**已解决**的链。
 */
let writeChain: Promise<void> = Promise.resolve();

export function registerDeliverableProducer(ctx: ProducerContext): void {
  const logger = ctx.logger('workdsh-scene-card');

  /**
   * 落盘失败的唯一记账处：只记**一条**日志，本身**绝不往外抛**。
   *
   * 它跑在 `writeChain` 的尾部，所以它自己抛出去就等于把链留成 rejected：后面每一份的
   * `writeChain.then(body)` 都会**跳过 body**，而且从此一直跳过 —— 整条链静默丢弃，
   * 比它想报的那一次失败糟得多。而它确实可能抛：`logger.warn` 是宿主代码（宿主状态不对会抛），
   * `String(cause)` 碰上 `toString` 会抛的对象也会抛。所以调用处它身后还挂了一道兜底的 `.catch`。
   */
  const noteWriteFailure = (cause: unknown): void => {
    logger.warn(`交付物落盘失败：${cause instanceof Error ? cause.message : String(cause)}`);
  };

  /**
   * 会话 id → 配对器（每个会话一个实例，callId 只在会话内唯一）。
   *
   * **只增不删**：这条流上没有"会话结束"这类事件可挂，所以进程见过的每个会话都会留着，
   * 各自还拽着最近一条用户消息。量随"见过的会话数"增长，**不是**"当前活跃会话数"。
   * 已知且记录在案（task-4 报告 §7 F-H），按裁定本期不动。
   */
  const pairings = new Map<string, ToolCallPairing>();

  ctx.on('session/event', (session, event) => {
    const sessionId = String(session.id);
    let pairing = pairings.get(sessionId);
    if (pairing === undefined) {
      pairing = new ToolCallPairing();
      pairings.set(sessionId, pairing);
    }
    pairing.note(event);
    if (event.type !== 'tool/result') return;

    // 只有"刚配齐"的那次才继续；其余的（还在跑、读不懂、已取过）在这里就被挡掉。
    //
    // **这里的顺序是有讲究的**：每一次 `tool/result` 都先 `take`（在下面的工具名闸**之前**），
    // 且与事件同步完成、不挂微任务。配对器那两个账之所以在整合后的调用下不会涨，就是因为
    // 每一份 result 都在这里被取走（见 `tool-call-pairing.ts` 的上界说明）——别把 `take` 挪到
    // 名字闸后面，也别挪进微任务（Task 3 的上界论证依赖这条同步性，有用例钉着）。
    const callId = callIdOfResult(event.data);
    if (callId === undefined) return;
    const paired = pairing.take(callId);
    if (paired === undefined) return;

    // 不是那次工具返回 ⇒ 静默走开，落盘的事一个字都不提。
    if (bareToolName(paired.toolName) !== PRODUCER_TOOL) return;

    // subject 与时间戳在**这里**取，不在微任务里取：晚取的话，这一拍新到的用户消息会变成
    // 上一轮那次调用的标题，`at` 也漂到写盘时刻去（spec §4 要的是"工具返回的那一刻"）。
    const subject = pairing.latestUserMessage();
    const at = new Date();

    // 立刻返回，落盘挂在串行链上跑（`then` 本身就是微任务，慢写不拖住会话提交）。
    writeChain = writeChain.then(async () => {
      const cwd = session.header?.cwd;
      if (cwd === undefined || cwd === '') {
        // spec §7：会话没有 cwd（持久化层把这类会话落进 _no-cwd）⇒ 记一条日志，不抛。
        logger.warn('交付物跳过：会话没有 cwd');
        return;
      }
      const documents = buildDeliverableDocuments({
        callId: paired.callId, toolName: paired.toolName, args: paired.args, result: paired.result,
        subject, at,
      });
      // 形状读不懂 ⇒ 这次不落。**不记日志**：那是"这个工具返回了别的东西"，不是异常。
      if (documents === undefined) return;
      // 一次列举供两件事用（不扫两遍）：这一份是不是已经落过，以及哪些 slug 已被占。
      const existing = await listDeliverables(ctx.fs, cwd);
      // 同一个 callId 已经落过（重复的 result 事件）⇒ 不落第二份。
      if (existing.some((entry) => entry.callId === paired.callId)) return;
      const taken = new Set(existing.map((entry) => entry.slug));
      const slug = taken.has(documents.slug) ? freeSlug(documents.slug, taken) : documents.slug;
      // slug 与 `manifest.slug` **两个都得改**：T2 的存储层有位置闸（manifest 记的 slug 必须等于
      // 它所在目录的名字），只改一个，这份交付物在 `listDeliverables` 眼里就不存在 —— 比撞名还糟。
      await writeDeliverable(ctx.fs, cwd, slug === documents.slug ? documents
        : { slug, manifest: { ...documents.manifest, slug }, version: documents.version });
    }).catch(noteWriteFailure)
      // 兜底：`noteWriteFailure` 自己抛（宿主日志管道坏了、`String(cause)` 抛）时，也不能把链留成
      // rejected —— 那会让后面每一份都被跳过、静默丢弃。**别把这一行当冗余删掉**：
      // 它保的就是"一次报错不牵连后面的落盘"。
      .catch(() => {});
  });
}

// 配对 id 的读法只有一份：`callIdOfResult`（从 `tool-call-pairing.js` 导入）。
