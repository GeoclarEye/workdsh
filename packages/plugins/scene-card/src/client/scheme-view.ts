/**
 * 共享视图模型：`geoclar_recommend_schemes` 的出参 → 对话内的卡与右侧面板共用的读数。
 *
 * 这一层**只做"出参 → 视图模型"**：没有渲染、没有 IO、没有默认值编造。两个面读同一份
 * 出参、同一份视图模型，所以不可能互相矛盾（spec §4.4）。
 *
 * 唯一的回落判据在这里：**出参形状不认识就返回 `undefined`**，调用方据此交给官方通用
 * 卡片 —— 绝不渲染半张卡（spec §6 的硬要求）。因此本函数对每个**要显示的**读数都做形状
 * 检查，任何一个缺失都让整份回落；对**不显示的**字段一律不读（见下方"刻意不读"）。
 *
 * 严格度的分界只有一条：**缺 → 少一块，有但读不懂 → 整份回落**
 * （`mode` 属于后者：它是"哪条路"的判据，读不懂就无从决定画几列）。
 * 可选面（`pool`、旧后端没有的 `scenes`）缺席时优雅降级；但键在那儿而内容读不懂，
 * 说明后端在讲一件我不认识的事 —— 那种情况下少画一块就是撒谎，宁可回去画通用卡片。
 */

/** 每套方案最多留 20 条景摘要 —— 与检索工具的 `MAX_SCENES` 同一口径（spec §3.3）。 */
export const MAX_SCENE_SUMMARIES = 20;

/**
 * 一张方案在对话里/面板上要显示的全部读数。字段名与出参同名，不做重命名 ——
 * 读代码的人不必在两套词之间翻译。
 */
export interface SchemeView {
  /** 后端给这套方案的身份：`CUSTOM` / `CHEAPEST` / `SHARPEST` / `LATEST`。 */
  readonly key: string;
  readonly sceneCount: number;
  readonly coveragePercent: number;
  readonly uncoveredAreaKm2: number;
  readonly dateFrom: string;
  readonly dateTo: string;
  readonly gsdMin: number;
  readonly gsdMax: number;
  readonly cloudCoverMax: number;
  readonly cloudCoverMean: number;
  /** `lowerBound` 为真时金额是下界（出参 `pricingComplete === false`），UI 上表现为前缀「≥」。 */
  readonly amount: { readonly value: number; readonly lowerBound: boolean };
  /** 受限的是预算而不是条件；下一步据此给「按预算只看盖到多少」。 */
  readonly budgetCapped: boolean;
  /** 受预算限制时"盖满要多少钱"；后端没算出来时为 `null`。 */
  readonly budgetFullCoverageAmount: number | null;
  /** 最多 20 条景摘要，四键与检索工具同形；旧后端没有这个键时为**空数组**而不是报错。 */
  readonly scenes: readonly SceneSummary[];
}

/** 与 `geoclar_search_scenes` 返回的景摘要**同形**：助手不必学两套读法（spec §3.3）。 */
export interface SceneSummary {
  readonly id: string;
  readonly acquiredAt: string;
  readonly cloud: string;
  readonly resolution: number;
}

/** 池诊断：只在卡/面板底部印成一行，所以只读要印的那几个数。 */
export interface PoolView {
  readonly candidateCount: number;
  readonly usableCount: number;
  /** 被条件链筛掉的条数（不对应单个条件，所以文案是"被其他条件筛掉"）。 */
  readonly skippedByFilter: number;
  /** 没有可用轮廓、进不了任何方案的条数。 */
  readonly skippedNoGeometry: number;
  /** 池在上限处截断：取到的可能不全。 */
  readonly atLimit: boolean;
}

/**
 * 「下一步」**由出参驱动，不编剧本**（spec §4.4）：三分支按顺序取第一个成立的，
 * 三个都不成立就**没有**下一步 —— 那时不显示整块，而不是补一句套话。
 */
export type NextAction =
  /** 放宽条件就能盖满（出参 `relaxation`）；对话内的卡会把它印成一行建议。 */
  | { readonly kind: 'relax'; readonly value: number }
  /**
   * 池已达上限、可能没取全 ⇒ 收窄范围重算。
   * **本面的卡不消费这个分支**，它是给右侧面板页脚的「下一步」按钮用的（Task 4）——
   * 卡上不该出现"点一下就能收窄"的假按钮，所以这里留着备面板取用，不是死代码。
   */
  | { readonly kind: 'narrow' }
  /** 预算把方案截断了；`fullCoverageAmount` 是"盖满要多少钱"（后端没算时为 `null`）。同上：面板消费。 */
  | { readonly kind: 'budget'; readonly fullCoverageAmount: number | null };

/** 两个面共用的交付物读数。 */
export interface DeliverableView {
  /** 出参里原样顺序的方案（`presets` 时是 12 套，卡片只画主推的那一套）。 */
  readonly schemes: readonly SchemeView[];
  /**
   * 主推那一套：`CUSTOM`（精算）优先，其次 `VALUE`（性价比，预设里的默认推荐），
   * 都没有就取第一套。与 `schemes` 里是**同一个对象**。
   *
   * **没有一套方案时（`schemes: []`，条件筛完池为空）这里是 `undefined`** ——
   * 那是合法形状、不是读不懂，但"没有可比较的方案"就没有这张卡要讲的事：
   * 调用方（卡、Task 4 的自动弹）据此 `return null` / 不弹，回落官方通用卡片。
   */
  readonly primary?: SchemeView;
  /**
   * 后端走的是**不带条件**那条路（`mode=presets`，回 12 套预设）。
   *
   * 这是"要不要并排画"的判据，不是版式偏好：12 套预设是一张**菜单**，
   * 用户在对话里想看的是"先给我一套"，而不是一张 12 列的表（技能第三节同口径）。
   */
  readonly presets: boolean;
  /** 池诊断；出参没给或给不全时为 `undefined`，卡照样画得出来。 */
  readonly pool?: PoolView;
  /** 出参里没有下一步的读数时为 `undefined`。 */
  readonly next?: NextAction;
}

/**
 * 视图模型的输入：toolview 交来的**阶段**加**已解析的出参**。
 *
 * 为什么不是整块 `ToolResultNode`：结果 JSON 是 `block.content` 里的一段文本，解析它是
 * 视图的活（读数从文本变对象）。所以卡先 `{ phase: props.phase, result: JSON.parse(text) }`，
 * 再把这一对交给本函数 —— 于是这一层保持纯粹、可直测，不必伪造一棵会话时间线。
 *
 * 两个字段都是 `unknown`：**输入是运行时数据，形状没有保证**，这正是本函数存在的理由。
 */
export interface DeliverableInput {
  readonly phase?: unknown;
  readonly result?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readText(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

/** 四键景摘要；多一个键都不要（"与检索工具同形"是给助手的读法约定，不是可选项）。 */
function readScene(raw: unknown): SceneSummary | undefined {
  if (!isRecord(raw)) return undefined;
  const id = readText(raw, 'id');
  const acquiredAt = readText(raw, 'acquiredAt');
  const cloud = readText(raw, 'cloud');
  const resolution = readNumber(raw, 'resolution');
  if (id === undefined || acquiredAt === undefined || cloud === undefined || resolution === undefined) {
    return undefined;
  }
  return { id, acquiredAt, cloud, resolution };
}

/**
 * 一套方案 → 一套读数；**任何一个要显示的读数缺失就返回 `undefined`**，
 * 由调用方把整份判成"不认识"（宁可不画，也不画一张写着 `undefined` 的表）。
 */
function readScheme(raw: unknown): SchemeView | undefined {
  if (!isRecord(raw)) return undefined;
  const key = readText(raw, 'key');
  const sceneCount = readNumber(raw, 'sceneCount');
  const coveragePercent = readNumber(raw, 'coveragePercent');
  const uncoveredAreaKm2 = readNumber(raw, 'uncoveredAreaKm2');
  const estimatedAmount = readNumber(raw, 'estimatedAmount');
  const pricingComplete = readBoolean(raw, 'pricingComplete');
  const budgetCapped = readBoolean(raw, 'budgetCapped');
  const dateFrom = readText(raw, 'dateFrom');
  const dateTo = readText(raw, 'dateTo');
  const gsdMin = readNumber(raw, 'gsdMin');
  const gsdMax = readNumber(raw, 'gsdMax');
  const cloudCoverMax = readNumber(raw, 'cloudCoverMax');
  const cloudCoverMean = readNumber(raw, 'cloudCoverMean');
  if (key === undefined || sceneCount === undefined || coveragePercent === undefined
    || uncoveredAreaKm2 === undefined || estimatedAmount === undefined || pricingComplete === undefined
    || budgetCapped === undefined || dateFrom === undefined || dateTo === undefined
    || gsdMin === undefined || gsdMax === undefined || cloudCoverMax === undefined
    || cloudCoverMean === undefined) {
    return undefined;
  }
  // 旧后端没有 scenes：空清单，不报错（新卡装在老后端前只是少一列景）。
  const rawScenes = raw.scenes;
  const scenes: SceneSummary[] = [];
  if (rawScenes !== undefined) {
    if (!Array.isArray(rawScenes)) return undefined;
    for (const entry of rawScenes.slice(0, MAX_SCENE_SUMMARIES)) {
      const scene = readScene(entry);
      if (scene === undefined) return undefined;
      scenes.push(scene);
    }
  }
  const budgetFullCoverageAmount = raw.budgetFullCoverageAmount;
  return {
    key,
    sceneCount,
    coveragePercent,
    uncoveredAreaKm2,
    dateFrom,
    dateTo,
    gsdMin,
    gsdMax,
    cloudCoverMax,
    cloudCoverMean,
    // 下界是**金额的属性**，不是显示层的前缀：前缀由 UI 加，判据在这里。
    amount: { value: estimatedAmount, lowerBound: pricingComplete === false },
    budgetCapped,
    budgetFullCoverageAmount:
      typeof budgetFullCoverageAmount === 'number' && Number.isFinite(budgetFullCoverageAmount)
        ? budgetFullCoverageAmount
        : null,
    scenes,
  };
}

/**
 * 池诊断。`atLimit` 来自出参**顶层**的 `poolAtLimit`（不在 `pool` 里）—— 那个 `true`
 * 还是"收窄范围重算"这一分支的判据，所以它在两个地方是同一件事的两种说法。
 */
function readPool(raw: unknown, atLimit: boolean): PoolView | undefined {
  if (!isRecord(raw)) return undefined;
  const candidateCount = readNumber(raw, 'candidateCount');
  const usableCount = readNumber(raw, 'usableCount');
  const skippedByFilter = readNumber(raw, 'skippedByFilter');
  const skippedNoGeometry = readNumber(raw, 'skippedNoGeometry');
  if (candidateCount === undefined || usableCount === undefined
    || skippedByFilter === undefined || skippedNoGeometry === undefined) {
    return undefined;
  }
  return { candidateCount, usableCount, skippedByFilter, skippedNoGeometry, atLimit };
}

export function buildDeliverableView(input: DeliverableInput | undefined): DeliverableView | undefined {
  if (!isRecord(input)) return undefined;
  // 只有 result 阶段有出参；preparing / start 阶段没有可画的东西。
  if (input.phase !== 'result') return undefined;
  const payload = input.result;
  if (!isRecord(payload)) return undefined;
  const rawSchemes = payload.schemes;
  if (!Array.isArray(rawSchemes)) return undefined;
  // 后端只发这两个值（`RecommendTools`：`custom ? MODE_CUSTOM : MODE_PRESETS`）。
  // 读不懂它是哪条路 ⇒ 这份出参不是我以为的形状 ⇒ 整份回落，而不是挑一种猜着画。
  const mode = payload.mode;
  if (mode !== 'custom' && mode !== 'presets') return undefined;

  const schemes: SchemeView[] = [];
  for (const raw of rawSchemes) {
    const scheme = readScheme(raw);
    if (scheme === undefined) return undefined;
    schemes.push(scheme);
  }

  const primary = schemes.find((scheme) => scheme.key === 'CUSTOM')
    ?? schemes.find((scheme) => scheme.key === 'VALUE')
    ?? schemes[0];
  const pool = readPool(payload.pool, payload.poolAtLimit === true);
  return {
    schemes,
    primary,
    presets: mode === 'presets',
    pool,
    next: nextAction(payload, primary, pool),
  };
}

/**
 * 三分支的**顺序**是设计的一部分（spec §4.4）：放宽建议是最具体的行动，
 * 它成立时不该被"池到顶了"盖掉；预算受限只在这两条都不成立时才是答案。
 */
function nextAction(
  payload: Record<string, unknown>,
  primary: SchemeView | undefined,
  pool: PoolView | undefined,
): NextAction | undefined {
  const relaxation = payload.relaxation;
  if (isRecord(relaxation)) {
    const value = readNumber(relaxation, 'value');
    if (value !== undefined) return { kind: 'relax', value };
  }
  if (pool?.atLimit === true) return { kind: 'narrow' };
  if (primary?.budgetCapped === true) {
    return { kind: 'budget', fullCoverageAmount: primary.budgetFullCoverageAmount };
  }
  return undefined;
}

/**
 * 刻意**不读**的字段：`uncoveredWkt` / `billingAreaKm2` / `aoiOverlapAreaKm2` /
 * `imageOverlapAreaKm2`。服务层有意不导出它们，所以任何引用都会在真机上取到 `undefined`
 * 而静默退化 —— 与其在这里留个看起来能用的读法，不如让它读不到。
 */
