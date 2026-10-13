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

/** 本插件那个 tab 的记录；`callId` 为 undefined 表示"开着但没绑调用"。 */
const tabOf = (callId) => ({ kind: KIND, id: KIND, navigation: { params: callId === undefined ? undefined : { callId } } });

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
    // `effect` 的回调立刻跑，返回的清理件收起来 —— 卸载时真的会跑（`openedTurns` 就靠它清）。
    effect: (fn) => { const disposer = fn(); if (typeof disposer === 'function') disposers.push(disposer); return () => {}; },
    sidebarRightTabs: { register: () => () => {} },
    sidebarRight: {
      tabsIn: (sessionId) => (sessionId === SESSION ? open : []),
      // 真的 `openTabIn` 会把 tab 放到那里（重复开是**重绑**，Task 1 §9-8），假的也照做。
      openTabIn: (sessionId, kind, options) => {
        opened.push({ sessionId, kind, params: options?.params });
        const existing = open.findIndex((tab) => tab.kind === kind);
        const record = { kind, id: kind, navigation: { params: options?.params, revision: 1 } };
        if (existing === -1) open.push(record); else open[existing] = record;
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
  return {
    opened,
    registered,
    /** 用户把面板关掉了：tab 记录消失，但"本轮弹过"那笔账还在。 */
    close: () => { open.length = 0; },
    autoOpen: (callId, hasDeliverable) => registered.get('tool.call.toolview')
      .options.inject(SESSION).autoOpenDeliverable(callId, hasDeliverable),
    restore: () => {
      // 插件卸载：清理件跑一遍 —— 模块级的"哪一轮弹过"因此不跨用例（真机上不跨重载）。
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
  withHarness({ tabs: [tabOf('call-a')], chat: chatOf([node('call-a', 1)]) }, (h) => {
    assert.equal(h.autoOpen('call-a', true), false);
    assert.deepEqual(h.opened, []);
  });
});

test('面板开着但绑的是别的 callId → 不夺焦点（用户可能正在看历史那一件）', () => {
  withHarness({ tabs: [tabOf('call-old')], chat: chatOf([node('call-a', 1), node('call-old', 1)]) }, (h) => {
    assert.equal(h.autoOpen('call-a', true), false, '绑的不是这一件就不动它');
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
      '第二次仍然不弹 —— 因为第一次已经把 tab 开上了（这条兜底的账在 tabsIn 那边）');
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

test('门户地址从插件配置里来；没配就是 undefined（面板据此关掉导出按钮）', () => {
  withHarness({ config: { portalOrigin: 'https://portal.example.test/scene-search' } }, (h) => {
    assert.equal(h.registered.get('sidebar.right.pane.tab').options.inject(SESSION).portalOrigin,
      'https://portal.example.test/scene-search');
  });
  withHarness({}, (h) => {
    assert.equal(h.registered.get('sidebar.right.pane.tab').options.inject(SESSION).portalOrigin, undefined);
  });
});
