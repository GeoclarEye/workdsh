/**
 * 真渲染：把对话内那张卡挂进一个真浏览器，看它到底画出了什么。
 *
 * 纯函数测试证明得出"视图模型读对了"，证不出"卡画对了" —— 版式（四列并排、金额最响、
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
      // 组件自己的返回值要记下来：回落是"return null"，只断言"页面上没有"会放过"渲染了一棵空树"。
      // 直接当普通函数调已经不行了 —— 组件里有 useEffect（出结果时问一次自动弹），
      // 所以在一个真组件体里调它，hook 才落在合法的渲染帧上。
      function Probe({ props }) {
        const returned = SchemeCompareCard(props);
        window.__returned = returned === null ? 'null' : typeof returned;
        return returned;
      }
      // stdin 这一段的 loader 是 js（不开 JSX），所以这里用 createElement。
      window.renderCard = (props) => {
        (window.__root ??= createRoot(document.getElementById('root')))
          .render(React.createElement(Probe, { props }));
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

/** 一份真实出参 + 三套同池对照 —— 夹具与右侧面板的渲染测试**共用同一份**（见 fixtures/）。 */
import { cheapest, custom, latest, payload, presets, sharpest } from './fixtures/geoclar-recommend.mjs';

/** 琥珀的定义色；页面里把主题令牌钉成这个值，就可以拿**算出来的颜色**做断言。 */
const WARN = 'rgb(239, 180, 79)';
const ROOT_TOKENS = `--dsw-alias-bg-base:#121212;--dsw-alias-bg-layer-1:#1a1a1a;--dsw-alias-bg-layer-2:#202020;
--dsw-alias-border-l2:#303030;--dsw-alias-label-primary:#e7e7e7;--dsw-alias-label-secondary:#8a8a8a;
--dsw-alias-label-tertiary:#6a6a6a;--dsw-alias-interactive-bg-hover:#2a2a2a;
--dsw-alias-state-business-primary:#11b7c8;--dsw-alias-state-warn-primary:#efb44f`;

/** 出参在线格式里是结果块里那段文本，所以这里也照线格式喂进去（顺带钉住这条读法）。 */
const blockOf = (result) => ({ kind: 'tool-result', seq: 1, time: 1, callId: 'call-1', call: null,
  callTime: null, content: [{ type: 'text', text: JSON.stringify(result) }], isError: false, subCalls: [] });

/**
 * 渲染一张卡并断言。`result` 默认是三套并排的真实出参；`phase` 用来演"还没出结果"。
 */
async function withCard(run, { callId = 'call-1', result = payload, phase = 'result', width } = {}) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(width === undefined ? {} : { viewport: { width, height: 900 } });
    page.setDefaultTimeout(8000);
    page.on('pageerror', (error) => console.error(error.message));
    await page.route('http://127.0.0.1:19113/', (route) => route.fulfill({ contentType: 'text/html',
      body: `<style>:root{${ROOT_TOKENS}}</style><div id="root"></div>` }));
    await page.goto('http://127.0.0.1:19113/');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(({ block, id, stage }) => {
      window.__autos = [];
      window.renderCard({ phase: stage, block, callId: id, toolName: 'mcp__geoclar__geoclar_recommend_schemes',
        openDeliverable: (opened) => { window.__opened = opened; },
        autoOpenDeliverable: (called, hasDeliverable) => { window.__autos.push([called, hasDeliverable]); return false; } });
    }, { block: blockOf(result), id: callId, stage: phase });
    await run(page);
  } finally {
    await browser.close();
  }
}

test('四列并排：CUSTOM + 三套同池对照，全在且顺序与出参一致', async () => {
  assert.deepEqual(payload.schemes.map((scheme) => scheme.key),
    ['CUSTOM', 'LATEST', 'SHARPEST', 'CHEAPEST'], '夹具自检：出参顺序就是这一串');
  await withCard(async (page) => {
    const headers = await page.getByRole('columnheader').allInnerTexts();
    assert.deepEqual(headers.slice(1).map((text) => text.replace(/\s+/g, ' ').trim()),
      ['你的条件', '时相最新 对照', '最清晰 对照', '最省 对照']);
    const metrics = await page.locator('td.wd-sc-metric').allInnerTexts();
    assert.deepEqual(metrics, ['覆盖率', '景数', '时相', '分辨率', '云量', '未覆盖', '金额']);
    // 四列的读数各来自各自那一套：抽"景数"一行，四列数字必须是四套的 sceneCount。
    const scenes = await page.locator('tbody tr')
      .filter({ has: page.locator('td.wd-sc-metric', { hasText: /^景数$/ }) })
      .locator('td.wd-sc-val').allInnerTexts();
    assert.deepEqual(scenes.map((text) => text.trim()), ['235景', '312景', '118景', '640景']);
  });
});

test('列序跟着出参走，不按 key 重排', async () => {
  const shuffled = [sharpest, custom, latest, cheapest];
  await withCard(async (page) => {
    const headers = await page.getByRole('columnheader').allInnerTexts();
    assert.deepEqual(headers.slice(1).map((text) => text.replace(/\s+/g, ' ').trim()),
      ['最清晰 对照', '你的条件', '时相最新 对照', '最省 对照'],
      '主推按 key 认（还在"你的条件"那一列），但列的位置照出参顺序');
  }, { result: { ...payload, schemes: shuffled } });
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

test('琥珀只给"不能直接当结论用"的两个数：金额下界与预算截断', async () => {
  await withCard(async (page) => {
    const color = (locator) => locator.evaluate((node) => getComputedStyle(node).color);
    const rowOf = (label) => page.locator('tbody tr')
      .filter({ has: page.locator('td.wd-sc-metric', { hasText: new RegExp(`^${label}$`) }) });
    // 覆盖率一律不上琥珀（盖不满是常态）：四列全查一遍，防的是"顺手把 tone 加回来"。
    const coverage = rowOf('覆盖率').locator('td.wd-sc-val');
    for (const index of [0, 1, 2, 3]) assert.notEqual(await color(coverage.nth(index)), WARN, '覆盖率不该带琥珀');
    // 列序与出参一致：0 = CUSTOM、1 = LATEST、2 = SHARPEST、3 = CHEAPEST。
    const amounts = rowOf('金额').locator('td.wd-sc-val');
    assert.notEqual(await color(amounts.nth(0)), WARN, 'CUSTOM：既没截断也不是下界 ⇒ 不上琥珀');
    assert.equal(await color(amounts.nth(1)), WARN, 'LATEST：预算截断了 ⇒ 金额整格琥珀');
    assert.equal(await color(amounts.nth(2).locator('.wd-sc-loose')), WARN, 'SHARPEST：下界的「≥」带琥珀');
    assert.notEqual(await color(amounts.nth(3)), WARN, 'CHEAPEST：不上琥珀');
  });
});

test('12 套预设：只画主推那一套（VALUE／性价比）＋一行提示，不铺开菜单', async () => {
  await withCard(async (page) => {
    const headers = await page.getByRole('columnheader').allInnerTexts();
    assert.deepEqual(headers.slice(1).map((text) => text.replace(/\s+/g, ' ').trim()), ['性价比'],
      'presetKeys() 里 VALUE 排第 11，画的必须是它而不是打头的 LATEST');
    assert.equal(await page.getByText(/还有 11 套预设没列出/).count(), 1);
    assert.equal(await page.getByText('时相最新', { exact: true }).count(), 0, '另外 11 套不铺开');
    assert.equal(await page.getByText('最省', { exact: true }).count(), 0);
  }, { result: presets });
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
    assert.equal(await page.evaluate(() => window.__returned), 'null', '组件本身 return null');
    assert.equal((await page.locator('#root').innerText()).trim(), '');
    assert.equal(await page.locator('.wd-sc').count(), 0);
  }, { result: { nope: 1 } });
});

test('还没出结果（start 阶段）也不画', async () => {
  await withCard(async (page) => {
    assert.equal(await page.evaluate(() => window.__returned), 'null', '组件本身 return null');
    assert.equal((await page.locator('#root').innerText()).trim(), '');
  }, { phase: 'start' });
});

/** 表格容器与卡的横向几何：滚动落在容器里，卡自己没有溢出。 */
const tableBox = (page) => page.evaluate(() => {
  const card = document.querySelector('.wd-sc');
  const wrap = document.querySelector('.wd-sc-table-wrap');
  return { cardClient: card.clientWidth, cardScroll: card.scrollWidth,
    wrapClient: wrap.clientWidth, wrapScroll: wrap.scrollWidth,
    columns: document.querySelectorAll('th.wd-sc-col').length };
});

test('容器放不下四列时在容器里横向滚：不裁数据、也不溢出卡片', async () => {
  // 560px 下四列放不下（实测表格最小宽度 ~580px）：兜底是滚动，不是溢出。
  await withCard(async (page) => {
    const box = await tableBox(page);
    assert.equal(box.columns, 4, '滚动不是"少画一列"——四列一个不少');
    assert.ok(box.wrapScroll > box.wrapClient, `放不下就该能滚（scroll ${box.wrapScroll} / client ${box.wrapClient}）`);
    assert.ok(box.wrapClient <= box.cardClient, '滚动容器自己不溢出卡片');
    assert.equal(box.cardScroll, box.cardClient, '卡里没有横向溢出（溢出等于数据被裁且无提示）');
  }, { width: 560 });
});

test('放得下时不滚：宽视口下容器不出现滚动条', async () => {
  await withCard(async (page) => {
    const box = await tableBox(page);
    assert.equal(box.columns, 4);
    assert.ok(box.wrapScroll - box.wrapClient <= 1, `放得下就不该有横向滚动（scroll ${box.wrapScroll} / client ${box.wrapClient}）`);
    assert.equal(box.cardScroll, box.cardClient);
  }, { width: 900 });
});

test('卡底「查看详情」把**这张卡的** callId 交出去', async () => {
  // 这个值故意与其它用例的默认 callId 不同：写死成一个常量就过不了，
  // 只有真的把 props.callId 传下去才成立 —— 这是"历史可达性"的全部内容。
  await withCard(async (page) => {
    await page.getByRole('button', { name: '查看详情' }).click();
    assert.equal(await page.evaluate(() => window.__opened), 'call-7a3f');
  }, { callId: 'call-7a3f' });
});

test('一套方案都没有（条件筛完池为空）：不画这张卡，回落通用卡片', async () => {
  // §4.2 的合法形状。卡的存在意义是"并排比方案"，没有方案就没有比较；
  // 这时通用卡里的原始出参（含池的剔除计数）配上助手的文字比一张纯诊断卡更有用。
  await withCard(async (page) => {
    assert.equal(await page.evaluate(() => window.__returned), 'null', '组件本身 return null，不是渲染一棵空树');
    assert.equal((await page.locator('#root').innerText()).trim(), '');
    assert.equal(await page.locator('.wd-sc').count(), 0);
  }, { result: { ...payload, schemes: [] } });
});

test('出结果时**问一次**自动弹，且"有没有交付物"含"有方案"（空池为 false）', async () => {
  // 这一条把"卡 → 自动弹"这半段接上：卡的判据不止"视图模型认得出形状"。
  // 空池时视图模型**有返回**（`schemes: []`），但一层方案都没有 ⇒ 必须是 false ——
  // 照"有没有返回"写，用户会遇到"面板为一个没有东西可展示的结果自动弹开"。
  await withCard(async (page) => {
    await page.waitForFunction(() => window.__autos.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__autos), [['call-7a3f', true]]);
  }, { callId: 'call-7a3f' });

  await withCard(async (page) => {
    await page.waitForFunction(() => window.__autos.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__autos), [['call-1', false]],
      '空池：认得出形状，但没有可展示的方案');
  }, { result: { ...payload, schemes: [] } });

  await withCard(async (page) => {
    await page.waitForFunction(() => window.__autos.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__autos), [['call-1', false]],
      '形状不认识：同上');
  }, { result: { nope: 1 } });

  await withCard(async (page) => {
    await page.waitForTimeout(300);
    assert.deepEqual(await page.evaluate(() => window.__autos), [], '还没出结果就不问');
  }, { phase: 'start' });
});
