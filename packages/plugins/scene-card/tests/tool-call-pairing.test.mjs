/**
 * 配对器：`tool/call` 给名字与入参，`tool/result` 给数据，两者靠 callId 对上。
 * 为什么单独一个纯类：配对顺序、丢 call、重复 result 这几个错法最容易漏，而它们不需要真会话就能测。
 * 跑法：node --test packages/plugins/scene-card/tests/tool-call-pairing.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallPairing, parseJsonText, MAX_PENDING } from '../dist/runtime/tool-call-pairing.js';

const call = (callId, name, args) => ({
  type: 'tool/call',
  data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) },
});

/** `tool/result` 的形状：顶层**既无 callId 也无 name**，id 落在 message.source.callId。 */
const result = (callId, payload) => ({
  type: 'tool/result',
  data: { turn: 1, step: 1,
    message: { role: 'tool', source: { kind: 'tool', callId },
      toolCallId: callId, content: [{ type: 'text', text: JSON.stringify(payload) }] } },
});

const userMessage = (text) => ({ type: 'user/message', data: { message: { role: 'user',
  content: [{ type: 'text', text }] } } });

test('call 之后 result ⇒ 配得上一对，两个字段都在', () => {
  const pairing = new ToolCallPairing();
  pairing.note(call('c1', 'mcp__geoclar__geoclar_recommend_schemes', { wkt: 'W' }));
  pairing.note(result('c1', { mode: 'custom' }));
  const paired = pairing.take('c1');
  assert.equal(paired.toolName, 'mcp__geoclar__geoclar_recommend_schemes');
  assert.deepEqual(paired.args, { wkt: 'W' });
  assert.deepEqual(paired.result, { mode: 'custom' });
});

test('take 之后清除：同一 callId 不会配出第二次', () => {
  const pairing = new ToolCallPairing();
  pairing.note(call('c1', 't', {}));
  pairing.note(result('c1', { a: 1 }));
  assert.ok(pairing.take('c1'));
  assert.equal(pairing.take('c1'), undefined);
});

test('只有 result 没有 call（窗口截断）⇒ 取不到，而不是拼半份', () => {
  const pairing = new ToolCallPairing();
  pairing.note(result('c9', { a: 1 }));
  assert.equal(pairing.take('c9'), undefined);
});

test('孤儿 result 先到、call 后到 ⇒ 不能拿旧 result 错配（无闸时会配出一对）', () => {
  const pairing = new ToolCallPairing();
  pairing.note(result('c1', { stale: true }));   // 先来的 result 配不到当时的任何 call
  pairing.note(call('c1', 't', {}));
  assert.equal(pairing.take('c1'), undefined);
});

test('只有 call 没有 result（还在跑）⇒ 取不到', () => {
  const pairing = new ToolCallPairing();
  pairing.note(call('c1', 't', {}));
  assert.equal(pairing.take('c1'), undefined);
});

/**
 * 配对 id 的两条读法各钉一条。**故意不钉谁优先** —— 官方 `ToolResultMessage` 里
 * `source.callId` 与 `toolCallId` 都是必填，平台没有定义优先级，钉一个胜者等于凭空造规则。
 * 这里只要求：任何一条单独存在时都读得出 id。夹具同时给两个字段时两条读法会互相遮蔽，
 * 所以这两条必须只给其中一个。
 */
test('id 只在 message.source.callId（无 toolCallId）⇒ 照样配得上', () => {
  const pairing = new ToolCallPairing();
  pairing.note(call('c1', 't', {}));
  pairing.note({ type: 'tool/result', data: { message: { role: 'tool', source: { kind: 'tool', callId: 'c1' },
    content: [{ type: 'text', text: '{"a":1}' }] } } });
  assert.deepEqual(pairing.take('c1')?.result, { a: 1 });
});

test('id 只在 message.toolCallId（无 source）⇒ 照样配得上', () => {
  const pairing = new ToolCallPairing();
  pairing.note(call('c1', 't', {}));
  pairing.note({ type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'c1',
    content: [{ type: 'text', text: '{"a":1}' }] } } });
  assert.deepEqual(pairing.take('c1')?.result, { a: 1 });
});

test('入参不是 JSON ⇒ 整个配对放弃，不拿半个入参去写文件', () => {
  const pairing = new ToolCallPairing();
  pairing.note({ type: 'tool/call', data: { callId: 'c1', name: 't', arguments: '不是 JSON' } });
  pairing.note(result('c1', { a: 1 }));
  assert.equal(pairing.take('c1'), undefined);
});

test('结果里那段文本不是 JSON ⇒ 放弃', () => {
  const pairing = new ToolCallPairing();
  pairing.note(call('c1', 't', {}));
  pairing.note({ type: 'tool/result', data: { message: { source: { callId: 'c1' },
    content: [{ type: 'text', text: '不是 JSON' }] } } });
  assert.equal(pairing.take('c1'), undefined);
});

test('用户消息被记住，取最近一条', () => {
  const pairing = new ToolCallPairing();
  pairing.note(userMessage('第一句'));
  pairing.note(userMessage('霍尔木兹海峡近三月影像组合'));
  assert.equal(pairing.latestUserMessage(), '霍尔木兹海峡近三月影像组合');
});

test('没有用户消息时给空串（调用方据此退回时间戳）', () => {
  assert.equal(new ToolCallPairing().latestUserMessage(), '');
});

test('parseJsonText：单块 text 才认，多块/非 text 一律不认', () => {
  assert.deepEqual(parseJsonText({ content: [{ type: 'text', text: '{"a":1}' }] }), { a: 1 });
  assert.equal(parseJsonText({ content: [{ type: 'text', text: '{}' }, { type: 'text', text: '{}' }] }), undefined);
  assert.equal(parseJsonText({ content: [{ type: 'image', text: '{}' }] }), undefined);
  assert.equal(parseJsonText({}), undefined);
});

/**
 * 滞留上界。生产者只 `take` 它关心的那一个工具（geoclar），会话里**其余每次**工具调用的
 * 结果载荷都不该被它一直攥着 —— 这个进程要活到会话结束。所以 `pending` 与 `settled` 两个账
 * 都必须有界。
 *
 * 但**光断言有界不够**："越界就把两个账全清空"同样有界。所以这里还钉住边界那一下 ——
 * 正好超出上界一条时，淘汰的必须只是**最老**那条，边界上刚拿到的结果要留得住；
 * 以及无论喂多少轮，最近一对仍取得出。（实测：只靠"最近一对取得出"抓不住全清空那种写法。）
 */
test('喂远超上界次数的调用 ⇒ 两个账都不越界，且最近一对仍取得出', () => {
  const pairing = new ToolCallPairing();
  const feed = (i) => {
    pairing.note(call('k' + i, 'bash', { i }));
    pairing.note(result('k' + i, { i }));
  };

  // 边界：正好超出上界一条时，淘汰的必须是**最老**那条，而边界上最新这次的结果仍要留得住。
  // 这一条专挡"越界就把两个账全清空"那种钝做法 —— 它上界也满足、跑完也还有最近一对，
  // 却会在边界上丢掉刚刚拿到的结果。光看"最近一对取得出"是抓不住它的。
  for (let i = 0; i <= MAX_PENDING; i++) feed(i);
  assert.equal(pairing.take('k0'), undefined, '超出上界后最老那条应已淘汰');
  assert.deepEqual(pairing.take('k' + MAX_PENDING)?.result, { i: MAX_PENDING }, '边界上最新这次不该被丢');

  // 再喂到远超上界：两个账都不越界，且最近一对仍取得出。
  const total = MAX_PENDING * 3 + 7;
  for (let i = MAX_PENDING + 1; i < total; i++) feed(i);
  const kept = pairing.retained();
  assert.ok(kept.pending <= MAX_PENDING, `pending 滞留 ${kept.pending} 条，越界`);
  assert.ok(kept.settled <= MAX_PENDING, `settled 滞留 ${kept.settled} 条，越界`);
  assert.deepEqual(pairing.take('k' + (total - 1))?.result, { i: total - 1 });
});
