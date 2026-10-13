/**
 * 生产者（spec §4）：**不经模型判断、不经用户操作** —— 工具返回方案的那一刻就把交付物落到工作区。
 *
 * 两条与先例一致的做法（`projects/src/runtime/deliverable-attribution.ts`）：
 *   · 订阅挂在**根 context**上，监听**全部**会话（agent-scoped 只听自己进入的会话，spec §4）；
 *   · 监听器**立刻返回**，落盘在微任务里跑 —— 一次慢写不该拖住别人的会话提交。
 *
 * 每个会话一个配对器（callId 只在会话内唯一），随会话第一次出现时创建。
 */
import { buildDeliverableDocuments } from './deliverable-document.js';
import { resolveCallId, writeDeliverable, type StoreFs } from './deliverable-store.js';
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

export function registerDeliverableProducer(ctx: ProducerContext): void {
  const logger = ctx.logger('workdsh-scene-card');
  /** 会话 id → 配对器。会话数量有界（一次进程的活跃会话），不必淘汰。 */
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
    const callId = callIdOfResult(event.data);
    if (callId === undefined) return;
    const paired = pairing.take(callId);
    if (paired === undefined) return;

    // 立刻返回，落盘在微任务里跑 —— 慢写不拖住会话提交。
    void Promise.resolve().then(async () => {
      const cwd = session.header?.cwd;
      if (cwd === undefined || cwd === '') {
        // spec §7：会话没有 cwd（持久化层把这类会话落进 _no-cwd）⇒ 记一条日志，不抛。
        logger.warn('交付物跳过：会话没有 cwd');
        return;
      }
      const documents = buildDeliverableDocuments({
        callId: paired.callId, toolName: paired.toolName, args: paired.args, result: paired.result,
        subject: pairing.latestUserMessage(), at: new Date(),
      });
      // 形状读不懂 ⇒ 这次不落。**不记日志**：那是"这个工具返回了别的东西"，不是异常。
      if (documents === undefined) return;
      // 同一个 callId 已经落过（重复的 result 事件）⇒ 不落第二份。
      if (await resolveCallId(ctx.fs, cwd, paired.callId) !== undefined) return;
      await writeDeliverable(ctx.fs, cwd, documents);
    }).catch((cause: unknown) => {
      // 落盘失败不该冒到会话事件流上：流是 fire-and-forget，别人还在提交。
      logger.warn(`交付物落盘失败：${cause instanceof Error ? cause.message : String(cause)}`);
    });
  });
}

// 配对 id 的读法只有一份：`callIdOfResult`（从 `tool-call-pairing.js` 导入）。
