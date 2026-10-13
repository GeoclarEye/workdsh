/**
 * 纯函数：一次工具调用 → 两份 JSON 的内容。不碰 IO，所以直接喂真形状。
 * 跑法：node --test packages/plugins/scene-card/tests/deliverable-document.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeliverableDocuments, slugOf } from '../dist/runtime/deliverable-document.js';

/** 工具调用的入参（`tool/call` 的 arguments，已解析）。 */
const args = {
  wkt: 'POLYGON((116 39, 117 39, 117 40, 116 40, 116 39))',
  maxCloud: 20,
  budget: 8000000,
  dateFrom: '2025-01-01',
};

/** 出参（`tool/result` 里那段 JSON，已解析）——夹具与 scheme-view 测试共用同一形状。 */
const result = {
  mode: 'custom',
  poolAtLimit: false,
  schemes: [{ key: 'CUSTOM', sceneCount: 235, coveragePercent: 65.16, uncoveredAreaKm2: 19239.18,
    estimatedAmount: 5564229.98, pricingComplete: true, budgetCapped: false,
    budgetFullCoverageAmount: null, dateFrom: '2024-12-06', dateTo: '2026-10-09',
    gsdMin: 0.25, gsdMax: 0.5, cloudCoverMax: 33, cloudCoverMean: 1.33, scenes: [] }],
};

const at = new Date('2026-10-13T12:58:00+08:00');

test('正常一次调用 → 两份文档都在，字段与约定一致', () => {
  const built = buildDeliverableDocuments({
    callId: 'call_abc', toolName: 'mcp__geoclar__geoclar_recommend_schemes',
    args, result, subject: '霍尔木兹海峡近三月影像组合', at,
  });
  assert.ok(built);
  assert.equal(built.manifest.format, 'workdsh-deliverable');
  assert.equal(built.manifest.schemaVersion, 1);
  assert.equal(built.manifest.callId, 'call_abc');
  assert.equal(built.manifest.subject, '霍尔木兹海峡近三月影像组合');
  assert.equal(built.manifest.current, 'v1.json');
  assert.deepEqual(built.manifest.versions.map((v) => v.file), ['v1.json']);
  assert.equal(built.version.format, 'workdsh-deliverable');
  assert.equal(built.version.type, 'scene-schemes');
  // payload 逐字来自出参 —— 同一个对象，不是重建的。
  assert.equal(built.version.payload, result);
  // 目录名以时间戳打头（UTC：12:58+08:00 = 04:58Z），且不含路径分隔符。
  assert.match(built.slug, /^20261013-045800-/);
  assert.ok(!built.slug.includes('/'));
});

test('intent 逐字抄入参：AOI + 给过的条件，未给的不出现', () => {
  const built = buildDeliverableDocuments({
    callId: 'call_abc', toolName: 'mcp__geoclar__geoclar_recommend_schemes',
    args, result, subject: 's', at,
  });
  assert.equal(built.version.intent.tool, 'geoclar_recommend_schemes');
  assert.equal(built.version.intent.scheme, 'CUSTOM');
  assert.equal(built.version.intent.aoi, args.wkt);
  assert.deepEqual(built.version.intent.conditions,
    { maxCloud: 20, budget: 8000000, dateFrom: '2025-01-01' });
  // 没给的 maxGsd / dateTo / datasetIds / offNadirMax / preferConsistent 一个都不写。
  assert.equal('maxGsd' in built.version.intent.conditions, false);
});

test('summary 由生产者派生：口径来自入参、读数来自主推那套', () => {
  const built = buildDeliverableDocuments({
    callId: 'c', toolName: 't', args, result, subject: 's', at });
  assert.equal(built.version.summary, '在云量 ≤ 20% 的口径下，这套盖到 65.16%，¥5,564,230。');
});

test('summary 缺哪个数就省哪个分句；一个都没有就是空串，不编套话', () => {
  const built = buildDeliverableDocuments({
    callId: 'c', toolName: 't', args: {}, result: { mode: 'custom', schemes: [{ key: 'CUSTOM' }] },
    subject: 's', at });
  assert.equal(built.version.summary, '');
});

test('工具名里剥出裸名：线格式是 mcp__<连接器>__<工具>', () => {
  const built = buildDeliverableDocuments({
    callId: 'c', toolName: 'mcp__geoclar__geoclar_recommend_schemes', args, result, subject: 's', at,
  });
  assert.equal(built.version.intent.tool, 'geoclar_recommend_schemes');
});

test('不认识形状 ⇒ 整份不写，而不是写半份', () => {
  const bad = [
    { ...result, mode: '别的' },            // mode 读不懂
    { ...result, schemes: 'x' },            // schemes 不是数组
    { ...result, schemes: [{ key: 1 }] },   // 方案缺 key
    undefined, null, 'x',
  ];
  for (const value of bad) {
    const built = buildDeliverableDocuments({
      callId: 'c', toolName: 't', args, result: value, subject: 's', at });
    assert.equal(built, undefined, `应拒绝：${JSON.stringify(value)}`);
  }
});

test('subject 为空时退回时间戳，不编一句话', () => {
  const built = buildDeliverableDocuments({
    callId: 'c', toolName: 't', args, result, subject: '', at });
  assert.equal(built.manifest.subject, '');
  assert.match(built.slug, /^20261013-045800$/);
});

test('slugOf：保留中日韩与字母数字，其余压成单个连字符，且限长', () => {
  assert.equal(slugOf('霍尔木兹海峡 near 3 mo!!', at), '20261013-045800-霍尔木兹海峡-near-3-mo');
  assert.equal(slugOf('', at), '20261013-045800');
  assert.ok(slugOf('啊'.repeat(200), at).length <= 64);
});

test('截断按码点，不切出落单的代理（否则 manifest.slug 与磁盘目录名会不一致）', () => {
  const slug = slugOf('𠀀'.repeat(80), at);     // U+20000：每个占两个 UTF-16 单元
  assert.equal(Array.from(slug).length, 64);   // 按码点截，正好到上限
  // 混排（BMP 汉字垫到第 48 个码元正好落在代理对中间）——按码元切会留下落单的代理项，
  // 落盘时被编码成 U+FFFD，而 manifest.slug 仍记着它。
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const mixed = slugOf('啊'.repeat(47) + '𠮷'.repeat(10), at);
  assert.equal(loneSurrogate.test(mixed), false);
  assert.equal(Array.from(mixed).length, 64);
});
