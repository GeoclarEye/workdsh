/**
 * 交付物的**文件读写**：落一份、列一批、按 `callId` 反查路径。不构造内容、不判断业务。
 *
 * 为什么反查是**扫盘**而不是记账：spec §9 待定段定的就是这条 —— 答案从磁盘上的 manifest
 * 现扫得出，进程重启后照样答得出。这跟 §2 要退休的"内存绑定账"是两件事。
 *
 * 读与写**都走 `ctx.fs`**（`listDir` / `readText` / `writeText` / `resolve`）：两边必须落在同一个
 * 文件系统上，路径形态也只有一个地方负责（`resolve` 拼、`processPath` 摊开成执行世界的绝对路径）。
 * 唯一的例外是**建目录** —— `ctx.fs` 没有这个能力，那一处落到 `node:fs/promises`
 * （先例：`projects/src/runtime/project-workspace.ts`）。
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DELIVERABLE_FORMAT, DELIVERABLE_SCHEMA_VERSION, type DeliverableDocuments }
  from './deliverable-document.js';

/** 工作区根下的交付物目录名（spec §3）。 */
export const DELIVERABLE_DIR = '交付物';

/** `ctx.fs.listDir` 的子项形状里本模块用到的部分。 */
export interface StoreDirEntry {
  readonly name: string;
  readonly type: 'file' | 'directory' | 'other';
  readonly target: unknown;
}

/** 本模块用到的 `ctx.fs` 那一小块；写成结构类型便于直测。 */
export interface StoreFs {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<unknown>;
  writeText(target: unknown, content: string): Promise<unknown>;
  /** 列目录的直接子项（稳定名称序），每个子项带已解析的 target 与类型。 */
  listDir(target: unknown, signal?: AbortSignal): Promise<readonly StoreDirEntry[]>;
  /** 读整个文本文件。 */
  readText(target: unknown, signal?: AbortSignal): Promise<string>;
  /** 一个已解析 target 在**执行世界**里的绝对路径。 */
  processPath(target: unknown): string;
}

/**
 * 交付物目录在 `cwd` 之下的**相对**位置。
 *
 * 写盘时把它交给 `ctx.fs.resolve(path, { cwd })` 去拼，而不是自己 `join(cwd, …)` 拼好再交上去：
 * 拼好的串里已经含 `cwd`，相对 `cwd` 再拼一次会叠成 `<cwd>/<cwd>/交付物/…`。拼接只在这一处。
 */
function deliverableSubPathOf(slug: string): string {
  return join(DELIVERABLE_DIR, slug);
}

/** 一份交付物在磁盘上的位置。**纯字符串**，不碰盘。 */
export function deliverableDirOf(cwd: string, slug: string): string {
  return join(cwd, deliverableSubPathOf(slug));
}

/** 两空格缩进、UTF-8、结尾不加换行 —— 人直接打得开。 */
function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** 落一份交付物，返回它的目录在**执行世界**里的绝对路径。目录不存在时建出来。 */
export async function writeDeliverable(fs: StoreFs, cwd: string, documents: DeliverableDocuments): Promise<string> {
  const dir = await fs.resolve(deliverableSubPathOf(documents.slug), { cwd });
  const dirPath = fs.processPath(dir);
  // 建目录是 `ctx.fs` 唯一缺的能力（它没有 mkdir），只能走 node:fs；路径取 `processPath` 的结果，
  // 与下面的写盘同一个来源，避免"建的目录"和"写的文件"指着两个地方。
  await mkdir(dirPath, { recursive: true });
  // 正文先写、manifest 后写：manifest 是"这一份完整了"的提交标记 —— `listDeliverables` 正是
  // 以 manifest 为闸，先写它会让半份交付物被列出来（那份的 `current` 还指不到任何文件）。
  const current = documents.manifest.current;
  // 兜底：构造方（Task 1）总会把 `current` 设成正文的文件名，所以这条分支今天走不到。真要走到，
  // 落下的正文文件名与 manifest 记的 `current` 就对不上 —— 那是构造方的问题，不在这里补。
  const versionFile = typeof current === 'string' && current !== '' ? current : 'v1.json';
  await fs.writeText(await fs.resolve(versionFile, { cwd: dirPath }), serialize(documents.version));
  await fs.writeText(await fs.resolve('manifest.json', { cwd: dirPath }), serialize(documents.manifest));
  return dirPath;
}

/** 列举出来的一份（只读得懂的那几个字段；读不懂的一律跳过）。 */
export interface DeliverableEntry {
  /** 执行世界里的绝对路径。 */
  readonly path: string;
  readonly slug: string;
  readonly callId?: string;
  readonly subject?: string;
}

/**
 * 读一份 manifest。**形状不认识就给 `undefined`** —— 与 `scheme-view.ts` 同一条严格度：
 * 还没写出、正在被写（半份 JSON）、`format` 不对、主版本读不懂，都不算交付物。
 *
 * 还多一条**位置闸**：manifest 记的 `slug` 必须等于它所在目录的名字。列表报的 `slug` 来自
 * manifest、`path` 来自目录，两者不符时同一份交付物会以两个身份出现（目录名一个、manifest 一个），
 * 手改过的 manifest 还能顶着别人的 slug 冒名顶替。不符就整份不认。
 */
async function readManifest(fs: StoreFs, dir: StoreDirEntry): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await fs.readText(await fs.resolve('manifest.json', { cwd: fs.processPath(dir.target) }));
  } catch {
    return undefined;                      // 还没写出 / 不是文件：跳过
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;                      // 写到一半：跳过。下一次变化会自愈。
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.format !== DELIVERABLE_FORMAT) return undefined;
  // 主版本读不懂 ⇒ 整份不认（spec §3、§7）。只认 1。
  if (record.schemaVersion !== DELIVERABLE_SCHEMA_VERSION) return undefined;
  if (typeof record.slug !== 'string' || record.slug === '') return undefined;
  if (record.slug !== dir.name) return undefined;
  return record;
}

/** 列工作区里的全部交付物。目录不存在 ⇒ 空数组（spec §7：不报错、不白屏）。 */
export async function listDeliverables(fs: StoreFs, cwd: string): Promise<readonly DeliverableEntry[]> {
  let dirs: readonly StoreDirEntry[];
  try {
    dirs = await fs.listDir(await fs.resolve(DELIVERABLE_DIR, { cwd }));
  } catch {
    return [];                             // 没这个目录 / 不是目录 / 读不了：都当空
  }
  const out: DeliverableEntry[] = [];
  for (const dir of dirs) {                // `listDir` 已保证稳定名称序，这里不再自己排
    if (dir.type !== 'directory') continue; // 交付物一定是一个目录，不是目录的直接跳过
    const manifest = await readManifest(fs, dir);
    if (manifest === undefined) continue;
    out.push({
      path: fs.processPath(dir.target),
      slug: manifest.slug as string,
      ...(typeof manifest.callId === 'string' ? { callId: manifest.callId } : {}),
      ...(typeof manifest.subject === 'string' ? { subject: manifest.subject } : {}),
    });
  }
  return out;
}

/** 按 `callId` 反查路径。找不到（还没落盘 / 不是我们写的）给 `undefined`。 */
export async function resolveCallId(fs: StoreFs, cwd: string, callId: string): Promise<string | undefined> {
  if (callId === '') return undefined;
  const entries = await listDeliverables(fs, cwd);
  return entries.find((entry) => entry.callId === callId)?.path;
}
