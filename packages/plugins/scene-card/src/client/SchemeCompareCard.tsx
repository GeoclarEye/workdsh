/**
 * 对话内的方案对比卡（spec §4.3）——`tool.call.toolview` 上按 wire 工具名键控的那一个视图。
 *
 * 两条规矩：
 *   1. **不认识的形状 ⇒ `return null`**，交给官方通用卡片。绝不渲染半张卡（spec §6）。
 *   2. **卡底固定「查看详情」**：面板是按调用的活状态，几天后早换成了别的东西，
 *      所以历史那一件只能从它自己那张卡回去（spec §4.3）。
 *
 * 版式基准：评审稿（mockup）左半边。四列并排（`CUSTOM` + 三套同池对照）、金额最响、
 * 覆盖率「条＋数字」。**琥珀只有两种情形**：金额下界（`pricingComplete === false`）与
 * `budgetCapped === true`；覆盖率**不用**琥珀（盖不满是常态，全标黄等于没有信号）。
 * 方案网格由 {@link SCHEME_METRICS} 定义，右侧面板复用同一份 —— 两个面不会各自把同一份出参读成两个样子。
 */
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { buildDeliverableView, isRecord } from './scheme-view.js';
import type { DeliverableView, SchemeView } from './scheme-view.js';
import { schemeCardCss } from './styles.js';

/**
 * 注意 props 用的是**全阶段**的 `ToolCallViewProps` 而不是 `StartedToolCallViewProps`：
 * 注册点的组件契约按全阶段校验（preparing 也会被派发到这个 key），
 * 少一个阶段的成员就过不了注册的类型检查 —— 官方那几行也是这么写的。
 * 因此读结果时按形状读（{@link parseResult}），不按类型断言。
 */

/**
 * 后端方案 key → 人话（对照技能第三节那张表；后端刻意只出码）。
 * 不认识的 key 一律原样显示：编一个名字比显示 `FOO` 更糟。
 * `CUSTOM` 在门户上叫「推荐方案」，卡上叫「你的条件」—— 列名要与用户的条件对应。
 */
const SCHEME_LABELS: Record<string, string> = {
  CUSTOM: '你的条件',
  VALUE: '性价比', CONSISTENT: '同期一致',
  LATEST: '时相最新', SHARPEST: '最清晰', CLEAREST: '云量最低', CHEAPEST: '最省',
  SHARP_CLEAN: '清晰 · 兼顾干净', CLEAN_SHARP: '干净 · 兼顾清晰',
  RECENT_SHARP: '近期 · 兼顾清晰', RECENT_CLEAN: '近期 · 兼顾干净',
  CLEAN_CHEAP: '干净 · 兼顾省钱', SHARP_CHEAP: '清晰 · 兼顾省钱',
};

/** 方案 key → 列名；面板也用这一个（两个面不能各叫各的）。 */
export const label = (key: string): string => SCHEME_LABELS[key] ?? key;

/** 千分位；金额与面积共用（两者都动辄百万/万级，不分组读不出来）。 */
const grouped = (value: number): string => Math.round(value).toLocaleString('en-US');

/**
 * 金额：整元显示（评审稿如此）。**下界向下取整**：`≥` 说的是"不少于"，
 * 四舍五入会把下界说大一点 —— 那是唯一一种把不确定性说成确定性的方向。
 */
function amountText(amount: SchemeView['amount']): ReactNode {
  const yuan = amount.lowerBound ? Math.floor(amount.value) : Math.round(amount.value);
  return (
    <>
      {amount.lowerBound ? <span className="wd-sc-loose">≥</span> : null}
      ¥{yuan.toLocaleString('en-US')}
    </>
  );
}

/** 整数不带小数点、其余一位小数：`33.0 → 33`、`1.33 → 1.3`。 */
const trimmed = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1));

/** 时相只到月：`2024-12-06 → 2024-12`，与评审稿一致 —— 到日会挤成两行。 */
const month = (date: string): string => date.slice(0, 7);

/**
 * 方案网格的一行。卡把它排成"方案列 × 指标行"，面板把它排成"这一套的指标列表" ——
 * 两处读同一份出参、同一个函数，读者看到的数不会不一样。
 */
export interface SchemeMetric {
  /** 行的身份（`key` 与面板的用例用它）。 */
  readonly id: string;
  readonly label: string;
  readonly read: (scheme: SchemeView) => ReactNode;
  /**
   * 整行的语气。目前只有金额那一行用：`budgetCapped === true` ⇒ 琥珀
   * （预算把这个数截断了，所以它不能直接当结论用）。覆盖率那一行**没有** `tone`。
   */
  readonly tone?: (scheme: SchemeView) => 'warn' | undefined;
  /**
   * 面板竖排时这一行**置顶并放大**（评审稿：金额在右侧面板里是最响的那一格）。
   * 卡里四列并排时不生效 —— 并排时"最响"由主推那一列的底色与列头承担。
   */
  readonly panelLeading?: boolean;
}

export const SCHEME_METRICS: readonly SchemeMetric[] = [
  {
    id: 'coverage',
    label: '覆盖率',
    // 覆盖率**不上琥珀**：盖不满是常态，全标黄等于没有信号。高低由数字和「未覆盖」那一行说。
    read: (scheme) => (
      <span className="wd-sc-cover">
        <span className="wd-sc-bar"><i style={{ width: `${Math.max(0, Math.min(100, scheme.coveragePercent))}%` }} /></span>
        <span className="wd-sc-n">{scheme.coveragePercent.toFixed(1)}<span className="wd-sc-u">%</span></span>
      </span>
    ),
  },
  {
    id: 'scenes',
    label: '景数',
    read: (scheme) => <>{grouped(scheme.sceneCount)}<span className="wd-sc-u">景</span></>,
  },
  {
    id: 'period',
    label: '时相',
    read: (scheme) => <>{month(scheme.dateFrom)} → {month(scheme.dateTo)}</>,
  },
  {
    id: 'resolution',
    label: '分辨率',
    read: (scheme) => <>{scheme.gsdMin.toFixed(2)} – {scheme.gsdMax.toFixed(2)}<span className="wd-sc-u">m</span></>,
  },
  {
    id: 'cloud',
    label: '云量',
    read: (scheme) => <>最高 {trimmed(scheme.cloudCoverMax)} · 均 {trimmed(scheme.cloudCoverMean)}<span className="wd-sc-u">%</span></>,
  },
  {
    id: 'uncovered',
    label: '未覆盖',
    read: (scheme) => <>{grouped(scheme.uncoveredAreaKm2)}<span className="wd-sc-u">km²</span></>,
  },
  {
    id: 'amount',
    label: '金额',
    // 琥珀只留给"这个数不能直接当结论用"：预算把方案截断了。金额下界（≥）自己带琥珀。
    tone: (scheme) => (scheme.budgetCapped ? 'warn' : undefined),
    read: (scheme) => amountText(scheme.amount),
    // 面板竖排时置顶放大（评审稿右半边）；卡里四列并排时不动。
    panelLeading: true,
  },
];

/**
 * 结果块里**唯一那段文本**的 JSON —— 与官方卡片同一读法（`singleResultText` 的口径）：
 * 多段内容就当作读不懂，宁可回落，不去猜哪一段是出参。
 *
 * 收 `unknown` 是因为两个面各交各的：卡交 `props.block`，面板交它从对话节点里
 * 取到的那件结果 —— 形状都不由我们保证。
 */
function parseResult(block: unknown): unknown {
  if (!isRecord(block)) return undefined;
  const content = block.content;
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const only = content[0];
  if (!isRecord(only) || only.type !== 'text' || typeof only.text !== 'string') return undefined;
  try {
    return JSON.parse(only.text);
  } catch {
    return undefined;
  }
}

/**
 * 一件工具结果 → 交付物读数。**两个面共用这一个入口**：卡据此决定画不画，
 * 面板据此画方案那一块（Task 4）。
 */
export function deliverableViewOfResultBlock(block: unknown): DeliverableView | undefined {
  return buildDeliverableView({ phase: 'result', result: parseResult(block) });
}

/** 卡这一侧：只有 result 阶段有出参（preparing / start 没有可画的东西）。 */
export function deliverableViewOf(props: ToolCallViewProps): DeliverableView | undefined {
  if (props.phase !== 'result') return undefined;
  return deliverableViewOfResultBlock(props.block);
}

/**
 * 卡与面板共用的方案网格：一行一个指标、一列一套方案（面板把同一份读数排成竖排，见
 * {@link SchemeMetrics}）。画哪几套由调用方给 —— 卡在 `presets` 时只画主推那一套。
 */
export function SchemeTable({ schemes, primary }: {
  readonly schemes: readonly SchemeView[];
  readonly primary: SchemeView | undefined;
}): ReactNode {
  return (
    /*
     * 外面这层只为**兜底**：容器放不下四列时横向滚动，而不是让表格溢出卡外
     * （溢出 = 数据被裁掉且没有任何提示，那是最差的结果）。
     * 与"预设态去掉滚动"不是一回事：presets 是**减少列数**（12 → 1），列少了自然不需要滚；
     * custom 是**列数固定为 4**，只有真的放不下时才滚 —— 放得下时它不出现。
     */
    <div className="wd-sc-table-wrap">
      <table className="wd-sc-table">
        <thead>
          <tr>
            {/* 左上角空着：评审稿如此，指标名在每行第一个格子里。 */}
            <th className="wd-sc-col-metric" scope="col" />
            {schemes.map((scheme) => (
              <th key={scheme.key} scope="col" className={scheme === primary ? 'wd-sc-col is-primary' : 'wd-sc-col'}>
                <span className="wd-sc-name">{label(scheme.key)}</span>
                {/* 对照套标"对照"；主推那列的条件由入参得来，出参里没有，所以不编一个。 */}
                {scheme === primary ? null : <span className="wd-sc-tag">对照</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SCHEME_METRICS.map((metric) => (
            <tr key={metric.id}>
              <td className="wd-sc-metric">{metric.label}</td>
              {schemes.map((scheme) => {
                const classes = ['wd-sc-val'];
                if (scheme === primary) classes.push('is-primary');
                if (metric.tone?.(scheme) === 'warn') classes.push('is-warn');
                return <td key={`${metric.id}:${scheme.key}`} className={classes.join(' ')}>{metric.read(scheme)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 预设菜单的提示行：12 套里画了一套，另 11 套不铺开。
 *
 * 这是**界面文案**，不是助手该说的话 —— 技能里不写卡片规则（spec §4.6），
 * 这里只是把"还能怎么用"说给看得见这张卡的人。
 */
function PresetHint({ total }: { readonly total: number }): ReactNode {
  return (
    <div className="wd-sc-more">
      还有 {total - 1} 套预设没列出 · 说一个偏好（更省 / 更清晰 / 云更少），
      我就按它精算一套，并附同池对照
    </div>
  );
}

/** 池诊断 + "还没取全"那半句。出参没给池读数时整行不出现。 */
function PoolLine({ pool }: { readonly pool: NonNullable<DeliverableView['pool']> }): ReactNode {
  return (
    <div className="wd-sc-pool">
      候选 {grouped(pool.candidateCount)} 景 · 可用 {grouped(pool.usableCount)} 景
      {' · '}被其他条件筛掉 {grouped(pool.skippedByFilter)} · 无轮廓 {grouped(pool.skippedNoGeometry)}
      {pool.atLimit ? <span className="wd-sc-limit">候选池已达上限，可能没取全</span> : null}
    </div>
  );
}

/**
 * 面板用的同一份读数：一套方案、一行一个指标（376px 塞不下并排，见评审稿的注）。
 *
 * **与卡共用 `SCHEME_METRICS`**：同一份出参、同一个读法，两个面不可能把同一个数读成两个样子。
 * 唯一的差别是排法 —— 面板竖排，把标了 `panelLeading` 的那一行（金额）提到最上面并放大。
 */
export function SchemeMetrics({ scheme }: { readonly scheme: SchemeView }): ReactNode {
  const rows = [...SCHEME_METRICS.filter((metric) => metric.panelLeading === true),
    ...SCHEME_METRICS.filter((metric) => metric.panelLeading !== true)];
  return (
    <dl className="wd-sc-metrics">
      {rows.map((metric) => {
        const classes = ['wd-sc-row'];
        if (metric.tone?.(scheme) === 'warn') classes.push('is-warn');
        if (metric.panelLeading === true) classes.push('is-leading');
        return (
          <div key={metric.id} className={classes.join(' ')}>
            <dt>{metric.label}</dt>
            <dd>{metric.read(scheme)}</dd>
          </div>
        );
      })}
    </dl>
  );
}

/** 卡这一侧从注册点拿到的注入面（`client.tsx` 给出）。 */
export interface SchemeCompareCardInjected {
  /** 历史可达性：把面板重绑到**这张卡的**那一次调用（spec §4.3）。 */
  readonly openDeliverable: (callId: string) => void;
  /**
   * 受控自动弹（spec §4.5）；返回是否真的弹了。判据是"该不该调用 `openTabIn`"，
   * 实现与判据都在 `client.tsx` / `auto-open.ts`，这里只负责在出结果时问一次。
   */
  readonly autoOpenDeliverable: (callId: string, hasDeliverable: boolean) => boolean;
}

/** 对话内的卡。 */
export function SchemeCompareCard(
  props: ToolCallViewProps & SchemeCompareCardInjected,
): ReactNode {
  const view = deliverableViewOf(props);
  // 认不出形状、或**一套方案都没有** ⇒ 回落官方通用卡片（这就是回落判据的落点）。
  const hasDeliverable = view !== undefined && view.primary !== undefined;
  const autoOpen = props.autoOpenDeliverable;
  const { callId, phase } = props;
  // 出结果时问一次"要不要把面板弹开"。放在早退之前：hook 的调用次序不能随出参形状变。
  // 重复执行是安全的 —— 真弹过的那个轮次会记在 `openedTurns` 里，第二次就否了。
  useEffect(() => {
    if (phase !== 'result') return;
    autoOpen(callId, hasDeliverable);
  }, [autoOpen, callId, phase, hasDeliverable]);
  if (!hasDeliverable) return null;
  // 不带条件时后端回 12 套预设：那是菜单，不是结论。只画主推那一套，其余用一行话说清去处。
  const columns = view.presets ? [view.primary] : view.schemes;
  const relax = view.next?.kind === 'relax' ? view.next : undefined;
  const notes = view.presets || view.pool !== undefined || relax !== undefined;
  return (
    <section className="wd-sc">
      <style>{schemeCardCss}</style>
      <div className="wd-sc-head">
        <h2>选景方案</h2>
        <span className="wd-sc-sub">
          {view.presets ? '没给条件，先给一套预设' : '按你给的条件算出来，并附同池对照'}
        </span>
        <span className="wd-sc-spacer" />
        <span className="wd-sc-amount">
          <span className="wd-sc-amount-k"><b>{label(view.primary.key)}</b> · 预估金额</span>
          <span className="wd-sc-amount-v">{amountText(view.primary.amount)}</span>
        </span>
      </div>
      <SchemeTable schemes={columns} primary={view.primary} />
      {notes ? (
        <div className="wd-sc-cfoot">
          {view.presets && view.schemes.length > 1 ? <PresetHint total={view.schemes.length} /> : null}
          {view.pool ? <PoolLine pool={view.pool} /> : null}
          {relax ? <p className="wd-sc-relax">放宽到 {trimmed(relax.value)}% 即可盖满</p> : null}
        </div>
      ) : null}
      <div className="wd-sc-actions">
        <button type="button" onClick={() => { props.openDeliverable(props.callId); }}>查看详情</button>
        <span className="wd-sc-why">在右侧「交付物」里看这次检索的步骤与完整方案</span>
      </div>
    </section>
  );
}
