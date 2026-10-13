/**
 * 真渲染：把右侧「交付物」面板挂进一个真浏览器，看它到底画出了什么。
 *
 * 纯函数测试证明得出"由 callId 找得到那一轮"，证不出**面板**的四件事：
 *   · 六块都在，且「下一步 / 导出」**在滚动容器之外**（正文再长也吃不掉行动入口）；
 *   · 「步骤」取的是**那一轮**、耗时两态（有 / 无 `callTime`）；
 *   · 「下一步」由出参驱动的三个分支各一态，三者皆无时整块不出现；
 *   · 「导出」只跳门户、不做下载。
 *
 * 跑法：node --test packages/plugins/scene-card/tests/deliverable-panel-render.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { custom, payload, presets } from './fixtures/geoclar-recommend.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const req = createRequire(resolve(packageRoot, 'package.json'));
const tools = createRequire(new URL('../../../../apps/web/package.json', import.meta.url));
const { build } = tools('esbuild');
const { chromium } = tools('@playwright/test');

const bundle = await build({
  stdin: {
    resolveDir: packageRoot,
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { DeliverablePanel } from './src/client/DeliverablePanel.tsx';
      window.renderPanel = (props) => {
        (window.__root ??= createRoot(document.getElementById('root')))
          .render(React.createElement(DeliverablePanel, props));
      };`,
  },
  bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{
    name: 'react',
    setup(build_) {
      build_.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, (args) => ({ path: req.resolve(args.path) }));
    },
  }],
});

/** 已完成的工具调用结果节点（官方 `ToolResultNode` 的字段）。 */
const resultBlock = ({ callId, name, time, callTime, text = '{}' }) => ({
  kind: 'tool-result', seq: 1, time, callId, call: { name, argsRaw: '{}' }, callTime,
  content: [{ type: 'text', text }], isError: false, subCalls: [],
});

/** 还在跑的工具调用（官方 `StartedToolCall` 的字段）。 */
const runningBlock = ({ callId, name, time }) => ({
  phase: 'start', callId, name, turn: 1, step: 1, time, argsRaw: '{}', subCalls: [],
});

/** 一个 chat 节点；轮次写在 `location.turn.turn` 上。 */
const node = (root, turn) => ({ key: `k:${root.callId}`, kind: 'tool-call', id: root.callId,
  target: 'chat', anchorSeq: root.seq ?? 0, data: { root },
  location: { kind: 'step', turn: { turn }, step: { turn, step: 1 } }, visibility: 'visible' });

/** 会话快照的最小形状：`values()` 找轮次、`turnDataSource(turn,'tool-call')` 取成员。 */
const chatOf = (nodes) => ({
  order: nodes.map((n) => n.key),
  nodes: {
    values: () => nodes,
    turnDataSource: (turn) => ({
      getSnapshot: () => nodes.filter((n) => n.location.turn.turn === turn).map((n) => n.data),
    }),
  },
});

/**
 * 第 1 轮是一串检索调用（先看范围、再检索、最后算方案），第 2 轮是另一次调用。
 * 耗时：`geoclar_inspect_aoi` 那一行**没有** `callTime`（窗口截断），所以它不该出耗时。
 */
const ROUND = [
  node(resultBlock({ callId: 'call-aoi', name: 'mcp__geoclar__geoclar_inspect_aoi',
    time: 5_000, callTime: null }), 1),
  node(resultBlock({ callId: 'call-search', name: 'mcp__geoclar__geoclar_search_scenes',
    time: 12_000, callTime: 9_000 }), 1),
  node(resultBlock({ callId: 'call-recommend', name: 'mcp__geoclar__geoclar_recommend_schemes',
    time: 40_000, callTime: 31_500, text: JSON.stringify(payload) }), 1),
  node(resultBlock({ callId: 'call-other-turn', name: 'bash', time: 90_000, callTime: 89_000 }), 2),
];

const ROOT_TOKENS = `--dsw-alias-bg-base:#121212;--dsw-alias-bg-layer-1:#1a1a1a;--dsw-alias-bg-layer-2:#202020;
--dsw-alias-border-l2:#303030;--dsw-alias-label-primary:#e7e7e7;--dsw-alias-label-secondary:#8a8a8a;
--dsw-alias-label-tertiary:#6a6a6a;--dsw-alias-interactive-bg-hover:#2a2a2a;
--dsw-alias-state-business-primary:#11b7c8;--dsw-alias-state-warn-primary:#efb44f`;

/** 渲染面板并断言。`nodes` 默认是那一轮真实的一串调用。 */
async function withPanel(run, { callId = 'call-recommend', nodes = ROUND, portalOrigin, withoutUseChat } = {}) {
  const browser = await chromium.launch({ headless: true });
  try {
    // 376×480 是"右栏确实装不下"的那个高度：正文会滚，页脚才断言得动它不动。
    const page = await browser.newPage({ viewport: { width: 376, height: 480 } });
    page.setDefaultTimeout(8000);
    page.on('pageerror', (error) => console.error(error.message));
    await page.route('http://127.0.0.1:19114/', (route) => route.fulfill({ contentType: 'text/html',
      body: `<style>:root{${ROOT_TOKENS}}html,body,#root{height:100%;margin:0}</style><div id="root"></div>` }));
    await page.goto('http://127.0.0.1:19114/');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    // 函数过不了 Playwright 的序列化，所以会话快照在页面**里面**拼。
    await page.evaluate(({ raw, bound, origin, withoutChat }) => {
      const chat = {
        order: raw.map((entry) => entry.key),
        nodes: {
          values: () => raw,
          turnDataSource: (turn) => ({
            getSnapshot: () => raw.filter((entry) => entry.location.turn.turn === turn).map((entry) => entry.data),
          }),
        },
      };
      window.__draft = null; window.__opened = [];
      window.renderPanel({
        useTabInfo: () => ({ tab: { kind: 'workdsh-scene-deliverable',
          navigation: { params: { callId: bound }, revision: 1 } } }),
        // `useChat` 在真宿主里是框架绑的 selector hook；这里给一个同样形状的假件，
        // 好让"面板读对话数据"这件事在**渲染层**也能被断言（读法本身另有纯函数测试）。
        ...(withoutChat ? {} : { useChat: (selector) => selector(chat) }),
        inputActions: { setDraft: (text) => { window.__draft = text; } },
        // 门户地址是**异步**来的（宿主配置 → 同源路由）；这里喂一个同样形状的假 loader，
        // 好让"配了就能用 / 没配就关着"两态都能断言。
        loadPortalOrigin: async () => origin,
      });
    }, { raw: nodes, bound: callId, origin: portalOrigin, withoutChat: withoutUseChat === true });
    await run(page);
  } finally {
    await browser.close();
  }
}

test('六块都在：标题行 / 步骤 / 方案（分段器 + 网格）/ 用到的工具 / 页脚', async () => {
  await withPanel(async (page) => {
    assert.equal(await page.locator('.wd-dp-head h3').innerText(), '交付物');
    assert.match(await page.locator('.wd-dp-status').innerText(), /已完成$/);
    assert.equal(await page.locator('.wd-dp-label').nth(0).innerText(), '步骤 · 3');
    assert.equal(await page.locator('.wd-dp-label').nth(1).innerText(), '方案');
    assert.equal(await page.locator('.wd-dp-label').nth(2).innerText(), '用到的工具');
    assert.equal(await page.locator('.wd-dp-seg button').count(), 4, '四套方案各一个分段器按钮');
    assert.equal(await page.locator('.wd-dp-artifact .wd-sc-row').count(), 7, '复用卡的那份网格（七行读数）');
    assert.equal(await page.locator('.wd-dp-tools .wd-dp-tool').count(), 3);
    assert.equal(await page.locator('.wd-dp-foot').count(), 1);
  });
});

test('步骤取的是**那一轮**：另一次调用的工具不出现在这里', async () => {
  await withPanel(async (page) => {
    const steps = await page.locator('.wd-dp-step .wd-dp-name').allInnerTexts();
    assert.deepEqual(steps, ['geoclar_inspect_aoi', 'geoclar_search_scenes', 'geoclar_recommend_schemes'],
      '轮次 2 的 bash 不该混进轮次 1 的步骤里');
  });
});

test('耗时两态：配得上 call 时刻的出数字，`callTime` 为 null 的那行**整格不出**（也不写「—」）', async () => {
  await withPanel(async (page) => {
    const rows = page.locator('.wd-dp-step');
    assert.equal(await rows.nth(0).locator('.wd-dp-time').count(), 0, '窗口截断 ⇒ 没有耗时');
    assert.equal((await rows.nth(0).innerText()).includes('—'), false, '不写占位符');
    assert.equal((await rows.nth(0).innerText()).includes('0'), false, '也不该是 0 秒');
    assert.equal(await rows.nth(1).locator('.wd-dp-time').innerText(), '3.0s');
    assert.equal(await rows.nth(2).locator('.wd-dp-time').innerText(), '8.5s');
  });
});

test('还在跑的调用：转圈、没有耗时；已完成的是 ✓', async () => {
  // 面板绑的是**已出结果**的那一件，同一轮里前一步还在跑 —— 两种行同框。
  const nodes = [
    node(runningBlock({ callId: 'call-aoi', name: 'mcp__geoclar__geoclar_inspect_aoi', time: 9_000 }), 1),
    node(resultBlock({ callId: 'call-recommend', name: 'mcp__geoclar__geoclar_recommend_schemes',
      time: 40_000, callTime: 31_500, text: JSON.stringify(payload) }), 1),
  ];
  await withPanel(async (page) => {
    assert.equal(await page.locator('.wd-dp-spin').count(), 1);
    assert.equal(await page.locator('.wd-dp-step.is-running .wd-dp-time').count(), 0);
    assert.equal(await page.locator('.wd-dp-mark').count(), 1);
    assert.equal(await page.locator('.wd-dp-step.is-running').innerText(), 'geoclar_inspect_aoi');
  }, { nodes });
});

test('用到的工具：剥掉 MCP 前缀、按首次出现去重', async () => {
  const nodes = [
    node(resultBlock({ callId: 'call-a', name: 'mcp__geoclar__geoclar_search_scenes', time: 5_000, callTime: 4_000 }), 1),
    node(resultBlock({ callId: 'call-recommend', name: 'mcp__geoclar__geoclar_search_scenes', time: 6_000,
      callTime: 5_000, text: JSON.stringify(payload) }), 1),
  ];
  await withPanel(async (page) => {
    assert.deepEqual(await page.locator('.wd-dp-tools .wd-dp-tool').allInnerTexts(), ['geoclar_search_scenes']);
  }, { nodes });
});

test('页脚**在滚动容器之外**：正文滚到底，两个按钮的位置一动不动', async () => {
  await withPanel(async (page) => {
    const geometry = await page.evaluate(() => {
      const body = document.querySelector('.wd-dp-body');
      const foot = document.querySelector('.wd-dp-foot');
      const before = foot.getBoundingClientRect().top;
      body.scrollTop = body.scrollHeight;
      const after = foot.getBoundingClientRect().top;
      return { before, after, scrollTop: body.scrollTop, inBody: body.contains(foot) };
    });
    assert.ok(geometry.scrollTop > 0, '正文确实滚动了（否则这条断言什么都没测）');
    assert.equal(geometry.inBody, false, '页脚不是滚动容器的子孙');
    assert.equal(geometry.after, geometry.before, '滚到底之后页脚仍在原处');
  });
});

test('分段器四选一：切到第二套，读数与标题都跟着换', async () => {
  await withPanel(async (page) => {
    assert.equal(await page.locator('.wd-dp-ahead .wd-dp-t').innerText(), '你的条件');
    assert.equal(await page.locator('.wd-dp-ahead .wd-dp-s').count(), 0, '主推那套不编一句条件说明');
    assert.equal(await page.locator('.wd-dp-seg button[aria-selected="true"]').innerText(), '你的条件');
    await page.locator('.wd-dp-seg button', { hasText: '时相最新' }).click();
    assert.equal(await page.locator('.wd-dp-ahead .wd-dp-t').innerText(), '时相最新');
    assert.equal(await page.locator('.wd-dp-ahead .wd-dp-s').innerText(), '对照');
    assert.equal(await page.locator('.wd-dp-seg button[aria-selected="true"]').innerText(), '时相最新');
    // 金额那一行是那一套自己的数（LATEST 的 6120400，不是 CUSTOM 的 5564230）。
    const leading = await page.locator('.wd-dp-artifact .wd-sc-row.is-leading dd').innerText();
    assert.equal(leading, '¥6,120,400');
    assert.equal(await page.locator('.wd-dp-artifact .wd-sc-row.is-leading dd')
      .evaluate((node) => getComputedStyle(node).fontWeight), '600', '金额那一行在面板里放大加粗');
  });
});

test('「下一步」三个分支各一态，且都是出参驱动的；三者皆无时整块不出现', async () => {
  const relax = { ...payload };
  const narrow = { ...payload, relaxation: null, poolAtLimit: true };
  const budget = { ...payload, relaxation: null, poolAtLimit: false,
    schemes: [{ ...custom, budgetCapped: true, budgetFullCoverageAmount: 7111222.5 }] };
  const none = { ...payload, relaxation: null, poolAtLimit: false };

  await withPanel(async (page) => {
    assert.equal(await page.locator('.wd-dp-next').innerText(), '按此放宽到 26%');
    await page.locator('.wd-dp-next').click();
    assert.match(await page.evaluate(() => window.__draft), /把云量放宽到 26%/);
  }, { nodes: withResult(relax) });

  await withPanel(async (page) => {
    assert.equal(await page.locator('.wd-dp-next').innerText(), '收窄范围重算');
  }, { nodes: withResult(narrow) });

  await withPanel(async (page) => {
    assert.equal(await page.locator('.wd-dp-next').innerText(), '按预算只看盖到多少');
  }, { nodes: withResult(budget) });

  await withPanel(async (page) => {
    assert.equal(await page.locator('.wd-dp-foot').count(), 1, '页脚还在（导出仍然可达）');
    assert.equal(await page.locator('.wd-dp-next').count(), 0, '没有下一步的读数就不编一条');
  }, { nodes: withResult(none) });
});

/** 把那一轮最后一次调用的出参换成给的那份。 */
function withResult(result) {
  return ROUND.map((entry) => (entry.data.root.callId === 'call-recommend'
    ? node({ ...entry.data.root, content: [{ type: 'text', text: JSON.stringify(result) }] }, 1)
    : entry));
}

test('「导出」只跳门户、不做下载：没配门户地址时它是关的，配了就去那个地址', async () => {
  await withPanel(async (page) => {
    const button = page.getByRole('button', { name: '去门户导出' });
    assert.equal(await button.isDisabled(), true, '没配地址就不放一个点了没反应的按钮');
    assert.equal(await button.getAttribute('title'), '还没有配置门户地址');
    // 关着的按钮不会派发 click，所以这里不点它 —— 断言落在"它是关的"这件事实上。
    assert.deepEqual(await page.evaluate(() => window.__opened), []);
  });
  await withPanel(async (page) => {
    await page.evaluate(() => { window.open = (url) => { window.__opened.push(url); }; });
    const button = page.getByRole('button', { name: '去门户导出' });
    assert.equal(await button.isDisabled(), false);
    await button.click();
    assert.deepEqual(await page.evaluate(() => window.__opened), ['https://portal.example.test/scene-search']);
  }, { portalOrigin: 'https://portal.example.test/scene-search' });
});

test('面板绑的那一件不在当前对话窗口里：不画半张，给一句说明', async () => {
  await withPanel(async (page) => {
    assert.equal(await page.locator('.wd-dp-empty').count(), 1);
    assert.equal(await page.locator('.wd-dp-block').count(), 0);
    assert.equal(await page.locator('.wd-dp-foot').count(), 0, '没有交付物就没有行动入口');
  }, { callId: 'call-nope' });
});

test('预设态与卡一致：**不铺那 11 套**，只给主推 + 一行提示（裁定 4）', async () => {
  // 两个面互相矛盾正是裁定 4 禁止的：卡在预设态只画主推，面板也必须只画主推。
  await withPanel(async (page) => {
    assert.equal(await page.locator('.wd-dp-seg').count(), 0, '预设态没有"四选一"这回事');
    assert.equal(await page.locator('.wd-dp-artifact .wd-dp-t').innerText(), '性价比',
      'presetKeys() 里 VALUE 排第 11，给的是它而不是打头的 LATEST');
    assert.equal(await page.getByText(/还有 11 套预设没列出/).count(), 1, '与卡同一句提示');
    assert.equal(await page.getByText('时相最新', { exact: true }).count(), 0, '另外 11 套不铺开');
    assert.equal(await page.getByText('最省', { exact: true }).count(), 0);
  }, { nodes: withResult(presets) });
});

test('会话标准件拿不到时：少画那一块、不抛（按"读不出这一件"降级）', async () => {
  const errors = [];
  await withPanel(async (page) => {
    page.on('pageerror', (error) => errors.push(error.message));
    assert.equal(await page.locator('.wd-dp-empty').count(), 1);
    assert.equal(await page.locator('.wd-dp-block').count(), 0);
    assert.deepEqual(errors, [], '不该有页面错误');
  }, { withoutUseChat: true });
});
