/**
 * 共享视图模型：`geoclar_recommend_schemes` 出参 → 卡片与面板共用的读数。
 *
 * 两条硬要求（spec §6）：
 *   1. **形状不认识就返回 `undefined`** —— 调用方据此回落官方通用卡片，绝不渲染半张卡。
 *   2. `pricingComplete === false` 的金额是**下界**，视图模型要标出来（UI 上表现为前缀「≥」）。
 *
 * 夹具里的 `real` 是一次真实调用的出参摘录（去掉未用字段后的原文），
 * 不是编的数字 —— 这样测出来的才是"它认得出真形状"。
 *
 * 运行：node --test packages/plugins/scene-card/tests/scheme-view.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeliverableView } from '../dist/client/scheme-view.js';

const real = { mode: 'custom', pool: { candidateCount: 861, usableCount: 561, skippedByCloud: 0,
  skippedByFilter: 299, skippedNoGeometry: 1, skippedNoIntersection: 0, effectiveCloudCoverMax: 100,
  regionAreaKm2: 55226.95, coveredAreaKm2: 36625.09, coveragePercent: 66.32 },
  candidatePoolLimit: 100, poolAtLimit: true,
  schemes: [{ key: 'CUSTOM', sceneCount: 235, coveredAreaKm2: 35984.07, coveragePercent: 65.16,
    uncoveredAreaKm2: 19239.18, estimatedAmount: 5564229.98, pricingComplete: true, budgetCapped: false,
    budgetFullCoverageAmount: null, dateFrom: '2024-12-06', dateTo: '2026-10-09',
    gsdMin: 0.25, gsdMax: 0.5, cloudCoverMax: 33.0, cloudCoverMean: 1.33,
    scenes: [{ id: 'SVN1-02-20261008-00755433', acquiredAt: '2026-10-08 06:29:48', cloud: '13', resolution: 0.3 }] }],
  returnedCount: 1, truncated: false, relaxation: { kind: 'CLOUD_COVER_MAX', value: 26, coveragePercent: 100 } };

/** The `{ phase, result }` pair a toolview hands the view model. */
const phaseResult = (result) => ({ phase: 'result', result });

test('认得出形状时给出三块读数与主推', () => {
  const v = buildDeliverableView(phaseResult(real));
  assert.ok(v, 'should parse the real payload');
  assert.equal(v.primary.key, 'CUSTOM');
  assert.equal(v.schemes.length, 1);
  assert.equal(v.next.kind, 'relax');
  assert.equal(v.next.value, 26);
});

test('形状不认识时返回 undefined —— 调用方据此回落通用卡片', () => {
  assert.equal(buildDeliverableView(phaseResult({ nope: 1 })), undefined);
  assert.equal(buildDeliverableView({ phase: 'start' }), undefined);
  assert.equal(buildDeliverableView(undefined), undefined);
});

test('pricingComplete=false 的金额是下界，视图模型要标出来', () => {
  const v = buildDeliverableView(phaseResult({ ...real,
    schemes: [{ ...real.schemes[0], pricingComplete: false }] }));
  assert.equal(v.primary.amount.lowerBound, true);
});

test('出参里没有任何下一步读数时不给下一步，不编一条', () => {
  // 三个分支的读数都要清掉才叫"没有"：单清 relaxation 时 poolAtLimit 仍成立，
  // 那时该给的是"收窄范围重算"（见下面那条按顺序取分支的用例），不是 undefined。
  const v = buildDeliverableView(phaseResult({ ...real, relaxation: null, poolAtLimit: false }));
  assert.equal(v.next, undefined);
});

test('金额与主推读数取自出参，不是算出来的', () => {
  const v = buildDeliverableView(phaseResult(real));
  assert.equal(v.primary.amount.value, 5564229.98);
  assert.equal(v.primary.amount.lowerBound, false);
  assert.equal(v.primary.sceneCount, 235);
  assert.equal(v.primary.coveragePercent, 65.16);
  assert.equal(v.primary.uncoveredAreaKm2, 19239.18);
  assert.equal(v.primary.dateFrom, '2024-12-06');
  assert.equal(v.primary.dateTo, '2026-10-09');
  assert.equal(v.primary.gsdMin, 0.25);
  assert.equal(v.primary.gsdMax, 0.5);
  assert.equal(v.primary.cloudCoverMax, 33.0);
  assert.equal(v.primary.cloudCoverMean, 1.33);
});

test('景摘要四个键与检索工具同形，其余键不进视图模型', () => {
  const v = buildDeliverableView(phaseResult(real));
  assert.deepEqual(v.primary.scenes, [
    { id: 'SVN1-02-20261008-00755433', acquiredAt: '2026-10-08 06:29:48', cloud: '13', resolution: 0.3 },
  ]);
});

test('老后端没有 scenes 键 ⇒ 空清单，不报错（新卡装在旧后端前只是少一列景）', () => {
  const { scenes: _dropped, ...withoutScenes } = real.schemes[0];
  const v = buildDeliverableView(phaseResult({ ...real, schemes: [withoutScenes] }));
  assert.ok(v, '缺少 scenes 不应让整张卡回落');
  assert.deepEqual(v.primary.scenes, []);
});

test('每套方案最多留 20 条景摘要', () => {
  const many = Array.from({ length: 25 }, (_unused, index) => ({
    id: `S-${index}`, acquiredAt: '2026-10-08 06:29:48', cloud: '13', resolution: 0.3,
  }));
  const v = buildDeliverableView(phaseResult({ ...real,
    schemes: [{ ...real.schemes[0], sceneCount: 235, scenes: many }] }));
  assert.equal(v.primary.scenes.length, 20);
  assert.equal(v.primary.sceneCount, 235, 'sceneCount 仍是景总数，不跟着截断');
});

test('没有 CUSTOM 时主推第一套', () => {
  const v = buildDeliverableView(phaseResult({ ...real,
    schemes: [{ ...real.schemes[0], key: 'CHEAPEST' }, { ...real.schemes[0], key: 'LATEST' }] }));
  assert.equal(v.primary.key, 'CHEAPEST');
  assert.equal(v.schemes.length, 2);
});

test('预设菜单里主推 VALUE（性价比），不是排在第一个的那套', () => {
  // 出参顺序 = presetKeys() 的顺序，LATEST 打头、VALUE 排在第 11 —— 挑错就画错那一列。
  const presets = ['LATEST', 'SHARPEST', 'CLEAREST', 'CHEAPEST', 'VALUE', 'CONSISTENT']
    .map((key) => ({ ...real.schemes[0], key }));
  const v = buildDeliverableView(phaseResult({ ...real, mode: 'presets', schemes: presets }));
  assert.equal(v.primary.key, 'VALUE');
  assert.equal(v.schemes.length, 6, '整套菜单仍在视图模型里（卡只画主推那一套）');
});

test('mode 只有 custom / presets 两个值；缺失或读不懂 ⇒ 整份回落', () => {
  assert.equal(buildDeliverableView(phaseResult(real)).presets, false, 'custom ⇒ 并排画');
  assert.equal(buildDeliverableView(phaseResult({ ...real, mode: 'custom' })).presets, false);
  assert.equal(buildDeliverableView(phaseResult({ ...real, mode: 'presets' })).presets, true, 'presets ⇒ 只画主推');
  // 读不懂"哪条路"就无从决定画几列 —— 那是形状不认识，交给通用卡片，不是按 12 列铺开。
  const { mode: _dropped, ...withoutMode } = real;
  assert.equal(buildDeliverableView(phaseResult(withoutMode)), undefined, 'mode 缺失');
  assert.equal(buildDeliverableView(phaseResult({ ...real, mode: 'preset' })), undefined, 'mode 拼错');
});

test('池诊断读出候选/可用/剔除，并带上"已达上限"', () => {
  const v = buildDeliverableView(phaseResult(real));
  assert.deepEqual(v.pool, { candidateCount: 861, usableCount: 561, skippedByFilter: 299,
    skippedNoGeometry: 1, atLimit: true });
});

test('一套方案都没有（条件筛完池为空）：形状认得，但没有主推可画', () => {
  // 出参合法（§4.2：条件筛完池为空），所以**不是**"形状不认识"；
  // 但 `primary` 没有 —— 调用方（卡、自动弹）据此回落/不弹，所以这条要钉住。
  const v = buildDeliverableView(phaseResult({ ...real, schemes: [] }));
  assert.ok(v, 'schemes: [] 是合法形状，不是读不懂');
  assert.deepEqual(v.schemes, []);
  assert.equal(v.primary, undefined);
});

test('池缺失时不给池诊断，卡照样能画（池空的那一套）', () => {
  const v = buildDeliverableView(phaseResult({ ...real, pool: null }));
  assert.equal(v.pool, undefined);
  assert.ok(v.primary, '池读不到不该连方案都没有');
});

test('下一步按 relaxation → 池上限 → 预算的顺序取第一个成立的', () => {
  const capped = { ...real.schemes[0], budgetCapped: true, budgetFullCoverageAmount: 3111111.5 };
  const onlyBudget = buildDeliverableView(phaseResult({ ...real, relaxation: null, poolAtLimit: false,
    schemes: [capped] }));
  assert.deepEqual(onlyBudget.next, { kind: 'budget', fullCoverageAmount: 3111111.5 });
  // 池已达上限、但没给放宽建议 ⇒ 收窄范围（不是"按预算"）。
  const poolFirst = buildDeliverableView(phaseResult({ ...real, relaxation: null, schemes: [capped] }));
  assert.deepEqual(poolFirst.next, { kind: 'narrow' });
  // 三个都不成立 ⇒ 没有下一步，不编一条。
  const none = buildDeliverableView(phaseResult({ ...real, relaxation: null, poolAtLimit: false,
    schemes: [real.schemes[0]] }));
  assert.equal(none.next, undefined);
});

test('某一套方案的形状不完整 ⇒ 整份回落，不画半张卡', () => {
  assert.equal(buildDeliverableView(phaseResult({ ...real,
    schemes: [{ ...real.schemes[0], estimatedAmount: undefined }] })), undefined);
  assert.equal(buildDeliverableView(phaseResult({ ...real, schemes: [null] })), undefined);
});
