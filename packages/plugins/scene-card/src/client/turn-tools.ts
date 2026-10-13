/**
 * 面板读对话数据的唯一一条路：**由一个 `callId` 反查它所在的那一轮，再取那一轮的工具调用**。
 *
 * 为什么需要它：面板是**按调用（`callId`）参数化**的活状态（spec §4.3），可它的「步骤」
 * 与「用到的工具」讲的是**整轮**的事 —— 一次检索是一串调用（先看范围、再检索、最后算方案），
 * 单独一次 `geoclar_recommend_schemes` 讲不出"这一步之前发生了什么"。
 *
 * 输入是**运行时数据**（`ChatSnapshot` 是官方结构，形状没有保证），所以这一层：
 *   · 只读要显示的那几个字段，多一个都不读；
 *   · 形状不认识就返回 `undefined`，调用方据此**不画**这一块 —— 不猜、不编。
 *
 * 与 `scheme-view.ts` 同一套严格度：**缺 → 少一块，有但读不懂 → 整份不画**。
 */

/** 由 callId 找到的那一轮里，一次工具调用要显示的全部读数。 */
export interface TurnTool {
  /** 面板按它认"哪一行是这一件交付物"。 */
  readonly callId: string;
  /** 显示用的名字；窗口截断把 call 头落在窗外时是 `callId` 本身。 */
  readonly name: string;
  /** 还在跑（没有 result 节点）。 */
  readonly running: boolean;
  /**
   * 耗时（毫秒）。**只有"已完成且配得上 call 时刻"的行才有值**：
   * `callTime === null` 表示窗口截断把配对的 `tool/call` 落在了窗外（Task 1 §9-5），
   * 那不是"0 秒"也不是"未知"，所以这里是 `null`，UI 整格不出、也不写占位符。
   */
  readonly durationMs: number | null;
  /** 结果节点原文（运行中为 `undefined`）；面板据此建视图模型，不重解析。 */
  readonly root: unknown;
}

/** 一次交付物所在的那一轮：轮次号 + 该轮的工具调用（按对话锚点顺序）。 */
export interface TurnTools {
  readonly turn: number;
  readonly tools: readonly TurnTool[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readText(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readTime(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 一个 chat 节点的轮次号。`ConversationLocation` 是四分支联合：
 * `session` / `unresolved` 两个分支**没有** `turn` 键，所以按形状读而不是按 `kind` 断言 ——
 * 官方加分支时这里只会返回 `undefined`，不会读出垃圾值。
 */
function readTurnOfNode(raw: unknown): number | undefined {
  if (!isRecord(raw)) return undefined;
  const location = raw.location;
  if (!isRecord(location)) return undefined;
  const turn = location.turn;
  if (!isRecord(turn)) return undefined;
  return readTime(turn, 'turn');
}

/** 根节点上的 callId：轮次无关，两种生命周期都有。 */
function readCallId(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  return readText(raw, 'callId');
}

/** 节点集合的形状（`ChatNodeStore` 里这一层用到的部分）。 */
interface NodeStoreShape {
  readonly values: () => unknown;
  readonly turnDataSource: (turn: number, kind: string) => { readonly getSnapshot: () => unknown };
}

function readNodeStore(chat: unknown): NodeStoreShape | undefined {
  if (!isRecord(chat)) return undefined;
  const nodes = chat.nodes;
  if (!isRecord(nodes)) return undefined;
  const values = nodes.values;
  const turnDataSource = nodes.turnDataSource;
  if (typeof values !== 'function' || typeof turnDataSource !== 'function') return undefined;
  return nodes as unknown as NodeStoreShape;
}

/** 该 `callId` 所在轮次的号；读不出来时 `undefined`（调用方据此不画步骤块）。 */
export function turnOfCall(chat: unknown, callId: string): number | undefined {
  const nodes = readNodeStore(chat);
  if (nodes === undefined) return undefined;
  const list = nodes.values();
  if (!Array.isArray(list)) return undefined;
  for (const candidate of list) {
    if (!isRecord(candidate)) continue;
    if (candidate.kind !== 'tool-call') continue;
    const root = isRecord(candidate.data) ? candidate.data.root : undefined;
    if (readCallId(root) !== callId) continue;
    return readTurnOfNode(candidate);
  }
  return undefined;
}

/**
 * 一个根节点 → 一行读数。`ToolCallBlock` 是 `RunningToolCall | ToolResultNode` 的联合，
 * 用有无 `kind: 'tool-result'` 分流：`start`/`preparing` 两态都算"还在跑"。
 */
function readTool(root: unknown): TurnTool | undefined {
  if (!isRecord(root)) return undefined;
  const callId = readCallId(root);
  if (callId === undefined) return undefined;

  if (root.kind === 'tool-result') {
    // 判据只看 `kind`：`call` 为 null 是窗口截断的合法形态（那时 head 显示 callId）。
    const head = isRecord(root.call) ? root.call : undefined;
    const name = (head === undefined ? undefined : readText(head, 'name')) ?? callId;
    const time = readTime(root, 'time');
    const callTime = readTime(root, 'callTime');
    const durationMs = time !== undefined && callTime !== undefined ? Math.max(0, time - callTime) : null;
    return { callId, name, running: false, durationMs, root };
  }

  const name = readText(root, 'name') ?? callId;
  return { callId, name, running: true, durationMs: null, root };
}

/**
 * 该 `callId` 所在那一轮的步骤。返回 `undefined` 的三种情形（都不画，而不是画个空壳）：
 * 形状不认识、找不到这个 callId、节点上没有可解析的轮次。
 */
export function readTurnTools(chat: unknown, callId: string): TurnTools | undefined {
  const turn = turnOfCall(chat, callId);
  if (turn === undefined) return undefined;
  const nodes = readNodeStore(chat);
  if (nodes === undefined) return undefined;
  const raw = nodes.turnDataSource(turn, 'tool-call').getSnapshot();
  if (!Array.isArray(raw)) return undefined;
  const tools: TurnTool[] = [];
  for (const entry of raw) {
    const tool = readTool(isRecord(entry) ? entry.root : undefined);
    if (tool === undefined) return undefined;
    tools.push(tool);
  }
  return { turn, tools };
}

/**
 * 工具名 → 人话。MCP 的线格式是 `mcp__<连接器 serverName>__<工具名>`（connection 侧拼的），
 * 面板里显示后一段就够了 —— 每行都重复一遍 `mcp__geoclar__` 只是噪音。
 * 不匹配这个形状的名字**原样显示**：编一个名字比显示 `bash` 更糟。
 */
export function toolLabel(name: string): string {
  const parts = name.split('__');
  if (parts.length >= 3 && parts[0] === 'mcp') return parts.slice(2).join('__');
  return name;
}

/**
 * 耗时。**只有两个量级**：不足 1 秒给毫秒（工具偶发很快，`0.0s` 等于没说），
 * 1 秒以上一位小数（与卡片里覆盖率/云量的口径一致），过分钟再给「m ss」。
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`;
}
