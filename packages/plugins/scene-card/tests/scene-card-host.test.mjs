/**
 * Host 半区：把**部署配置**交给浏览器那一侧的那条路由。
 *
 * 为什么要有这一层（而不是客户端直接读 `ctx.config`）：客户端 bundle 由 boot manifest 装载，
 * 而 manifest 的一条只带 `id/url/rev/inject/external/immediately`，**没有 config**；实测
 * `ctx.config` 在客户端还会抛 `cannot get property "config" without inject`。所以配置留在
 * `cordis.patch.yml`（与连接器 `toolCallTimeoutMs` 同形），由宿主经这条同源路由送过去。
 *
 * 跑法：node --test packages/plugins/scene-card/tests/scene-card-host.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { apply, sceneCardPath } from '../dist/index.js';
import { portalPath } from '../dist/client/portal.js';

/**
 * 一个只实现这条路由与生产者接线用到的那几个面的假 ctx。
 *
 * `extras.fs` / `extras.sessions` 透传到子插件那一层：生产者与 `deliverables` 路由**都在
 * 子插件里**取它们（`integration.fs`），不在这台假 ctx 上取。
 *
 * `child.on` / `child.logger` 不是恒等空实现，而是**记下来**：适配层转发得对不对，只有
 * 从这一侧看得见 —— 生产者的订阅进不来、warn 出不去，都是静默的。三条记录挂在返回的路由
 * 条目上的 `wiring` 里（已有用例继续把它当路由用，一个字都不用改）。
 */
async function host(options, extras = {}) {
  const registered = [];
  const subscriptions = [];
  const loggerNames = [];
  const warnings = [];
  let sessionHandler;
  const child = {
    name: 'workdsh-scene-card-integration',
    effect: () => () => {},
    connection: { fetch: { register: (entry) => { registered.push(entry); return () => {}; } } },
    fs: extras.fs,
    sessions: extras.sessions,
    on: (event, handler) => {
      subscriptions.push(event);
      if (event === 'session/event') sessionHandler = handler;
    },
    logger: (name) => { loggerNames.push(name); return { warn: (message) => { warnings.push(message); } }; },
  };
  const ctx = {
    plugin: async () => {},
    effect: () => () => {},
    connection: child.connection,
  };
  // `apply` 把真正的接线放进一个子插件里；这里直接把子插件跑在假 ctx 上。
  const captured = [];
  ctx.plugin = async (definition) => { captured.push(definition); };
  await apply(ctx, options);
  const definition = captured[0];
  definition.apply(child);
  assert.equal(registered.length, 1);
  const entry = registered[0];
  return Object.assign(entry, {
    wiring: {
      subscriptions, loggerNames, warnings,
      /** 按会话事件流的顺序喂一拍（与宿主派发同形：`(session, event)`）。 */
      feed: (session, events) => {
        assert.notEqual(sessionHandler, undefined,
          '生产者没有订阅 session/event —— 子插件里挂载那一步没了？');
        for (const event of events) sessionHandler(session, event);
      },
    },
  });
}

/** 生产者是 fire-and-forget（不把 promise 交出来）：等它跑完只能盯成果。 */
async function waitFor(check, what) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise((done) => { setTimeout(done, 10); });
  }
  assert.fail(`等不到：${what}`);
}

/**
 * 落到真 node:fs 的 `ctx.fs` 替身，与 `deliverable-producer.test.mjs` 同一份语义
 * （`resolve` 按 `path.resolve` 拼、`processPath` 给执行世界的绝对路径、`listDir` 稳定名称序）；
 * 存储层自己的用例已经在那份上钉过，这里不重复钉。
 *
 * 接线用例**必须**落到真目录：它要看的正是"生产者写下去的那一份，能不能被同一条路由读回来"，
 * 两边共用同一个 `fs` 与同一个 `cwd` 才是这条链的全部内容。
 */
const diskFs = {
  resolve: async (path, opts) => ({ absolute: resolvePath(opts?.cwd ?? process.cwd(), path) }),
  processPath: (target) => target.absolute,
  writeText: async (target, content) => { await writeFile(target.absolute, content, 'utf8'); },
  readText: async (target) => await readFile(target.absolute, 'utf8'),
  listDir: async (target) => (await readdir(target.absolute, { withFileTypes: true }))
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      target: { absolute: join(target.absolute, entry.name) },
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
};

/** 一次 `geoclar_recommend_schemes` 返回的三连事件（形状同 `deliverable-producer.test.mjs`）。 */
const RECOMMEND_PAYLOAD = { mode: 'custom', poolAtLimit: false,
  schemes: [{ key: 'CUSTOM', sceneCount: 235 }] };
const recommendEvents = (callId) => [
  { type: 'user/message', data: { message: { content: [{ type: 'text', text: '霍尔木兹海峡' }] } } },
  { type: 'tool/call', data: { callId,
    name: 'mcp__geoclar__geoclar_recommend_schemes', arguments: '{}' } },
  { type: 'tool/result', data: { message: { source: { kind: 'tool', callId },
    content: [{ type: 'text', text: JSON.stringify(RECOMMEND_PAYLOAD) }] } } },
];

const request = (body) => new Request(`http://127.0.0.1${sceneCardPath}`,
  { method: 'POST', body: JSON.stringify(body) });

/**
 * 一个**空的**工作区：`交付物/` 下面什么都没有。这一层测的是路由契约，不是落盘，
 * 所以不去真建临时目录。
 *
 * 五个面都实现（而不是只写这条路由直接碰到的那两个）：只给 `resolve`/`writeText` 的话，
 * `listDeliverables` 里的 `fs.listDir(...)` 会抛 `TypeError`、被它自己的 `try` 吞掉，
 * 于是「目录不存在 ⇒ 空数组」这条用例**看着绿**、跑的却是「替身少了个方法」——测的不是它说的事。
 */
const emptyFs = {
  resolve: async (path) => ({ targetKey: path, displayPath: path }),
  writeText: async () => {},
  listDir: async () => [],
  readText: async () => { throw new Error('空文件系统里没有可读的文件'); },
  processPath: (target) => target.displayPath,
};

test('两个半区写的是同一个路径（各写一份，靠这条钉住一致）', () => {
  assert.equal(sceneCardPath, portalPath);
});

test('配了门户地址：`portal` 这条 endpoint 把它交出去', async () => {
  const route = await host({ portalOrigin: 'https://www.geoclar.com' });
  assert.equal(route.path, sceneCardPath);
  assert.deepEqual(route.methods, ['POST']);
  const response = await route.fetch(request({ endpoint: 'portal', payload: {} }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, value: { portalOrigin: 'https://www.geoclar.com' } });
});

test('没配门户地址：如实回 null（客户端据此把「导出」关掉并说明原因）', async () => {
  for (const options of [{}, { portalOrigin: '' }]) {
    const route = await host(options);
    const response = await route.fetch(request({ endpoint: 'portal' }));
    assert.deepEqual(await response.json(), { ok: true, value: { portalOrigin: null } });
  }
});

test('不认识的 endpoint：报错而不是回一个空值（客户端据此保持关着）', async () => {
  const route = await host({ portalOrigin: 'https://www.geoclar.com' });
  const response = await route.fetch(request({ endpoint: 'nope' }));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'scene-card/invalid-request');
});

test('deliverables/resolve：没有这个 callId ⇒ path 为 null，不是报错', async () => {
  const entry = await host({}, { fs: emptyFs, sessions: new Map() });
  const response = await entry.fetch(request({ endpoint: 'deliverables',
    payload: { action: 'resolve', sessionId: 's1', cwd: '/tmp/none', callId: 'call_x' } }));
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.value.path, null);
});

test('deliverables：未知 action ⇒ 400，且错误码稳定', async () => {
  const entry = await host({}, { fs: emptyFs, sessions: new Map() });
  const response = await entry.fetch(request({ endpoint: 'deliverables',
    payload: { action: '别的', sessionId: 's1', cwd: '/tmp/none' } }));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, 'scene-card/invalid-request');
});

test('deliverables/list：目录不存在 ⇒ 空数组', async () => {
  const entry = await host({}, { fs: emptyFs, sessions: new Map() });
  const response = await entry.fetch(request({ endpoint: 'deliverables',
    payload: { action: 'list', sessionId: 's1', cwd: '/tmp/none' } }));
  const body = await response.json();
  assert.deepEqual(body.value.entries, []);
});

/**
 * 接线这两条：本任务存在的理由就是"生产者挂上去、共享同一个 fs、读请求上送的那个 cwd"。
 * 三条里任何一条单独被改坏（挂载删掉、`fs` 换成别的、`cwd` 换成常量、适配层两个入参调换），
 * 这里都得红 —— 上面那三条路由契约用例对这种坏法是**瞎的**（空目录与空 cwd 都答得一样漂亮）。
 */
test('接线：生产者订阅在子插件上，一次工具返回就在**请求上送的那个** cwd 下落一份', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'scene-card-host-'));
  const elsewhere = await mkdtemp(join(tmpdir(), 'scene-card-host-elsewhere-'));
  const list = async (entry, atCwd) => (await entry.fetch(request({ endpoint: 'deliverables',
    payload: { action: 'list', sessionId: 's1', cwd: atCwd } }))).json();
  try {
    const entry = await host({}, { fs: diskFs, sessions: new Map() });
    // 适配层把事件名原样交出去了（`on` 转发的是 `session/event`，不是它自己的名字）
    assert.deepEqual(entry.wiring.subscriptions, ['session/event']);

    const callId = 'call_wired_1';
    entry.wiring.feed({ id: 'sess-wired', header: { cwd } }, recommendEvents(callId));
    await waitFor(async () => (await list(entry, cwd)).value.entries.length === 1,
      '生产者把这一份写进请求上送的那个 cwd');

    const entries = (await list(entry, cwd)).value.entries;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].callId, callId);
    assert.ok(entries[0].path.startsWith(cwd),
      `落盘位置应当在请求上送的 cwd 之下：${entries[0].path}`);

    // 反向：换个 cwd 去读读不到 —— 这一条专钉"cwd 真的被用了"，而不是被换成一个常量路径
    assert.deepEqual((await list(entry, elsewhere)).value.entries, []);

    // 生产者写的、路由读的、resolve 反查回来的，是同一条路径
    const resolved = await (await entry.fetch(request({ endpoint: 'deliverables',
      payload: { action: 'resolve', sessionId: 's1', cwd, callId } }))).json();
    assert.equal(resolved.value.path, entries[0].path);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});

test('接线：会话没有 cwd ⇒ 不落盘、记一条 warn，且那条 warn 走的是宿主的 logger', async () => {
  const entry = await host({}, { fs: diskFs, sessions: new Map() });
  entry.wiring.feed({ id: 'sess-no-cwd', header: {} }, recommendEvents('call_no_cwd'));
  await waitFor(() => entry.wiring.warnings.length > 0, '宿主的 logger 收到那条 warn');
  // logger 的名字也原样转发（生产者按它取的名字要日志）
  assert.deepEqual(entry.wiring.loggerNames, ['workdsh-scene-card']);
  assert.deepEqual(entry.wiring.warnings, ['交付物跳过：会话没有 cwd']);
});
