/**
 * 一次工具调用 → 一份交付物的**内容**（`manifest.json` + `v< N >.json`）。纯函数，不碰 IO。
 *
 * 三条硬规矩直接来自 spec §3：
 *   · `format` 不对 ⇒ 不是交付物，一个字节都不碰；
 *   · `type` 不认识 / 形状读不懂 ⇒ **整份不写**，绝不写半份；
 *   · `payload` 逐字来自出参、`intent` 逐字来自入参 —— 生产者**不重命名、不补齐**。
 *
 * 与 `scheme-view.ts` 同一套严格度：缺 → 少一块，有但读不懂 → 整份不画。
 */

export interface DeliverableDocuments {
  /** 目录名：`<时间戳>-<短标题>`。 */
  readonly slug: string;
  readonly manifest: Record<string, unknown>;
  readonly version: Record<string, unknown>;
}

export interface BuildInput {
  /** 产出它的那次工具调用（记进 manifest 作溯源，客户端靠它反查路径）。 */
  readonly callId: string;
  readonly toolName: string;
  /** `tool/call` 的 arguments，**已解析**（解析失败时调用方给 `undefined`）。 */
  readonly args: unknown;
  /** `tool/result` 里那段 JSON，**已解析**。 */
  readonly result: unknown;
  /** 该轮用户消息（生产者从 `user/message` 事件记下的）；空串表示拿不到。 */
  readonly subject: string;
  readonly at: Date;
}

/** 本格式的标识；与专家包的 `workdsh-expert` 同构。 */
export const DELIVERABLE_FORMAT = 'workdsh-deliverable';
/** 格式主版本（spec §3：读不懂主版本 ⇒ 整份不画）。 */
export const DELIVERABLE_SCHEMA_VERSION = 1;
/** `type` → 渲染器。本期只有一个。 */
const TYPE_SCENE_SCHEMES = 'scene-schemes';

/**
 * `intent.conditions` 的键 —— **与工具 `arguments` 逐字对应**（spec §3）。
 *
 * 这里刻意用一张表而不是遍历 `args`：多抄一个键就是把不属于意图的东西写进凭据，
 * 而凭据是给下游当输入用的。表外的键一律不写。
 */
const CONDITION_KEYS = ['maxCloud', 'maxGsd', 'budget', 'dateFrom', 'dateTo',
  'datasetIds', 'offNadirMax', 'preferConsistent'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 线格式 `mcp__<连接器 serverName>__<工具名>` → 裸工具名；不匹配则原样返回。
 *
 * **导出**：生产者要按裸名认"是不是那次工具返回"（`deliverable-producer.ts`）—— 连接器是可改配置的，
 * 按线名认会随改名静默失效。剥前缀这件事只留这一份。
 */
export function bareToolName(toolName: string): string {
  const parts = toolName.split('__');
  return parts.length >= 3 && parts[0] === 'mcp' ? parts.slice(2).join('__') : toolName;
}

/**
 * `20261013-045800` —— **UTC** 的 `YYYYMMDD-HHmmss`，用作目录名前缀。
 *
 * 用 UTC 而**不是**本地时间，三条理由：
 *   1. `manifest.versions[].at` 存的就是 `toISOString()`（UTC）——同一份 manifest 里两个时间
 *      不该一个 UTC 一个本地；
 *   2. 生产者在部署实例的容器里跑，**容器时区不该改变目录名**（否则本地跑与线上跑产出不同名）；
 *   3. 定长的字典序仍等于时间序，这是前缀的用途。
 *
 * 形状与 spec §3 的目录示例一致（`20261013-125800-hormuz-3mo`）。
 */
function stamp(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}`
    + `-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
}

/**
 * 目录名：时间戳 + 短标题。保留中日韩与字母数字，其余压成**单个**连字符（连续分隔符只出一个），
 * 整体截断到 64 个码点。没有可用标题时**只有时间戳** —— 不编一句话。
 *
 * 截断按**码点**数，不是 UTF-16 码元：扩展 B 区及以上的汉字是代理对，按码元切会把一个字
 * 劈成两半、留下落单的代理项 —— `manifest.slug` 记着它，落盘时却被编码成 U+FFFD，于是
 * "身份 = slug + 路径"两边对不上（T2 的存储层正是先按 slug 建目录、再报 manifest 里的 slug）。
 */
export function slugOf(subject: string, at: Date): string {
  const prefix = stamp(at);
  const body = subject
    .replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  if (body === '') return prefix;
  const room = 64 - prefix.length - 1;
  return `${prefix}-${Array.from(body).slice(0, room).join('')}`;
}

/** 出参形状闸：这一层只认它要显示的那些读数，读不懂就整份放弃。 */
function resultIsRenderable(result: unknown): result is Record<string, unknown> {
  if (!isRecord(result)) return false;
  if (result.mode !== 'custom' && result.mode !== 'presets') return false;
  if (!Array.isArray(result.schemes)) return false;
  if (result.schemes.length === 0) return false;
  return result.schemes.every((scheme) => isRecord(scheme) && typeof scheme.key === 'string');
}

/** 入参 → `intent.conditions`：只抄表内的键，未给的不出现。 */
function conditionsOf(args: unknown): Record<string, unknown> {
  if (!isRecord(args)) return {};
  const out: Record<string, unknown> = {};
  for (const key of CONDITION_KEYS) {
    const value = args[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

/** 主推那一套（`CUSTOM` 优先，其次 `VALUE`，再次第一套）—— 与 `scheme-view.ts` 同一口径。 */
function primaryOf(result: Record<string, unknown>): Record<string, unknown> | undefined {
  const schemes = result.schemes as Record<string, unknown>[];
  return schemes.find((scheme) => scheme.key === 'CUSTOM')
    ?? schemes.find((scheme) => scheme.key === 'VALUE')
    ?? schemes[0];
}

/**
 * 写给人看的一句话（spec §3：列表页与面板顶部用，不必读整份 payload）。
 *
 * 出参里**没有** `summary` 字段（已核 `RecommendTools` 的 `out.put` 无此项），所以这句由生产者
 * **派生**，口径照 spec §3 给的那句示例：条件口径（云量，来自**入参**）+ 主推那套的覆盖率与金额
 * （来自**出参**）。缺哪个数就省哪个分句；一个都缺就写空串 —— 不编一句套话。
 */
function summaryOf(result: Record<string, unknown>, args: unknown): string {
  const primary = primaryOf(result);
  const clauses: string[] = [];
  const maxCloud = isRecord(args) ? args.maxCloud : undefined;
  if (typeof maxCloud === 'number' && Number.isFinite(maxCloud)) {
    clauses.push(`在云量 ≤ ${maxCloud}% 的口径下`);
  }
  const coverage = primary?.coveragePercent;
  if (typeof coverage === 'number' && Number.isFinite(coverage)) clauses.push(`这套盖到 ${coverage}%`);
  const amount = primary?.estimatedAmount;
  if (typeof amount === 'number' && Number.isFinite(amount)) {
    clauses.push(`¥${Math.round(amount).toLocaleString('en-US')}`);
  }
  return clauses.length === 0 ? '' : `${clauses.join('，')}。`;
}

export function buildDeliverableDocuments(input: BuildInput): DeliverableDocuments | undefined {
  const { result } = input;
  // 形状读不懂 ⇒ 这次不落。**不抛**：生产者跑在会话事件流上，抛出去会污染别人的提交。
  if (!resultIsRenderable(result)) return undefined;
  const scheme = primaryOf(result)?.key;
  if (typeof scheme !== 'string') return undefined;

  const at = input.at;
  const iso = at.toISOString();
  const versionFile = 'v1.json';
  const summary = summaryOf(result, input.args);

  const version: Record<string, unknown> = {
    format: DELIVERABLE_FORMAT,
    type: TYPE_SCENE_SCHEMES,
    title: input.subject,
    summary,
    // 凭据半边：**怎么算出来的**。字段名与工具 arguments 逐字对应，不做重命名。
    intent: {
      tool: bareToolName(input.toolName),
      scheme,
      aoi: isRecord(input.args) ? input.args.wkt ?? null : null,
      conditions: conditionsOf(input.args),
    },
    // 展示半边：**算出了什么**。逐字来自出参。
    payload: result,
  };

  const manifest: Record<string, unknown> = {
    format: DELIVERABLE_FORMAT,
    schemaVersion: DELIVERABLE_SCHEMA_VERSION,
    slug: slugOf(input.subject, at),
    subject: input.subject,
    callId: input.callId,
    current: versionFile,
    versions: [{ file: versionFile, at: iso, note: '' }],
  };

  return { slug: manifest.slug as string, manifest, version };
}
