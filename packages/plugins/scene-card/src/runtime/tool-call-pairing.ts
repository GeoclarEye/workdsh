/**
 * 把会话事件流里的 `tool/call` 与 `tool/result` 配成一对。**纯逻辑**，不碰 ctx、不碰盘。
 *
 * 为什么必须配对（spec §4）：`tool/result` 的载荷里**既无工具名也无顶层 callId** ——
 * 名字在配对的 `tool/call` 上，id 埋在 `message.source.callId` 里。所以"先认 call、再等 result"。
 *
 * 为什么不按 `sourceEventSeqs` 配：那需要访问事件的 seq 与事件表，而本类只吃 `{type, data}` 两个字段
 * （会话事件对象直接喂得进来）。按 `callId` 配对的错法在这里被测试逐条钉住，够用。
 *
 * 输入是**运行时数据**，形状没有保证：读不懂就放弃这一次，绝不拼半份。
 */

export interface PairedCall {
  readonly callId: string;
  readonly toolName: string;
  /** `tool/call` 的 arguments，**已解析**。 */
  readonly args: unknown;
  /** `tool/result` 里那段 JSON，**已解析**。 */
  readonly result: unknown;
}

/** 事件里本类用到的部分；会话事件对象直接喂。 */
export interface PairingInput {
  readonly type: string;
  readonly data: unknown;
}

interface PendingCall {
  readonly toolName: string;
  readonly args: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 从结果的那块内容里取出 JSON。**只在恰好一块、且是 text 时**认 ——
 * 多块就意味着这次结果不止一段 JSON，猜哪一段都是编。
 */
export function parseJsonText(message: unknown): unknown {
  if (!isRecord(message)) return undefined;
  const content = message.content;
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const only = content[0];
  if (!isRecord(only) || only.type !== 'text' || typeof only.text !== 'string') return undefined;
  try {
    return JSON.parse(only.text);
  } catch {
    return undefined;
  }
}

/** `tool/call` 的 `arguments` 是一段 JSON 文本；解析不了就整次放弃。 */
function parseArguments(raw: unknown): { ok: true; value: unknown } | { ok: false } {
  if (typeof raw !== 'string') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/**
 * `tool/result` 里那个配对 id：顶层没有，落在 `message.source.callId`（退回 `message.toolCallId`）。
 *
 * **导出**：生产者也要读同一个 id（`deliverable-producer.ts`）。这条读法最容易写错（id 埋在
 * `message` 里而不是顶层），两处各写一份必然漂移。
 */
export function callIdOfResult(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const message = data.message;
  if (!isRecord(message)) return undefined;
  const source = message.source;
  if (isRecord(source) && typeof source.callId === 'string' && source.callId !== '') return source.callId;
  const direct = message.toolCallId;
  return typeof direct === 'string' && direct !== '' ? direct : undefined;
}

/** 从用户消息里取第一段文本（subject 的来源，spec §9.4）。 */
function textOfUserMessage(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const message = data.message;
  const parsed = parseJsonText(message);
  if (typeof parsed === 'string') return parsed;
  if (!isRecord(message)) return undefined;
  const content = message.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      return block.text;
    }
  }
  return undefined;
}

/**
 * 一个会话的配对器。**每个会话一个实例** —— callId 只在会话内唯一。
 *
 * 两个账都只留最近 `MAX_PENDING` 条：一次会话里排队的调用不该无界增长，
 * 而超出的那些本来就是"很久没等到 result"的，丢了也不影响正确性（取不到就不落）。
 *
 * `settled` 也必须跟着 `pending` 一起淘汰，且理由不只是对称：生产者只 `take` 它关心的
 * 那一个工具（geoclar），会话里其余每次工具调用的结果载荷**永远不会被 take 走** ——
 * 而这个 Map 活在本进程里、与会话同寿。只有淘汰 `pending` 时顺手删掉同 id 的 `settled`，
 * 才能让它保持有界（`settled` 的键始终是 `pending` 键的子集）。
 */
export const MAX_PENDING = 64;

export class ToolCallPairing {
  private readonly pending = new Map<string, PendingCall>();
  private readonly settled = new Map<string, unknown>();
  private userMessage = '';

  note(input: PairingInput): void {
    // 用户消息也走这条流 —— 生产者订阅的是**全部**事件，所以 subject 是顺手就有，
    // 不必另问一次会话服务（spec §9.4 原本列为待核，这里解决）。
    if (input.type === 'user/message') {
      const text = textOfUserMessage(input.data);
      if (text !== undefined) this.userMessage = text;
      return;
    }
    if (input.type === 'tool/call') {
      if (!isRecord(input.data)) return;
      const callId = input.data.callId;
      const name = input.data.name;
      if (typeof callId !== 'string' || callId === '' || typeof name !== 'string') return;
      const parsed = parseArguments(input.data.arguments);
      if (!parsed.ok) return;                       // 入参读不懂 ⇒ 这次不落，别拿半个入参去写文件
      this.pending.set(callId, { toolName: name, args: parsed.value });
      if (this.pending.size > MAX_PENDING) {
        const oldest = this.pending.keys().next();
        if (!oldest.done) {
          // 被淘汰的 call 已经不可能再配成对（`take` 要求 `pending` 与 `settled` 同时在），
          // 它的结果留着也取不走 —— 顺手删掉，否则 `settled` 随会话无限涨。
          this.pending.delete(oldest.value);
          this.settled.delete(oldest.value);
        }
      }
      return;
    }
    if (input.type === 'tool/result') {
      const callId = callIdOfResult(input.data);
      if (callId === undefined) return;
      const payload = parseJsonText(isRecord(input.data) ? input.data.message : undefined);
      if (payload === undefined) return;            // 结果读不懂 ⇒ 放弃
      if (!this.pending.has(callId)) return;        // 没有配对的 call（窗口截断）：不拼半份
      this.settled.set(callId, payload);
    }
  }

  /** 取走并清除一次配好的调用。没配齐 / 已取过 ⇒ `undefined`。 */
  take(callId: string): PairedCall | undefined {
    const pending = this.pending.get(callId);
    const result = this.settled.get(callId);
    if (pending === undefined || result === undefined) return undefined;
    this.pending.delete(callId);
    this.settled.delete(callId);
    return { callId, toolName: pending.toolName, args: pending.args, result };
  }

  /**
   * 该会话最近一条用户消息；没有时是空串（调用方据此退回只用时间戳）。
   *
   * 形状读不懂的新用户消息（纯图、空 content、`message` 不成形）**不清空**上一条，这是**有意的**：
   * subject 略旧也好过没有 —— 交付物总得有个名字，而目录名靠前缀时间戳仍然唯一且有序。
   * 别把它"修"成空串。
   */
  latestUserMessage(): string {
    return this.userMessage;
  }

  /**
   * 只为诊断与测试：这两个账都是**有界**的（见 {@link MAX_PENDING}）。
   * 生产者只 `take` 它关心的那一个工具，其余调用的结果载荷不能无限滞留。
   */
  retained(): { readonly pending: number; readonly settled: number } {
    return { pending: this.pending.size, settled: this.settled.size };
  }
}
