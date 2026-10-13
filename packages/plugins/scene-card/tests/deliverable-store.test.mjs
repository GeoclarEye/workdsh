/**
 * 落盘与反查。用真临时目录 + 一个把 `ctx.fs` 映射到 node:fs 的薄壳，
 * 这样测的是**真文件**，而不是又一次打桩。
 * 跑法：node --test packages/plugins/scene-card/tests/deliverable-store.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative as relativePath, resolve as resolvePath } from 'node:path';
import { deliverableDirOf, listDeliverables, resolveCallId, writeDeliverable }
  from '../dist/runtime/deliverable-store.js';

const target = (absolute) => ({ absolute });

/**
 * `ctx.fs` 的最小面，落到真 node:fs：target 就是 `{ absolute }`，`processPath` 摊开它。
 * `resolve` 按 `path.resolve` 语义（绝对路径直接胜出，不看 cwd），与 `ctx.fs` 一致；
 * `listDir` 按契约给**稳定名称序**并带上已解析的 target。
 */
const fs = {
  resolve: async (path, opts) => target(resolvePath(opts?.cwd ?? process.cwd(), path)),
  processPath: (t) => t.absolute,
  writeText: async (t, content) => { await writeFile(t.absolute, content, 'utf8'); },
  readText: async (t) => await readFile(t.absolute, 'utf8'),
  listDir: async (t) => (await readdir(t.absolute, { withFileTypes: true }))
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      target: target(join(t.absolute, entry.name)),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
};

const docs = (slug, callId) => ({
  slug,
  manifest: { format: 'workdsh-deliverable', schemaVersion: 1, slug, subject: 's',
    callId, current: 'v1.json', versions: [{ file: 'v1.json', at: '2026-10-13T00:00:00.000Z', note: '' }] },
  version: { format: 'workdsh-deliverable', type: 'scene-schemes', title: 's', summary: '',
    intent: { tool: 'geoclar_recommend_schemes', scheme: 'CUSTOM', aoi: 'POLYGON EMPTY', conditions: {} },
    payload: { mode: 'custom', schemes: [{ key: 'CUSTOM' }] } },
});

/** 手写一份 manifest 进一个真目录（不经 `writeDeliverable`）——用来造被判废的那些形状。 */
async function putManifest(cwd, name, manifest) {
  const dir = join(cwd, '交付物', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  return dir;
}

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
    // 目录名与盘上 manifest 记的 slug 相符：夹具两侧同值，锚的是"店开在它自己招牌下"这件事。
    assert.equal(basename(path), JSON.parse(manifestText).slug);
    const versionText = await readFile(join(path, 'v1.json'), 'utf8');
    assert.equal(JSON.parse(versionText).type, 'scene-schemes');
    assert.match(versionText, /^\{\n {2}"format":/);
  });
});

test('落盘：cwd 给相对路径时，返回的仍是绝对路径', async () => {
  await withDir(async (cwd) => {
    const relative = relativePath(process.cwd(), cwd);   // 临时目录通常在当前目录之外，是个 `../..` 串
    assert.equal(resolvePath(process.cwd(), relative), cwd);   // 前提自检：这条相对路径指的确实是 cwd
    const path = await writeDeliverable(fs, relative, docs('20261013-045800-a', 'call_1'));
    assert.equal(path, join(cwd, '交付物', '20261013-045800-a'));
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
    // 一份普通文件：不是目录，类型闸就该把它挡在外面
    await writeFile(join(cwd, '交付物', 'not-a-deliverable.json'), '{}', 'utf8');
    const listed = await listDeliverables(fs, cwd);
    assert.deepEqual(listed.map((entry) => entry.slug).sort(), ['20261013-045800-a', '20261013-045801-b']);
    assert.equal(listed.find((e) => e.slug === '20261013-045800-a').callId, 'call_1');
  });
});

test('列举：format 不对、主版读不懂 ⇒ 整份不认（两条硬规矩各自都要真的走到）', async () => {
  await withDir(async (cwd) => {
    await writeDeliverable(fs, cwd, docs('20261013-045800-a', 'call_1'));
    // 两份**真目录**，且 slug 与目录名相符 —— 好让被判废的原因只可能是下面那两条
    await putManifest(cwd, '20261013-045801-b',
      { ...docs('20261013-045801-b', 'call_2').manifest, format: 'something-else' });
    await putManifest(cwd, '20261013-045802-c',
      { ...docs('20261013-045802-c', 'call_3').manifest, schemaVersion: 2 });
    const listed = await listDeliverables(fs, cwd);
    assert.deepEqual(listed.map((e) => e.slug), ['20261013-045800-a']);
    assert.equal(await resolveCallId(fs, cwd, 'call_2'), undefined);
    assert.equal(await resolveCallId(fs, cwd, 'call_3'), undefined);
  });
});

test('列举：目录名与 manifest 记的 slug 不符 ⇒ 不认，不许冒名顶替', async () => {
  await withDir(async (cwd) => {
    const good = await writeDeliverable(fs, cwd, docs('20261013-045800-a', 'call_1'));
    // 手改过的 manifest：它记的 slug 是**另一个目录**的名字
    await putManifest(cwd, '20261013-045801-b',
      { ...docs('20261013-045801-b', 'call_2').manifest, slug: '20261013-045800-a' });
    const listed = await listDeliverables(fs, cwd);
    assert.deepEqual(listed.map((e) => e.slug), ['20261013-045800-a']);   // 不是两份
    assert.deepEqual(listed.map((e) => e.path), [good]);                  // 也不是别人那个目录
    assert.equal(await resolveCallId(fs, cwd, 'call_2'), undefined);
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

test('正文写失败 ⇒ 不留 manifest，列表里也就看不到半份交付物', async () => {
  await withDir(async (cwd) => {
    const failing = {
      ...fs,
      writeText: async (t, content) => {
        if (String(t.absolute).endsWith('v1.json')) throw new Error('写正文失败');
        await writeFile(t.absolute, content, 'utf8');
      },
    };
    await assert.rejects(() => writeDeliverable(failing, cwd, docs('20261013-045800-a', 'call_1')));
    assert.deepEqual(await listDeliverables(fs, cwd), []);
  });
});
