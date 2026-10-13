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
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { apply, inject, sceneCardPath } from '../dist/index.js';
import { portalPath } from '../dist/client/portal.js';

/**
 * 一个只实现这条路由与生产者接线用到的那几个面的假 ctx。
 *
 * `extras.fs` / `extras.sessions` 透传到子插件那一层：生产者与 `deliverables` 路由**都在
 * 子插件里**取它们（路由走 `ctx.get`，生产者走 `inject(['fs'])` 那层的 `ctx.fs`），
 * 不在这台假 ctx 上取。
 *
 * `child.inject` **照着 cordis 的语义来**：依赖齐了才回调，缺一个就永远不回调（真宿主里
 * 那个子插件会停在 PENDING）。`fs` 缺席时这里只剩路由、没有生产者，正是要钉的那条。
 *
 * `child.on` / `child.logger` 不是恒等空实现，而是**记下来**：适配层转发得对不对，只有
 * 从这一侧看得见 —— 生产者的订阅进不来、warn 出不去，都是静默的。这些记录挂在返回的路由
 * 条目上的 `wiring` 里（已有用例继续把它当路由用，一个字都不用改）。
 */
async function host(options, extras = {}) {
  const registered = [];
  const subscriptions = [];
  const loggerNames = [];
  const warnings = [];
  const injects = [];
  let sessionHandler;
  const child = {
    name: 'workdsh-scene-card-integration',
    effect: () => () => {},
    connection: { fetch: { register: (entry) => { registered.push(entry); return () => {}; } } },
    fs: extras.fs,
    sessions: extras.sessions,
    // `ctx.get`（假 ctx 上就是"有没有这一样"）。真宿主里它不抛、也没有 inject 要求。
    get: (name) => child[name],
    // `ctx.inject(deps, cb)` = 一个等依赖的子插件：齐了才跑，缺一个就永远不跑。
    inject: (deps, callback) => {
      injects.push(deps);
      if (deps.every((dep) => child[dep] !== undefined)) callback(child);
    },
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
      subscriptions, loggerNames, warnings, injects,
      /** 子插件那层的依赖表（导出级那份在模块上的 `inject` 里）。 */
      integrationInject: definition.inject,
      /** 宿主换掉 `fs` 提供方（钉"生产者每次现取"）。 */
      useFs: (next) => { child.fs = next; },
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

/**
 * 手写一份**格式合法**的交付物到 `workspace` 下：`交付物/<slug>/manifest.json` + 正文。
 * 用途是给"两个工作区各放一份、看路由读哪一个"当靶子 —— 生产者在场时它会自己写，
 * 但那条链要走事件流，这里只要盘上有一份能过 `readManifest` 的。
 */
async function seedDeliverable(workspace, slug, callId) {
  const dir = join(workspace, '交付物', slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'v1.json'), JSON.stringify({ format: 'workdsh-deliverable' }, null, 2), 'utf8');
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    format: 'workdsh-deliverable',
    schemaVersion: 1,
    slug,
    subject: slug,
    callId,
    current: 'v1.json',
    versions: [{ file: 'v1.json', at: '2026-10-13T04:58:00.000Z', note: '' }],
  }, null, 2), 'utf8');
}

/** 一条只带会话 id 的 `list` / `resolve` 请求 —— 工作区根由宿主自己解析，请求里不报。 */
const ask = async (entry, payload) => (await entry.fetch(request({ endpoint: 'deliverables', payload }))).json();

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

/** 一个会话一直在场：下面几条路由契约用例都靠它把"工作区根"这一步走过去。 */
const sessionAt = (id, cwd) => new Map([[id, cwd === undefined ? { header: {} } : { header: { cwd } }]]);

test('deliverables/resolve：没有这个 callId ⇒ path 为 null，不是报错', async () => {
  const entry = await host({}, { fs: emptyFs, sessions: sessionAt('s1', '/tmp/none') });
  const body = await ask(entry, { action: 'resolve', sessionId: 's1', callId: 'call_x' });
  assert.equal(body.ok, true);
  assert.equal(body.value.path, null);
});

test('deliverables：未知 action ⇒ 400，且错误码稳定', async () => {
  const entry = await host({}, { fs: emptyFs, sessions: sessionAt('s1', '/tmp/none') });
  const response = await entry.fetch(request({ endpoint: 'deliverables',
    payload: { action: '别的', sessionId: 's1' } }));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, 'scene-card/invalid-request');
});

test('deliverables/list：目录不存在 ⇒ 空数组', async () => {
  const entry = await host({}, { fs: emptyFs, sessions: sessionAt('s1', '/tmp/none') });
  assert.deepEqual((await ask(entry, { action: 'list', sessionId: 's1' })).value.entries, []);
});

test('deliverables：缺 sessionId ⇒ 400（工作区根不是调用者能报的，只能指名会话）', async () => {
  const entry = await host({}, { fs: emptyFs, sessions: sessionAt('s1', '/tmp/none') });
  const response = await entry.fetch(request({ endpoint: 'deliverables', payload: { action: 'list' } }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'scene-card/invalid-request');
});

test('deliverables：认不出这个会话 ⇒ 400，**不是**一个空列表（空列表会被读成"一份都没有"）', async () => {
  const entry = await host({}, { fs: emptyFs, sessions: new Map() });
  const response = await entry.fetch(request({ endpoint: 'deliverables',
    payload: { action: 'list', sessionId: 's1' } }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'scene-card/unknown-session');
});

test('deliverables：会话没有 cwd ⇒ 如实回空（生产者正是跳过这种会话，spec §7）', async () => {
  const entry = await host({}, { fs: emptyFs, sessions: sessionAt('s1', undefined) });
  assert.deepEqual((await ask(entry, { action: 'list', sessionId: 's1' })).value.entries, []);
  assert.equal((await ask(entry, { action: 'resolve', sessionId: 's1', callId: 'x' })).value.path, null);
});

/**
 * **工作区根由宿主解析**。两个真目录里各放一份格式合法的交付物，会话指向其中一个，
 * 请求里报另一个：读出来必须只有会话那一个。
 *
 * 这一条钉的是"调用者能不能自己挑一个目录给宿主去列举"—— 信客户端报的 `cwd` 的实现会
 * 把 `elsewhere` 那份列出来（`callId` 对不上，断言当场红）。
 */
test('deliverables：请求里报的工作区不作数 —— 只认宿主按会话 id 解析出来的那个', async () => {
  const mine = await mkdtemp(join(tmpdir(), 'scene-card-host-mine-'));
  const elsewhere = await mkdtemp(join(tmpdir(), 'scene-card-host-elsewhere-'));
  try {
    await seedDeliverable(mine, '20261013-045800-mine', 'call_mine');
    await seedDeliverable(elsewhere, '20261013-045800-elsewhere', 'call_elsewhere');
    const entry = await host({}, { fs: diskFs, sessions: sessionAt('s1', mine) });

    const listed = await ask(entry, { action: 'list', sessionId: 's1', cwd: elsewhere });
    assert.deepEqual(listed.value.entries.map((e) => e.callId), ['call_mine']);
    assert.ok(listed.value.entries[0].path.startsWith(mine), listed.value.entries[0].path);
    assert.ok(!listed.value.entries[0].path.startsWith(elsewhere));

    // 反查同理：别处的 callId 查不出来，会话自己那一个查得到
    assert.equal((await ask(entry, { action: 'resolve', sessionId: 's1', cwd: elsewhere,
      callId: 'call_elsewhere' })).value.path, null);
    assert.equal((await ask(entry, { action: 'resolve', sessionId: 's1', cwd: elsewhere,
      callId: 'call_mine' })).value.path, listed.value.entries[0].path);
  } finally {
    await rm(mine, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});

/**
 * **`fs` 挂在哪一层**。导出级那一层只管 `connection`；`fs` 只在生产者那层要。
 *
 * 为什么这不是洁癖：cordis 的注入是"等到齐才生效"，一个服务缺席时**整个插件**不生效 ——
 * `fs` 若挂在导出级，没有 `fs` 的部署里连 `portal` 都会一起消失（面板据它决定能不能点导出）。
 * 所以 `host({...})` **故意不给 `extras.fs`**：这条用例里"生产者没挂上、portal 照答"必须同时成立。
 */
test('没有 `fs` 的部署：插件照样挂上、`portal` 照答，只有生产者不挂', async () => {
  const route = await host({ portalOrigin: 'https://www.geoclar.com' });
  assert.deepEqual(inject, ['connection'], '导出级的依赖表里不该有 fs');
  assert.deepEqual(route.wiring.integrationInject, ['connection'], '路由那一层同样不该等 fs');
  assert.deepEqual(route.wiring.injects, [['fs']], 'fs 只该出现在生产者那一层');
  assert.deepEqual(route.wiring.subscriptions, [],
    '没有 fs 就不该有生产者 —— 它连订阅都不该挂上');

  const response = await route.fetch(request({ endpoint: 'portal', payload: {} }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, value: { portalOrigin: 'https://www.geoclar.com' } });

  // deliverables 那半边没有 fs 就答不了：**说得出原因**，而不是抛出去或假装是空的
  const unavailable = await host({}, { sessions: sessionAt('s1', '/tmp/none') });
  const failed = await unavailable.fetch(request({ endpoint: 'deliverables',
    payload: { action: 'list', sessionId: 's1' } }));
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).error.code, 'scene-card/unavailable');
});

/**
 * 接线这一条：本任务存在的理由就是"生产者挂上去、共享同一个 fs、写进**宿主解析出的**会话工作区"。
 * 三条里任何一条单独被改坏（挂载删掉、`fs` 换成别的、`cwd` 换成常量、适配层两个入参调换），
 * 这里都得红 —— 上面那几条路由契约用例对这种坏法是**瞎的**（空目录与空 cwd 都答得一样漂亮）。
 */
test('接线：生产者订阅在子插件上，一次工具返回就落在宿主解析出的那个会话工作区里', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'scene-card-host-'));
  const elsewhere = await mkdtemp(join(tmpdir(), 'scene-card-host-elsewhere-'));
  try {
    const entry = await host({}, { fs: diskFs, sessions: sessionAt('sess-wired', cwd) });
    // 适配层把事件名原样交出去了（`on` 转发的是 `session/event`，不是它自己的名字）
    assert.deepEqual(entry.wiring.subscriptions, ['session/event']);

    const callId = 'call_wired_1';
    entry.wiring.feed({ id: 'sess-wired', header: { cwd } }, recommendEvents(callId));
    await waitFor(async () => (await ask(entry, { action: 'list', sessionId: 'sess-wired' }))
      .value.entries.length === 1, '生产者把这一份写进会话的工作区');

    const entries = (await ask(entry, { action: 'list', sessionId: 'sess-wired' })).value.entries;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].callId, callId);
    assert.ok(entries[0].path.startsWith(cwd), `落盘位置应当在会话工作区之下：${entries[0].path}`);

    // 反向：会话指向别处就读不到这一份 —— 专钉"cwd 真的被用上了"，而不是被换成一个常量路径
    const moved = await host({}, { fs: diskFs, sessions: sessionAt('sess-wired', elsewhere) });
    assert.deepEqual((await ask(moved, { action: 'list', sessionId: 'sess-wired' })).value.entries, []);

    // 生产者写的、路由读的、resolve 反查回来的，是同一条路径
    const resolved = await ask(entry, { action: 'resolve', sessionId: 'sess-wired', callId });
    assert.equal(resolved.value.path, entries[0].path);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});

/**
 * 生产者**每次落盘都现取** `fs`（适配层上那个 getter）：宿主换过提供方，路由与生产者要一起换。
 *
 * 两个"只记下写到哪里"的替身把这件事变得可观测：没有 getter（挂载时钉死一个服务对象）时，
 * 第二份仍落在**第一个**替身上，这条用例就红。
 */
test('接线：生产者每次落盘都现取 `fs`（宿主换过提供方它跟着换）', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'scene-card-host-'));
  const landed = { first: [], second: [] };
  const spy = (bucket) => ({
    ...diskFs,
    writeText: async (target, content) => {
      bucket.push(target.absolute);
      await writeFile(target.absolute, content, 'utf8');
    },
  });
  try {
    const entry = await host({}, { fs: spy(landed.first), sessions: sessionAt('s1', cwd) });
    entry.wiring.feed({ id: 's1', header: { cwd } }, recommendEvents('call_before'));
    await waitFor(() => landed.first.some((p) => p.endsWith('manifest.json')), '第一份落在第一个 fs 上');

    entry.wiring.useFs(spy(landed.second));
    entry.wiring.feed({ id: 's1', header: { cwd } }, recommendEvents('call_after'));
    await waitFor(() => landed.second.some((p) => p.endsWith('manifest.json')),
      '第二份跟着换到第二个 fs 上');

    assert.equal(landed.first.filter((p) => p.endsWith('manifest.json')).length, 1,
      '第一份不该再往旧的那个写第二遍');
  } finally {
    await rm(cwd, { recursive: true, force: true });
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
