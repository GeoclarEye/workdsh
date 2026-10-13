/**
 * 面板读对话数据的那个纯函数：由一个 `callId` 反查它**所在轮次**、以及那一轮的工具调用。
 *
 * 两条来自 spec 的硬要求：
 *   · §4.4 面板的「步骤」是**该 `callId` 所在的那一轮**（不是"全局最近一轮"）；
 *   · §7 「耗时」= `block.time − block.callTime`，**`callTime` 为 `null` 的行不出耗时**
 *     （Task 1 裁定：它既不是 0 秒也不是"未知"，只是窗口截断没配上 call 时刻 ⇒ 不写「—」）。
 *
 * 夹具照官方类型的形状手写（`ChatSnapshot.nodes` → `values()` / `turnDataSource()`），
 * 不是从真机上抄的数值 —— 这里测的是"读法"，真形状由真实运行另证（见报告）。
 *
 * 运行：node --test packages/plugins/scene-card/tests/turn-tools.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readTurnTools, turnOfCall, toolLabel, formatDuration }
  from '../dist/client/turn-tools.js';

/** 一个已完成的工具调用结果节点（官方 `ToolResultNode` 的字段）。 */
const settled = (callId, name, { time = 2000, callTime = 1000, content } = {}) => ({
  kind: 'tool-result', seq: 1, time, callId, call: { name, argsRaw: '{}' }, callTime,
  content: content ?? [{ type: 'text', text: '{}' }], isError: false, subCalls: [],
});

/** 一个还在跑的工具调用（官方 `StartedToolCall` 的字段）。 */
const running = (callId, name) => ({ phase: 'start', callId, name, turn: 1, step: 1,
  time: 3000, argsRaw: '{}', subCalls: [] });

/** 一个 chat 节点：轮次写在 `location.turn.turn` 上（`ConversationLocation` 的 turn 分支）。 */
const node = (root, turn) => ({ key: `k:${root.callId}`, kind: 'tool-call', id: root.callId,
  target: 'chat', anchorSeq: root.seq ?? 0, data: { root },
  location: { kind: 'step', turn: { turn, steps: [] }, step: { turn: { turn }, step: 1 } },
  visibility: 'visible' });

/** 一个会话快照的最小形状：`values()` 找轮次、`turnDataSource(turn,'tool-call')` 取成员。 */
function chatOf(nodes) {
  return {
    order: nodes.map((n) => n.key),
    nodes: {
      values: () => nodes,
      turnDataSource: (turn) => ({
        getSnapshot: () => nodes.filter((n) => n.location.turn.turn === turn).map((n) => n.data),
      }),
    },
  };
}

test('由 callId 反查它所在的那一轮，并按 `turnDataSource` 取该轮全部工具调用', () => {
  const chat = chatOf([
    node(settled('call-a', 'geoclar_inspect_aoi'), 1),
    node(settled('call-b', 'geoclar_search_scenes'), 1),
    node(settled('call-c', 'geoclar_recommend_schemes'), 1),
  ]);
  const turn = readTurnTools(chat, 'call-b');
  assert.equal(turn.turn, 1);
  assert.deepEqual(turn.tools.map((tool) => tool.callId), ['call-a', 'call-b', 'call-c']);
});

test('取的是**那一轮**的调用，不是全局最近一轮', () => {
  const chat = chatOf([
    node(settled('call-old', 'read'), 1),
    node(settled('call-new', 'bash'), 2),
  ]);
  const turn = readTurnTools(chat, 'call-old');
  assert.equal(turn.turn, 1);
  assert.deepEqual(turn.tools.map((tool) => tool.callId), ['call-old'],
    '第 2 轮那次调用不该出现在第 1 轮的步骤里');
});

test('耗时 = block.time − block.callTime', () => {
  const chat = chatOf([node(settled('call-a', 'bash', { time: 9500, callTime: 1000 }), 1)]);
  assert.equal(readTurnTools(chat, 'call-a').tools[0].durationMs, 8500);
});

test('callTime 为 null（窗口截断）→ 没有耗时，也不写成 0', () => {
  // 「没有配对的 call 时刻」不是"0 秒"也不是"未知"，所以这里是 null 而不是某个占位值 ——
  // UI 那一侧据 null 整格不出（不写「—」）。
  const chat = chatOf([node(settled('call-a', 'bash', { callTime: null }), 1)]);
  assert.equal(readTurnTools(chat, 'call-a').tools[0].durationMs, null);
});

test('还在跑的调用没有耗时（拿不到 result 时刻）且标成 running', () => {
  const chat = chatOf([node(running('call-a', 'bash'), 1)]);
  const tool = readTurnTools(chat, 'call-a').tools[0];
  assert.equal(tool.running, true);
  assert.equal(tool.durationMs, null);
});

test('已完成 / 运行中两态取自节点本身，同一轮里可以并存', () => {
  const chat = chatOf([node(settled('call-a', 'bash'), 1), node(running('call-b', 'read'), 1)]);
  const tools = readTurnTools(chat, 'call-a').tools;
  assert.deepEqual(tools.map((tool) => [tool.callId, tool.running]), [['call-a', false], ['call-b', true]]);
});

test('窗口截断把 call 头落在窗外：`call` 为 null 时用 callId 当名字，仍然出这一行', () => {
  const truncated = { ...settled('call-a', 'bash'), call: null, callTime: null };
  const chat = chatOf([node(truncated, 1)]);
  const tool = readTurnTools(chat, 'call-a').tools[0];
  assert.equal(tool.name, 'call-a');
  assert.equal(tool.durationMs, null);
});

test('找不到这个 callId、或形状不认识 → undefined（调用方据此不画这一块）', () => {
  const chat = chatOf([node(settled('call-a', 'bash'), 1)]);
  assert.equal(readTurnTools(chat, 'call-nope'), undefined);
  assert.equal(readTurnTools(undefined, 'call-a'), undefined);
  assert.equal(readTurnTools({}, 'call-a'), undefined);
  assert.equal(readTurnTools({ nodes: { values: () => 'nope' } }, 'call-a'), undefined);
});

test('节点没有可解析的轮次（session/unresolved 分支）→ undefined，不猜一轮', () => {
  const orphan = { ...node(settled('call-a', 'bash'), 1), location: { kind: 'unresolved' } };
  assert.equal(readTurnTools(chatOf([orphan]), 'call-a'), undefined);
});

test('turnOfCall 与 readTurnTools 对轮次的口径一致', () => {
  const chat = chatOf([node(settled('call-a', 'bash'), 4)]);
  assert.equal(turnOfCall(chat, 'call-a'), 4);
  assert.equal(turnOfCall(chat, 'nope'), undefined);
});

test('工具名：MCP 的连接器前缀剥掉，原生工具名原样', () => {
  assert.equal(toolLabel('mcp__geoclar__geoclar_inspect_aoi'), 'geoclar_inspect_aoi');
  assert.equal(toolLabel('mcp__geoclar__geoclar_recommend_schemes'), 'geoclar_recommend_schemes');
  assert.equal(toolLabel('read'), 'read');
  assert.equal(toolLabel('bash'), 'bash');
  // 名字里带下划线但不带连接器前缀的东西不该被切。
  assert.equal(toolLabel('mcp__double_underscore'), 'mcp__double_underscore');
});

test('耗时格式化：不足 1 秒用毫秒，其余 1 位小数秒，过分钟给「m ss」', () => {
  assert.equal(formatDuration(840), '840ms');
  assert.equal(formatDuration(1000), '1.0s');
  assert.equal(formatDuration(8500), '8.5s');
  assert.equal(formatDuration(59_400), '59.4s');
  assert.equal(formatDuration(62_000), '1m 02s');
});
