/**
 * 真渲染：把对话内那张卡挂进一个真浏览器，看它到底画出了什么。
 *
 * 纯函数测试证明得出"视图模型读对了"，证不出"卡画对了" —— 版式（三列并排、金额最响、
 * 卡底「查看详情」）与**回落**（形状不认识时页面上不该有这张卡）都只有渲染才算数。
 *
 * 跑法：node --test packages/plugins/scene-card/tests/scheme-card-render.test.mjs
 * 依赖：`@playwright/test`（含 chromium）与 `esbuild`，都在 apps/web 的依赖里。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
/** 组件自己的依赖（react）从这个包解析。 */
const req = createRequire(resolve(packageRoot, 'package.json'));
/** esbuild 与 playwright 是 Web 工作区的工具链，插件包不自己依赖它们（照 projects 的测试）。 */
const tools = createRequire(new URL('../../../../apps/web/package.json', import.meta.url));
const { build } = tools('esbuild');
const { chromium } = tools('@playwright/test');

/** 一次性把组件打成 iife：页面里没有打包器，也没有 cordis，只有 props。 */
const bundle = await build({
  stdin: {
    resolveDir: packageRoot,
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { SchemeCompareCard } from './src/client/SchemeCompareCard.tsx';
      window.renderCard = (props) => {
        (window.__root ??= createRoot(document.getElementById('root'))).render(
          React.createElement(SchemeCompareCard, props));
      };`,
  },
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  write: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{
    name: 'react',
    setup(build_) {
      build_.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (args) => ({ path: req.resolve(args.path) }));
    },
  }],
});

/** 一份真实出参 + 评审稿里那两套同池对照（对照两列的值是评审稿的示意值）。 */
const custom = { key: 'CUSTOM', sceneCount: 235, coveredAreaKm2: 35984.07, coveragePercent: 65.16,
  uncoveredAreaKm2: 19239.18, estimatedAmount: 5564229.98, pricingComplete: true, budgetCapped: false,
  budgetFullCoverageAmount: null, dateFrom: '2024-12-06', dateTo: '2026-10-09',
  gsdMin: 0.25, gsdMax: 0.5, cloudCoverMax: 33.0, cloudCoverMean: 1.33,
  scenes: [{ id: 'SVN1-02-20261008-00755433', acquiredAt: '2026-10-08 06:29:48', cloud: '13', resolution: 0.3 }] };
const latest = { ...custom, key: 'LATEST', sceneCount: 312, coveragePercent: 58.4, uncoveredAreaKm2: 22982,
  estimatedAmount: 6120400, dateFrom: '2025-06-01', dateTo: '2026-10-01', gsdMin: 0.3, gsdMax: 0.8,
  cloudCoverMax: 22, cloudCoverMean: 2.4 };
const sharpest = { ...custom, key: 'SHARPEST', sceneCount: 118, coveragePercent: 41.0, uncoveredAreaKm2: 32589,
  estimatedAmount: 7980150, pricingComplete: false, dateFrom: '2025-01-01', dateTo: '2026-09-01',
  gsdMin: 0.25, gsdMax: 0.3, cloudCoverMax: 8, cloudCoverMean: 0.6 };
const payload = { mode: 'custom', pool: { candidateCount: 861, usableCount: 561, skippedByCloud: 0,
  skippedByFilter: 299, skippedNoGeometry: 1, skippedNoIntersection: 0, effectiveCloudCoverMax: 100,
  regionAreaKm2: 55226.95, coveredAreaKm2: 36625.09, coveragePercent: 66.32 },
  candidatePoolLimit: 100, poolAtLimit: true, schemes: [latest, custom, sharpest],
  returnedCount: 3, truncated: false, relaxation: { kind: 'CLOUD_COVER_MAX', value: 26, coveragePercent: 100 } };

/** 出参在线格式里是结果块里那段文本，所以这里也照线格式喂进去（顺带钉住这条读法）。 */
const blockOf = (result) => ({ kind: 'tool-result', seq: 1, time: 1, callId: 'call-1', call: null,
  callTime: null, content: [{ type: 'text', text: JSON.stringify(result) }], isError: false, subCalls: [] });

/**
 * 渲染一张卡并断言。`result` 默认是三套并排的真实出参；`phase` 用来演"还没出结果"。
 */
async function withCard(run, { callId = 'call-1', result = payload, phase = 'result' } = {}) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', (error) => console.error(error.message));
    await page.route('http://127.0.0.1:19113/', (route) => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
    await page.goto('http://127.0.0.1:19113/');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(({ block, id, stage }) => {
      window.renderCard({ phase: stage, block, callId: id, toolName: 'mcp__geoclar__geoclar_recommend_schemes',
        openDeliverable: (opened) => { window.__opened = opened; } });
    }, { block: blockOf(result), id: callId, stage: phase });
    await run(page);
  } finally {
    await browser.close();
  }
}

test('三套并排：左中右三列各按 key 命名，对照套标"对照"', async () => {
  await withCard(async (page) => {
    const headers = await page.getByRole('columnheader').allInnerTexts();
    assert.deepEqual(headers.slice(1).map((text) => text.replace(/\s+/g, ' ').trim()),
      ['时相最新 对照', '你的条件', '最清晰 对照']);
    const metrics = await page.locator('td.wd-sc-metric').allInnerTexts();
    assert.deepEqual(metrics, ['覆盖率', '景数', '时相', '分辨率', '云量', '未覆盖', '金额']);
  });
});

test('金额最响：主推那套的金额同时出现在标题行与金额行，下界带 ≥', async () => {
  await withCard(async (page) => {
    assert.equal(await page.locator('.wd-sc-amount-v').innerText(), '¥5,564,230');
    // 主推 = CUSTOM（pricingComplete），下界只出现在 SHARPEST（pricingComplete=false）那一列。
    assert.equal(await page.getByText('¥5,564,230', { exact: true }).count(), 2);
    assert.equal(await page.locator('.wd-sc-table td', { hasText: '≥¥7,980,150' }).count(), 1);
    assert.equal(await page.getByText('放宽到 26% 即可盖满', { exact: true }).count(), 1);
    assert.equal(await page.getByText('候选池已达上限，可能没取全', { exact: true }).count(), 1);
  });
});

test('单套 + 池空：只有一列时照样画得出来（不因为"没得比"而回落）', async () => {
  await withCard(async (page) => {
    assert.equal(await page.getByRole('columnheader').count(), 2, '一列指标 + 一套方案');
    assert.equal(await page.locator('.wd-sc').count(), 1);
    assert.equal(await page.getByText('候选池已达上限，可能没取全').count(), 0, '池读数没有时不编一句');
  }, { result: { ...payload, schemes: [custom], pool: null, poolAtLimit: false } });
});

test('形状不认识：页面上没有这张卡（回落通用卡片）', async () => {
  await withCard(async (page) => {
    assert.equal((await page.locator('#root').innerText()).trim(), '');
    assert.equal(await page.locator('.wd-sc').count(), 0);
  }, { result: { nope: 1 } });
});

test('还没出结果（start 阶段）也不画', async () => {
  await withCard(async (page) => {
    assert.equal((await page.locator('#root').innerText()).trim(), '');
  }, { phase: 'start' });
});

test('卡底「查看详情」把**这张卡的** callId 交出去', async () => {
  await withCard(async (page) => {
    await page.getByRole('button', { name: '查看详情' }).click();
    assert.equal(await page.evaluate(() => window.__opened), 'call-1');
  }, { callId: 'call-1' });
});
