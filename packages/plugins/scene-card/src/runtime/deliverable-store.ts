/**
 * 交付物的**文件读写**：落一份、列一批、按 `callId` 反查路径。不构造内容、不判断业务。
 *
 * 为什么反查是**扫盘**而不是记账：spec §9 待定段定的就是这条 —— 答案从磁盘上的 manifest
 * 现扫得出，进程重启后照样答得出。这跟 §2 要退休的"内存绑定账"是两件事。
 *
 * `ctx.fs` 没有 mkdir，所以建目录走 `node:fs/promises`（先例：`projects/src/runtime/project-workspace.ts`）。
 */
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DELIVERABLE_FORMAT, DELIVERABLE_SCHEMA_VERSION, type DeliverableDocuments }
  from './deliverable-document.js';

/** 工作区根下的交付物目录名（spec §3）。 */
export const DELIVERABLE_DIR = '交付物';

/** 本模块用到的 `ctx.fs` 那一小块；写成结构类型便于直测。 */
export interface StoreFs {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<unknown>;
  writeText(target: unknown, content: string): Promise<unknown>;
}

/** 一份交付物在磁盘上的位置。**纯字符串**，不碰盘。 */
export function deliverableDirOf(cwd: string, slug: string): string {
  return join(cwd, DELIVERABLE_DIR, slug);
}

/** 两空格缩进、UTF-8、结尾不加换行 —— 人直接打得开。 */
function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** 落一份交付物，返回它的目录绝对路径。目录不存在时建出来。 */
export async function writeDeliverable(fs: StoreFs, cwd: string, documents: DeliverableDocuments): Promise<string> {
  const dir = deliverableDirOf(cwd, documents.slug);
  await mkdir(dir, { recursive: true });
  // 正文先写、manifest 后写：manifest 是"这一份完整了"的提交标记 —— `listDeliverables` 正是
  // 以 manifest 为闸，先写它会让半份交付物被列出来（那份的 `current` 还指不到任何文件）。
  const current = documents.manifest.current;
  const versionFile = typeof current === 'string' && current !== '' ? current : 'v1.json';
  const version = await fs.resolve(join(dir, versionFile), { cwd });
  await fs.writeText(version, serialize(documents.version));
  const manifest = await fs.resolve(join(dir, 'manifest.json'), { cwd });
  await fs.writeText(manifest, serialize(documents.manifest));
  return dir;
}

/** 列举出来的一份（只读得懂的那几个字段；读不懂的一律跳过）。 */
export interface DeliverableEntry {
  readonly path: string;
  readonly slug: string;
  readonly callId?: string;
  readonly subject?: string;
}

/**
 * 读一份 manifest。**形状不认识就给 `undefined`** —— 与 `scheme-view.ts` 同一条严格度：
 * 正在被写（半份 JSON）、`format` 不对、主版本读不懂，都不算交付物。
 */
async function readManifest(dir: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, 'manifest.json'), 'utf8');
  } catch {
    return undefined;                      // 还没写出 / 不是目录：跳过
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
  return record;
}

/** 列工作区里的全部交付物。目录不存在 ⇒ 空数组（spec §7：不报错、不白屏）。 */
export async function listDeliverables(fs: StoreFs, cwd: string): Promise<readonly DeliverableEntry[]> {
  const root = join(cwd, DELIVERABLE_DIR);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const out: DeliverableEntry[] = [];
  for (const name of names.sort()) {
    const dir = join(root, name);
    const manifest = await readManifest(dir);
    if (manifest === undefined) continue;
    out.push({
      path: dir,
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
