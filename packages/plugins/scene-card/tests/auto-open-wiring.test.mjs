/**
 * 受控自动弹的**接线**：五维事实从 `ctx` 里是怎么算出来的。
 *
 * 为什么纯函数测试之外还要这一份：`shouldAutoOpen` 只证明"给定这五个布尔，结论对不对"，
 * 证明不出"`alreadyOpen` 是从 `tabsIn` 里读的、`openedThisTurn` 记的是**这一轮**"。
 * 判据仍然是同一条 —— **`openTabIn` 该不该被调用**，不是界面看起来对。
 *
 * 跑法：node --test packages/plugins/scene-card/tests/auto-open-wiring.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../dist/client.js';
import { forgetPanelBindings, panelOpenFacts, rememberPanelBinding }
  from '../dist/client/panel-binding.js';

const KIND = 'workdsh-scene-deliverable';
const SESSION = 'session-1';

/** 一个已出结果的工具调用节点；轮次写在 `location.turn.turn` 上。 */
const node = (callId, turn) => ({ key: `k:${callId}`, kind: 'tool-call', id: callId, target: 'chat',
  anchorSeq: 0, data: { root: { kind: 'tool-result', seq: 1, time: 2, callId, call: null, callTime: 1,
    content: [], isError: false, subCalls: [] } },
  location: { kind: 'step', turn: { turn }, step: { turn, step: 1 } }, visibility: 'visible' });

const chatOf = (nodes) => ({
  order: [],
  nodes: {
    values: () => nodes,
    turnDataSource: (turn) => ({ getSnapshot: () => nodes.filter((n) => n.location.turn.turn === turn).map((n) => n.data) }),
  },
});

/**
 * 本插件那个 tab 的 layout 记录 —— **照 `tabsIn()` 真正返回的形状**：
 * dockkit 的 `{id, kind, title, contentId}`，**没有 `navigation`**。
 * （夹具若顺手补一个 `navigation: {params}`，"绑定值从哪儿读"这个错就再也测不出来了。）
 */
const layoutTab = () => ({ id: KIND, kind: KIND, title: '交付物', contentId: `dsh-resource://${KIND}` });

test('两维从**真实的 layout 记录**推出来：布局记录里没有绑定值，绑定值是我们自己记的账', () => {
  // 这一条是冲着"从 `tab.navigation.params` 读绑定值"那个错来的：`tabsIn()` 的记录里
  // 根本没有 `navigation`，按它读会**恒为 undefined**，`alreadyOpen` 就永远不可能是 true。
  // 夹具刻意用真形状（只有 id/kind/title/contentId），所以那个错在这里必红。
  const tabs = [layoutTab()];
  assert.deepEqual(panelOpenFacts(tabs, KIND, SESSION, 'call-a'),
    { alreadyOpen: false, boundToOtherCall: true }, '开着但还没记过绑定 ⇒ 不夺焦点');
  rememberPanelBinding(SESSION, 'call-a');
  assert.deepEqual(panelOpenFacts(tabs, KIND, SESSION, 'call-a'),
    { alreadyOpen: true, boundToOtherCall: false }, '记过、且就是这一件 ⇒ 已开着');
  assert.deepEqual(panelOpenFacts(tabs, KIND, SESSION, 'call-b'),
    { alreadyOpen: false, boundToOtherCall: true }, '记的是别人 ⇒ 不夺焦点');
  forgetPanelBindings();
  assert.deepEqual(panelOpenFacts([], KIND, SESSION, 'call-a'),
    { alreadyOpen: false, boundToOtherCall: false }, '没开着 ⇒ 两维都不成立');
});

/**
 * 一个只实现本插件用到的那几个面的假 ctx。`window` 是全局，自动弹要自测视口
 * （官方没把窄屏判定暴露给插件），所以在用例里改它。
 */
function harness({ tabs = [], chat, width = 1440, config } = {}) {
  const opened = [];
  const registered = new Map();
  const open = [...tabs];
  const disposers = [];
  const ctx = {
    config,
    // `effect` 的回调立刻跑，返回的清理件收起来 —— 卸载时真的会跑（两张账都靠它清）。
    effect: (fn) => { const disposer = fn(); if (typeof disposer === 'function') disposers.push(disposer); return () => {}; },
    sidebarRightTabs: { register: () => () => {} },
    sidebarRight: {
      tabsIn: (sessionId) => (sessionId === SESSION ? open : []),
      // 真的 `openTabIn` 会把 tab 记进 layout（重复开是**重绑**，Task 1 §9-8），假的也照做：
      // 只放 layout 记录，**不放 navigation** —— 绑定值不在那儿。
      openTabIn: (sessionId, kind, options) => {
        opened.push({ sessionId, kind, params: options?.params });
        if (!open.some((tab) => tab.kind === kind)) open.push(layoutTab());
      },
    },
    uiConversation: { binding: () => ({ target: () => ({ getSnapshot: () => chat }) }) },
    slots: {
      inject: (key, callback) => { callback(); return () => {}; },
      register: (options, component) => { registered.set(options.name, { options, component }); return () => {}; },
    },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: { innerWidth: width }, configurable: true });
  apply(ctx);
  const toolview = () => registered.get('tool.call.toolview').options.inject(SESSION);
  return {
    opened,
    registered,
    /** 用户把面板关掉了：tab 记录消失，但"本轮弹过"那笔账还在。 */
    close: () => { open.length = 0; },
    /** 卡底「查看详情」：把面板重绑到某一次调用（**唯一**写下绑定值的地方）。 */
    viewDetail: (callId) => { toolview().openDeliverable(callId); },
    autoOpen: (callId, hasDeliverable) => toolview().autoOpenDeliverable(callId, hasDeliverable),
    restore: () => {
      // 插件卸载：清理件跑一遍 —— 模块级的账因此不跨用例（真机上不跨重载）。
      for (const disposer of disposers.reverse()) disposer();
      if (previous === undefined) delete globalThis.window;
      else Object.defineProperty(globalThis, 'window', previous);
    },
  };
}

/** 每个用例都在自己的 `window` 上跑，跑完还原，免得污染别的测试文件。 */
const withHarness = (options, run) => {
  const h = harness(options);
  try { return run(h); } finally { h.restore(); }
};

test('首次出现且未开：调用 openTabIn，带上本插件的 kind 与该次 callId', () => {
  withHarness({ chat: chatOf([node('call-a', 1)]) }, (h) => {
    assert.equal(h.autoOpen('call-a', true), true, '返回值就是"该弹"');
    assert.deepEqual(h.opened, [{ sessionId: SESSION, kind: KIND, params: { callId: 'call-a' } }]);
  });
});

test('本轮弹过一次 → 同一轮里第二次不再弹，**即使面板已被关掉**', () => {
  withHarness({ chat: chatOf([node('call-a', 1), node('call-b', 1)]) }, (h) => {
    assert.equal(h.autoOpen('call-a', true), true);
    h.close(); // 用户把面板关掉了：这一维就是 §9-6 拿不到「用户关掉」信号后的退路。
    assert.equal(h.autoOpen('call-b', true), false);
    assert.equal(h.opened.length, 1, 'openTabIn 只该被调用一次');
  });
});

test('换一轮：上一轮的账不拦着下一轮（面板当时是关着的）', () => {
  withHarness({ chat: chatOf([node('call-a', 1), node('call-b', 2)]) }, (h) => {
    assert.equal(h.autoOpen('call-a', true), true);
    h.close();
    assert.equal(h.autoOpen('call-b', true), true, '新的一轮是新的一次机会');
    assert.deepEqual(h.opened.map((entry) => entry.params.callId), ['call-a', 'call-b']);
  });
});

test('面板正开着（绑着上一轮那件）时，新一轮的交付物也**不**夺焦点', () => {
  // 这一条是"不夺焦点"的代价，写下来是为了别被当成 bug：用户在看的那一件不会被挤走，
  // 新一轮的交付物要自己走卡上的「查看详情」过去。
  withHarness({ chat: chatOf([node('call-a', 1), node('call-b', 2)]) }, (h) => {
    assert.equal(h.autoOpen('call-a', true), true);
    assert.equal(h.autoOpen('call-b', true), false);
    assert.equal(h.opened.length, 1);
  });
});

test('轮次的账按会话隔离：另一个会话不受影响', () => {
  withHarness({ chat: chatOf([node('call-a', 1)]) }, (h) => {
    assert.equal(h.autoOpen('call-a', true), true);
    const other = h.registered.get('tool.call.toolview').options.inject('session-2');
    assert.equal(other.autoOpenDeliverable('call-a', true), true, '别的会话还没弹过');
    assert.equal(h.opened.at(-1).sessionId, 'session-2', '弹的目标会话是注入给它的那一个');
  });
});

test('面板已开着（且就绑着这一件）→ 不弹，不把它再展开一次', () => {
  // 「已开着且就是这一件」由**卡的「查看详情」**造成：那是写下绑定值的唯一入口。
  withHarness({ chat: chatOf([node('call-a', 1)]) }, (h) => {
    h.viewDetail('call-a');
    assert.equal(h.autoOpen('call-a', true), false);
    assert.equal(h.opened.length, 1, 'openTabIn 只该被「查看详情」调用那一次');
  });
});

test('面板开着但绑的是别的 callId → 不夺焦点（用户可能正在看历史那一件）', () => {
  withHarness({ chat: chatOf([node('call-a', 1), node('call-old', 1)]) }, (h) => {
    h.viewDetail('call-old'); // 用户点了历史那一件的「查看详情」
    assert.equal(h.autoOpen('call-a', true), false, '绑的不是这一件就不动它');
    assert.equal(h.opened.length, 1);
  });
});

test('面板开着但我们不知道它绑谁（刚重载 / 布局被恢复）→ 也不夺焦点', () => {
  withHarness({ tabs: [layoutTab()], chat: chatOf([node('call-a', 1)]) }, (h) => {
    assert.equal(h.autoOpen('call-a', true), false, '不知道它绑着谁就不猜');
    assert.deepEqual(h.opened, []);
  });
});

test('窄屏（<768px）→ 不弹：右侧栏是覆盖式全屏，会盖住对话', () => {
  withHarness({ width: 760, chat: chatOf([node('call-a', 1)]) }, (h) => {
    assert.equal(h.autoOpen('call-a', true), false);
    assert.deepEqual(h.opened, []);
  });
  // 阈值两侧各一条：768 本身不窄（官方是 `< 768`）。
  withHarness({ width: 768, chat: chatOf([node('call-a', 1)]) }, (h) => {
    assert.equal(h.autoOpen('call-a', true), true);
  });
});

test('没有可展示的东西（空池）→ 不弹：`buildDeliverableView` 有返回也不算数', () => {
  withHarness({ chat: chatOf([node('call-a', 1)]) }, (h) => {
    assert.equal(h.autoOpen('call-a', false), false);
    assert.deepEqual(h.opened, []);
  });
});

test('读不出轮次（会话没绑定 / chat 视图没注册）→ 不记账，但仍按"tab 没开"处理', () => {
  withHarness({ chats: undefined, chat: undefined }, (h) => {
    assert.equal(h.autoOpen('call-a', true), true, '读不出轮次不该把弹这件事一起否掉');
    assert.equal(h.autoOpen('call-b', true), false,
      '第二次仍然不弹 —— 第一次已经把 tab 开上并绑给了 call-a，这一件是"绑着别的"');
  });
});

test('会话没绑定（binding 抛）也不炸：按"读不出轮次"处理', () => {
  const opened = [];
  const registered = new Map();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: { innerWidth: 1440 }, configurable: true });
  apply({
    effect: (fn) => { fn(); return () => {}; },
    sidebarRightTabs: { register: () => () => {} },
    sidebarRight: { tabsIn: () => [], openTabIn: (...args) => opened.push(args) },
    uiConversation: { binding: () => { throw new Error('session/not-found'); } },
    slots: { inject: (key, callback) => { callback(); return () => {}; },
      register: (options) => { registered.set(options.name, options); return () => {}; } },
  });
  try {
    assert.equal(registered.get('tool.call.toolview').inject(SESSION).autoOpenDeliverable('call-a', true), true);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else Object.defineProperty(globalThis, 'window', previous);
  }
});

test('面板拿得到「读门户地址」那一跳（值由宿主配置经路由给过来，不是写死在组件里）', () => {
  withHarness({}, (h) => {
    const face = h.registered.get('sidebar.right.pane.tab').options.inject(SESSION);
    assert.equal(typeof face.loadPortalOrigin, 'function');
    assert.equal(face.loadPortalOrigin() instanceof Promise, true, '读的是宿主那条路由，异步拿');
  });
});
