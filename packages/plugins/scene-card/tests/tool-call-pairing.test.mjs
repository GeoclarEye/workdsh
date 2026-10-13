/**
 * 配对器：`tool/call` 给名字与入参，`tool/result` 给数据，两者靠 callId 对上。
 * 为什么单独一个纯类：配对顺序、丢 call、重复 result 这几个错法最容易漏，而它们不需要真会话就能测。
 * 跑法：node --test packages/plugins/scene-card/tests/tool-call-pairing.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallPairing, parseJsonText } from '../dist/runtime/tool-call-pairing.js';

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

test('只有 call 没有 result（还在跑）⇒ 取不到', () => {
  const pairing = new ToolCallPairing();
  pairing.note(call('c1', 't', {}));
  assert.equal(pairing.take('c1'), undefined);
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
