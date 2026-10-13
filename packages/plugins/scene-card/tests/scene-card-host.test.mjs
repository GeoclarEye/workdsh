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
import { apply, sceneCardPath } from '../dist/index.js';
import { portalPath } from '../dist/client/portal.js';

/**
 * 一个只实现这条路由与生产者接线用到的那几个面的假 ctx。
 *
 * `extras.fs` / `extras.sessions` 透传到子插件那一层：生产者与 `deliverables` 路由**都在
 * 子插件里**取它们（`integration.fs`），不在这台假 ctx 上取。
 */
async function host(options, extras = {}) {
  const registered = [];
  const child = {
    name: 'workdsh-scene-card-integration',
    effect: () => () => {},
    connection: { fetch: { register: (entry) => { registered.push(entry); return () => {}; } } },
    fs: extras.fs,
    sessions: extras.sessions,
    // 生产者挂载时会立刻订阅会话事件并取一个 logger；这里只要它们**存在**。
    on: () => {},
    logger: () => ({ warn: () => {} }),
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
  return registered[0];
}

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
