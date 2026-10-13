/**
 * 落盘与反查。用真临时目录 + 一个把 `ctx.fs` 映射到 node:fs 的薄壳，
 * 这样测的是**真文件**，而不是又一次打桩。
 * 跑法：node --test packages/plugins/scene-card/tests/deliverable-store.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverableDirOf, listDeliverables, resolveCallId, writeDeliverable }
  from '../dist/runtime/deliverable-store.js';

/** `ctx.fs` 的最小面：resolve 返回自己的绝对路径，writeText 写下去。 */
const fs = {
  resolve: async (path) => ({ targetKey: path, absolute: path }),
  writeText: async (target, content) => { await writeFile(target.absolute, content, 'utf8'); },
};

const docs = (slug, callId) => ({
  slug,
  manifest: { format: 'workdsh-deliverable', schemaVersion: 1, slug, subject: 's',
    callId, current: 'v1.json', versions: [{ file: 'v1.json', at: '2026-10-13T00:00:00.000Z', note: '' }] },
  version: { format: 'workdsh-deliverable', type: 'scene-schemes', title: 's', summary: '',
    intent: { tool: 'geoclar_recommend_schemes', scheme: 'CUSTOM', aoi: 'POLYGON EMPTY', conditions: {} },
    payload: { mode: 'custom', schemes: [{ key: 'CUSTOM' }] } },
});

async function withDir(body) {
  const cwd = await mkdtemp(join(tmpdir(), 'wd-deliv-'));
  try { await body(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

test('deliverableDirOf：工作区根下 交付物/<slug>', () => {
  assert.equal(deliverableDirOf('/root/geoclar', '20261013-045800-x'), '/root/geoclar/交付物/20261013-045800-x');
});

test('落盘：两个文件都写出；目录自己建出来；正文是两空格缩进、结尾无换行', async () => {
  await withDir(async (cwd) => {
    // 这个 slug 在磁盘上不存在 ⇒ 顺带验证"目录不存在时自己建出来"（`ctx.fs` 没有 mkdir）。
    const path = await writeDeliverable(fs, cwd, docs('20261013-045800-a', 'call_1'));
    assert.equal(path, join(cwd, '交付物', '20261013-045800-a'));
    const manifestText = await readFile(join(path, 'manifest.json'), 'utf8');
    assert.equal(JSON.parse(manifestText).callId, 'call_1');
    // 真正的格式断言（不是只 round-trip 一遍 JSON）：缩进是两空格、结尾不留换行。
    assert.match(manifestText, /^\{\n {2}"format":/);
    assert.ok(!manifestText.endsWith('\n'), '结尾不该有换行');
    const versionText = await readFile(join(path, 'v1.json'), 'utf8');
    assert.equal(JSON.parse(versionText).type, 'scene-schemes');
    assert.match(versionText, /^\{\n {2}"format":/);
  });
});

test('列举：目录不存在 ⇒ 空数组，不抛', async () => {
  await withDir(async (cwd) => {
    assert.deepEqual(await listDeliverables(fs, cwd), []);
  });
});

test('列举：只认 manifest.format 正确的那些，别的一律跳过', async () => {
  await withDir(async (cwd) => {
    await writeDeliverable(fs, cwd, docs('20261013-045800-a', 'call_1'));
    await writeDeliverable(fs, cwd, docs('20261013-045801-b', 'call_2'));
    // 一份普通目录：不是交付物，不该被算进去
    await writeFile(join(cwd, '交付物', 'not-a-deliverable.json'), '{}', 'utf8');
    const listed = await listDeliverables(fs, cwd);
    assert.deepEqual(listed.map((entry) => entry.slug).sort(), ['20261013-045800-a', '20261013-045801-b']);
    assert.equal(listed.find((e) => e.slug === '20261013-045800-a').callId, 'call_1');
  });
});

test('反查：按 callId 找到路径；找不到给 undefined', async () => {
  await withDir(async (cwd) => {
    const path = await writeDeliverable(fs, cwd, docs('20261013-045800-a', 'call_1'));
    assert.equal(await resolveCallId(fs, cwd, 'call_1'), path);
    assert.equal(await resolveCallId(fs, cwd, 'call_nope'), undefined);
  });
});

test('反查：半份 JSON（写到一半）⇒ 跳过那一份，不抛', async () => {
  await withDir(async (cwd) => {
    const path = await writeDeliverable(fs, cwd, docs('20261013-045800-a', 'call_1'));
    await writeFile(join(path, 'manifest.json'), '{"format":"workdsh-deliv', 'utf8');
    assert.equal(await resolveCallId(fs, cwd, 'call_1'), undefined);
  });
});
