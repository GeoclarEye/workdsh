/**
 * 受控自动弹的判据（spec §4.5）。
 *
 * 判据是"**该不该调用 `openTabIn`**"，不是"界面看起来对"：`openTabIn` 恒会展开右侧栏
 * （Task 1 §9-8 核实），所以每一条"不弹"都真的是"别动用户的布局"。
 *
 * 入参是五个布尔（Task 1 §9-6 核实：**拿不到**"用户手动关掉"的信号，故没有
 * `userDismissed` 这一维；它原本承担的意图由 `openedThisTurn` 兜住）。
 *
 * 跑法：node --test packages/plugins/scene-card/tests/auto-open.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoOpen } from '../dist/client/auto-open.js';

/** 全部"不弹"的理由都关掉，只剩"该弹"的那一组事实。 */
const facts = (over = {}) => ({
  hasDeliverable: true,
  alreadyOpen: false,
  openedThisTurn: false,
  narrow: false,
  boundToOtherCall: false,
  ...over,
});

test('首次出现且未开 → 弹', () => {
  assert.equal(shouldAutoOpen(facts()), true);
});

test('本插件的 tab 已开着（就是这一件）→ 不弹，别无谓地再展开一次', () => {
  assert.equal(shouldAutoOpen(facts({ alreadyOpen: true })), false);
});

test('本轮弹过一次 → 不再弹（一轮可能调三次工具）', () => {
  assert.equal(shouldAutoOpen(facts({ openedThisTurn: true })), false);
});

test('即使面板已经被关掉，本轮也不再弹（拿不到拒绝信号，用这一维兜住）', () => {
  // 这一条就是 §9-6 的退路：用户关掉后本轮不再弹的意图，由 openedThisTurn 承担。
  assert.equal(shouldAutoOpen(facts({ alreadyOpen: false, openedThisTurn: true })), false);
});

test('窄屏 → 不弹（窄屏是覆盖式全屏，会盖住对话；阈值 768px）', () => {
  assert.equal(shouldAutoOpen(facts({ narrow: true })), false);
});

test('面板开着但绑的是别的 callId → 不夺焦点（用户可能正在看历史那一件）', () => {
  assert.equal(shouldAutoOpen(facts({ boundToOtherCall: true })), false);
});

test('两个"已开着"的形态同时出现也不弹', () => {
  assert.equal(shouldAutoOpen(facts({ alreadyOpen: true, boundToOtherCall: true })), false);
});

test('没有交付物 → 不弹（空池时 buildDeliverableView 有返回但 primary 是 undefined）', () => {
  assert.equal(shouldAutoOpen(facts({ hasDeliverable: false })), false);
});

test('没有交付物压过一切：其余维度再有利也不弹', () => {
  assert.equal(shouldAutoOpen(facts({ hasDeliverable: false, alreadyOpen: false,
    openedThisTurn: false, narrow: false, boundToOtherCall: false })), false);
});

test('耗时列不参与这一判断：入参里没有时间字段的位置', () => {
  // 五维之外多给的键不得改变结论 —— 防的是"顺手把别的东西塞进判据"。
  assert.equal(shouldAutoOpen({ ...facts(), durationMs: 1234, turn: 7 }), true);
});
