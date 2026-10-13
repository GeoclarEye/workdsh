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

/** 一个只实现这条路由用到的那几个面的假 ctx。 */
async function host(options) {
  const registered = [];
  const child = {
    name: 'workdsh-scene-card-integration',
    effect: () => () => {},
    connection: { fetch: { register: (entry) => { registered.push(entry); return () => {}; } } },
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
