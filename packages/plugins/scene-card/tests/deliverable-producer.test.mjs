/**
 * 生产者：事件进 → 文件出。用假 ctx + 真临时目录，测的是"真的落了盘、内容对"。
 * 跑法：node --test packages/plugins/scene-card/tests/deliverable-producer.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { registerDeliverableProducer } from '../dist/runtime/deliverable-producer.js';
import { callIdOfResult } from '../dist/runtime/tool-call-pairing.js';
import { listDeliverables } from '../dist/runtime/deliverable-store.js';

/**
 * `ctx.fs` 的薄壳，落到真 node:fs —— 与 `deliverable-store.test.mjs` 同一份（那处已逐条钉过）。
 *
 * 这里**必须**是完整的一份，不能只给 `resolve` + `writeText`：生产者落盘走的是 `writeDeliverable`
 * （它要 `processPath` 才拿得到执行世界的绝对路径），去重走的是 `listDeliverables`（它要 `listDir` +
 * `readText` 才扫得出 manifest）。缺哪个，生产者那条 `.catch` 都会把缺口的 TypeError 咽成一条日志 ——
 * 测试只会看见"没落盘"，看不出为什么。而且 `resolve` 必须按 `path.resolve` 语义拼，
 * 不能原样返回入参：`writeDeliverable` 交给 `mkdir`/`writeFile` 的是 `processPath` 的结果，
 * 相对路径会被解析成**进程的 cwd**，于是文件落到测试目录之外去。
 *
 * 每个方法顺手记两笔：在飞的操作数，以及**写 manifest 的次数**（T2 定的完成标记 —— 一份交付物
 * 的最后一步就是写它）。生产者是 fire-and-forget（不把 promise 交出来），测试要等它跑完，
 * 只能盯这条通道 —— 见 `settle`。
 */
const ops = { started: 0, inFlight: 0, manifests: 0 };
const track = (body) => async (...args) => {
  ops.started += 1;
  ops.inFlight += 1;
  try { return await body(...args); } finally { ops.inFlight -= 1; }
};
const fs = {
  resolve: track(async (path, opts) => ({ absolute: resolvePath(opts?.cwd ?? process.cwd(), path) })),
  processPath: (target) => target.absolute,
  writeText: track(async (target, content) => {
    if (target.absolute.endsWith('manifest.json')) ops.manifests += 1;
    await writeFile(target.absolute, content, 'utf8');
  }),
  readText: track(async (target) => await readFile(target.absolute, 'utf8')),
  listDir: track(async (target) => (await readdir(target.absolute, { withFileTypes: true }))
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      target: { absolute: join(target.absolute, entry.name) },
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))),
};

const payload = { mode: 'custom', poolAtLimit: false,
  schemes: [{ key: 'CUSTOM', sceneCount: 235 }] };

/** 连接器的线名：`mcp__<连接器 serverName>__<工具名>`。连接器是可改配置的（另有用例钉这条）。 */
const GEOCLAR = 'mcp__geoclar__geoclar_recommend_schemes';

const events = (callId, args, extra = {}) => [
  { type: 'user/message', data: { message: { content: [{ type: 'text', text: extra.subject ?? '霍尔木兹海峡' }] } } },
  { type: 'tool/call', data: { callId, name: extra.name ?? GEOCLAR,
    arguments: JSON.stringify(args) } },
  { type: 'tool/result', data: { message: { source: { kind: 'tool', callId },
    content: [{ type: 'text', text: JSON.stringify(extra.value ?? payload) }] } } },
];

/**
 * 装一个假 ctx，把 `on` 收到的 handler 抓住，返回一个"喂事件"的函数。
 * `options.fs` / `options.warn` 用来换掉那两样（要造"写盘失败""记日志自己抛"这类形状时）。
 */
function harness(cwd, warnings = [], options = {}) {
  let handler;
  registerDeliverableProducer({
    fs: options.fs ?? fs,
    on: (name, fn) => { assert.equal(name, 'session/event'); handler = fn; },
    logger: () => ({ warn: options.warn ?? ((message) => { warnings.push(message); }) }),
  });
  const session = { id: 'sess-1', header: { cwd } };
  return {
    feed: (event) => handler(session, event),
    /**
     * 等生产者那几笔挂起来的落盘跑完。它不给 promise（fire-and-forget 正是被测的行为），
     * 所以只能盯这条 fs 通道：**看见 `expect` 个新的 manifest 提交标记、且通道静下来**才算跑完；
     * manifest 是落一份交付物的最后一步，它写完就再没有后续操作，这条判据是准的。
     *
     * 为什么不用"睡定长"：落盘是"微任务 + 几步真 IO"（`mkdir` 内部走 `node:fs`，看不见），
     * 定时器阶段又先于 IO 完成回调所在的 poll 阶段。实测（同一台机器）：睡一拍 100 次里只有
     * 76 次看得见文件；睡三拍单跑够、**混在整套测试里仍会偶发变红**（整套是并行跑的）。所以盯条件。
     *
     * `expect = 0`（这一趟本来就不该落盘的：无 cwd、形状不认识、别的工具、重放）没有提交标记可等 ——
     * 那时用"静默够久"兜底（连 5 拍没有在飞/新起的操作，且至少过了 10ms）。上限是免得真出岔子时
     * 挂死，让断言去报错；一串要落的份数多时给得宽些。
     */
    settle: async (expect = 1) => {
      const commit = ops.manifests;
      const deadline = Date.now() + (expect > 1 ? 20000 : 5000);
      const floor = Date.now() + 10;
      let quiet = 0;
      while (Date.now() < deadline) {
        const started = ops.started;
        await new Promise((resolve) => { setImmediate(resolve); });
        const idle = ops.inFlight === 0 && ops.started === started;
        const landed = ops.manifests - commit;
        if (idle && expect > 0 && landed >= expect) break;  // 该落的都落了，且写完了
        quiet = idle && landed === 0 && Date.now() >= floor ? quiet + 1 : 0;
        if (quiet >= 5) break;                              // 这一趟不该落：静默够久就算它没打算落
      }
    },
  };
}

async function withDir(body) {
  const cwd = await mkdtemp(join(tmpdir(), 'wd-producer-'));
  try { await body(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

/**
 * 把盘上每一份都读出来（目录名 + manifest + 正文），供"两份都在、各是各的"这类断言用。
 */
async function readAll(cwd) {
  const items = [];
  for (const name of (await readdir(join(cwd, '交付物'))).sort()) {
    items.push({
      name,
      manifest: JSON.parse(await readFile(join(cwd, '交付物', name, 'manifest.json'), 'utf8')),
      version: JSON.parse(await readFile(join(cwd, '交付物', name, 'v1.json'), 'utf8')),
    });
  }
  return items;
}

/**
 * 等到**刚跨过秒边界**再往下走：slug 的时间戳只到秒（`slugOf`），"同一秒里撞名"这件事得自己造，
 * 而刚跨过边界时这一秒还剩 ~950ms，两次落盘只要毫秒级。
 * （不冻时钟：`settle` 的上下界用的就是 `Date.now()`，冻住它真出岔子时会等不到上限。）
 */
async function freshSecond() {
  await new Promise((resolve) => { setTimeout(resolve, 1000 - (Date.now() % 1000) + 5); });
}

test('一串事件 ⇒ 恰好落一份，目录名与 manifest 符合约定', async () => {
  await withDir(async (cwd) => {
    const h = harness(cwd);
    for (const event of events('call_1', { wkt: 'POLYGON EMPTY', maxCloud: 20 })) h.feed(event);
    await h.settle();
    const names = await readdir(join(cwd, '交付物'));
    assert.equal(names.length, 1);
    const manifest = JSON.parse(await readFile(join(cwd, '交付物', names[0], 'manifest.json'), 'utf8'));
    assert.equal(manifest.callId, 'call_1');
    assert.equal(manifest.subject, '霍尔木兹海峡');
    const version = JSON.parse(await readFile(join(cwd, '交付物', names[0], 'v1.json'), 'utf8'));
    assert.deepEqual(version.payload, payload);
    assert.deepEqual(version.intent.conditions, { maxCloud: 20 });
  });
});

test('同一个 callId 再来一次 result ⇒ 不落第二份', async () => {
  await withDir(async (cwd) => {
    const h = harness(cwd);
    const list = events('call_1', { wkt: 'W' });
    for (const event of list) h.feed(event);
    await h.settle();
    const [first] = await readdir(join(cwd, '交付物'));
    const before = await readFile(join(cwd, '交付物', first, 'manifest.json'), 'utf8');
    for (const event of list) h.feed(event);     // 重放
    await h.settle(0);                           // 这一趟**不该**再落：等"静默够久"，不是等提交标记
    assert.equal((await readdir(join(cwd, '交付物'))).length, 1);
    // 只数目录数**不够**：重放与首写落在同一秒里，slug 相同 ⇒ 抽掉 `listDeliverables` 那道去重闸，
    // 第二次也只会**覆盖同一份**，目录数照样是 1（实测：抽掉闸门，上面那条断言仍是绿的）。
    // manifest 的 `at` 是毫秒级的，而两次写入之间隔着一次 `settle`（≥10ms，见上）——
    // 真被改写过就必然是另一串字节，这条才钉得住"不落第二份"。
    assert.equal(await readFile(join(cwd, '交付物', first, 'manifest.json'), 'utf8'), before);
  });
});

test('会话没有 cwd ⇒ 不落盘，且记一条日志（spec §7）', async () => {
  await withDir(async (cwd) => {
    const warnings = [];
    let handler;
    registerDeliverableProducer({ fs,
      on: (_name, fn) => { handler = fn; },
      logger: () => ({ warn: (message) => { warnings.push(message); } }) });
    const session = { id: 's2', header: {} };
    for (const event of events('call_1', { wkt: 'W' })) handler(session, event);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /没有 cwd/);
    assert.deepEqual(await readdir(join(cwd, '交付物')).catch(() => []), []);
  });
});

test('形状不认识 ⇒ 不落盘、不打日志噪音', async () => {
  await withDir(async (cwd) => {
    const warnings = [];
    const h = harness(cwd, warnings);
    // 工具名必须是真的 geoclar：这条测的是**出参形状闸**，名字不改的话就可能被名字闸先挡掉，
    // 那就变成"名字闸的用例"了（形状闸的真行为反而没人测）。
    h.feed({ type: 'tool/call', data: { callId: 'c', name: GEOCLAR, arguments: '{"wkt":"W"}' } });
    h.feed({ type: 'tool/result', data: { message: { source: { callId: 'c' },
      content: [{ type: 'text', text: JSON.stringify({ mode: '别的' }) }] } } });
    await h.settle(0);
    assert.deepEqual(await readdir(join(cwd, '交付物')).catch(() => []), []);
    assert.equal(warnings.length, 0);
  });
});

/**
 * 配对 id 的读法：本模块是 `callIdOfResult` 的**第一个直接调用方**（Task 3 的评审把这条记为待补：
 * 那边的用例 6/7 只经 `note`/`take` 间接到达它）。形状读不懂的两种退化输入各钉一条。
 */
test('callIdOfResult：退化输入给 undefined，不硬凑一个 id', () => {
  assert.equal(callIdOfResult({}), undefined);
  assert.equal(callIdOfResult({ message: { source: { callId: '' } } }), undefined);
});

/**
 * 名字闸（spec §4：生产者要"认出那次工具返回"）。出参形状**能渲染**，但工具不是它 ⇒ 一个字节都不碰，
 * 也不记日志。没有这条闸，会话里任何回一段同形 JSON 的工具都会往工作区里丢一份"交付物"。
 */
test('别的工具（出参形状能渲染）⇒ 不落盘、不打日志', async () => {
  await withDir(async (cwd) => {
    const warnings = [];
    const h = harness(cwd, warnings);
    for (const e of events('call_x', { foo: 1 }, { name: 'other_tool' })) h.feed(e);
    await h.settle(0);
    assert.deepEqual(await readdir(join(cwd, '交付物')).catch(() => []), []);
    assert.equal(warnings.length, 0);
  });
});

/**
 * 名字闸比的是**裸名**：连接器 serverName 是部署侧可改的配置，改名后线名就变了。
 * 这条钉住"改名不该让它静默失效"。
 */
test('连接器改过名（线名里不是 geoclar）⇒ 照样认得出来', async () => {
  await withDir(async (cwd) => {
    const h = harness(cwd);
    for (const e of events('call_1', { wkt: 'W' },
      { name: 'mcp__geoclar-renamed__geoclar_recommend_schemes' })) h.feed(e);
    await h.settle();
    const names = await readdir(join(cwd, '交付物'));
    assert.equal(names.length, 1);
    assert.equal(JSON.parse(await readFile(join(cwd, '交付物', names[0], 'manifest.json'), 'utf8')).callId, 'call_1');
  });
});

/**
 * 同一秒、同一 subject 的两次**不同**调用：slug 的时间戳只到秒（`slugOf`），两份会算出同一个 slug。
 * 不挪开就会覆盖 —— spec §4 要的是"每次产出落一份新的**子目录**，不归并"，覆盖等于丢一份。
 *
 * 这两条（顺序落盘 / 同一拍并发落盘）各测一遍：顺序的那条由 `freeSlug` 兜住；同一拍的那条
 * 得靠落盘串行化（`writeChain`）—— 并发时双方的列举都跑在对方写入之前，`freeSlug` 看不见对方。
 */
test('同一秒、同一 subject、两个 callId（依次落盘）⇒ 各落一份，谁也盖不掉谁', async () => {
  await withDir(async (cwd) => {
    await freshSecond();
    const h = harness(cwd);
    for (const e of events('call_A', { wkt: 'W', maxCloud: 10 })) h.feed(e);
    await h.settle();
    for (const e of events('call_B', { wkt: 'W', maxCloud: 80 })) h.feed(e);
    await h.settle();
    const landed = await readAll(cwd);
    assert.equal(landed.length, 2);
    // 前提自检：两次确实落在同一秒里（不然本用例要测的撞名根本不成立）
    const secondOf = (iso) => iso.slice(0, 19);
    assert.equal(secondOf(landed[0].manifest.versions[0].at), secondOf(landed[1].manifest.versions[0].at),
      '两次没落在同一秒，用例不成立');
    // 第二份被挪到 `-2`，两份各自带着自己的 callId 与自己的入参（这份没被那份覆盖）
    assert.equal(landed[1].name, `${landed[0].name}-2`);
    assert.deepEqual(landed.map((item) => item.manifest.callId).sort(), ['call_A', 'call_B']);
    assert.deepEqual(landed.map((item) => item.version.intent.conditions.maxCloud).sort((x, y) => x - y), [10, 80]);
    // 两份都要被**列举**看得见：manifest 记的 slug 与目录名不符的话（位置闸），
    // 只改 `documents.slug` 不改 `manifest.slug` 就会落到这个坑里 —— 比撞名还糟。
    const listed = await listDeliverables(fs, cwd);
    assert.deepEqual(listed.map((entry) => entry.callId).sort(), ['call_A', 'call_B']);
    assert.deepEqual(listed.map((entry) => entry.slug).sort(), landed.map((item) => item.name).sort());
  });
});

/**
 * 同一拍（不等前一份落完）把两次调用的结果都喂进去 —— 两条落盘链会**交错**：
 * 双方的列举都跑在对方写入之前，于是双双选中同一个 slug。只有在**落盘串行化**之下
 * （`writeChain`）这条才过得了：修之前实测只落下 call_A 一份，call_B 把它盖掉了。
 */
test('同一拍进来的两份（同秒同 subject）⇒ 一份都不少', async () => {
  await withDir(async (cwd) => {
    await freshSecond();
    const h = harness(cwd);
    for (const e of events('call_A', { wkt: 'W', maxCloud: 10 })) h.feed(e);
    for (const e of events('call_B', { wkt: 'W', maxCloud: 80 })) h.feed(e);   // 不 settle，直接接着喂
    await h.settle(2);
    const landed = await readAll(cwd);
    assert.equal(landed.length, 2);
    const secondOf = (iso) => iso.slice(0, 19);
    assert.equal(secondOf(landed[0].manifest.versions[0].at), secondOf(landed[1].manifest.versions[0].at),
      '两次没落在同一秒，用例不成立');
    assert.equal(landed[1].name, `${landed[0].name}-2`);
    assert.deepEqual(landed.map((item) => item.manifest.callId).sort(), ['call_A', 'call_B']);
    assert.deepEqual(landed.map((item) => item.version.intent.conditions.maxCloud).sort((x, y) => x - y), [10, 80]);
  });
});

/**
 * 一拍里灌进一大串完整配对（80 对 > 配对器上限 `MAX_PENDING = 64`）⇒ **一份都不许丢**。
 *
 * 这条钉的是生产者"在**同一个 `tool/result` 事件里就地 `take`**"这条约束 —— Task 3 的
 * `MAX_PENDING` 安全论证就架在它上面。把 `take` 挪进微任务后，这 80 对会先全部堆进账里，
 * 只有最后 64 个还没被淘汰，其余 16 份静默丢掉（实测：写盘次数从 160 掉到 128）。
 */
test('一拍里灌 80 对（超过配对器上限）⇒ 80 份全落，不丢', async () => {
  await withDir(async (cwd) => {
    const h = harness(cwd);
    const pairs = 80;
    for (let i = 0; i < pairs; i++) {
      // 每对自己的 subject，落成的目录名互不相同（不然它们会撞进同一个 slug，数不出来）
      for (const e of events(`call_${i}`, { wkt: 'W' }, { subject: `第${i}件` })) h.feed(e);
    }
    await h.settle(pairs);
    const names = await readdir(join(cwd, '交付物'));
    assert.equal(names.length, pairs);
    // 每份的 subject 得是**它自己那条**用户消息（事件到达时就取好）。晚取的话，这一拍里最后那条
    // 用户消息会盖在所有 80 份头上 —— 标题全变成同一个，而这份文件是给人看的。
    const subjects = [];
    for (const name of names) {
      subjects.push(JSON.parse(await readFile(join(cwd, '交付物', name, 'manifest.json'), 'utf8')).subject);
    }
    assert.deepEqual(subjects.sort(), Array.from({ length: pairs }, (_, i) => `第${i}件`).sort());
  });
});

/**
 * 记日志这件事**自己抛**时，也不能把后面的落盘毒死。
 *
 * 记账函数挂在落盘链的尾部：它抛出去，`writeChain` 就被留成 rejected，后面每一份的
 * `writeChain.then(body)` 都会跳过 body —— 而且从此一直跳过，一次报错牵连掉此后**全部**交付物。
 * `logger.warn` 是宿主代码（宿主状态不对会抛），`String(cause)` 碰上会抛的 `toString` 也会抛，
 * 所以链尾挂了两道 catch。把最后那道兜底删掉，这条用例就该红。
 */
test('记日志自己抛 ⇒ 后面的落盘照落', async () => {
  await withDir(async (cwd) => {
    let writes = 0;
    const flaky = {
      ...fs,
      writeText: async (target, content) => {
        if (++writes === 1) throw new Error('磁盘满了');      // 第一份落盘失败 ⇒ 走到记账那一步
        await fs.writeText(target, content);                  // 之后正常（计数与写盘仍走原来那份）
      },
    };
    const warnings = [];
    const h = harness(cwd, [], {
      fs: flaky,
      warn: (message) => { warnings.push(message); throw new Error('日志管道坏了'); },
    });
    for (const e of events('call_A', { wkt: 'W' }, { subject: '甲' })) h.feed(e);
    for (const e of events('call_B', { wkt: 'W' }, { subject: '乙' })) h.feed(e);
    await h.settle();
    assert.equal(warnings.length, 1);                        // 记账**试过**一次（先记下、才抛）
    assert.match(warnings[0], /落盘失败/);
    // 走列举（不是逐个读目录）：第一份失败留下的那个空壳目录没有 manifest，本就不算交付物
    const listed = await listDeliverables(fs, cwd);
    assert.deepEqual(listed.map((entry) => entry.callId), ['call_B']);
  });
});
