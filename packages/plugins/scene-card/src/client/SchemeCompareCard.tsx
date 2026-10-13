/**
 * 对话内的方案对比卡（spec §4.3）——`tool.call.toolview` 上按 wire 工具名键控的那一个视图。
 *
 * 两条规矩：
 *   1. **不认识的形状 ⇒ `return null`**，交给官方通用卡片。绝不渲染半张卡（spec §6）。
 *   2. **卡底固定「查看详情」**：面板是按调用的活状态，几天后早换成了别的东西，
 *      所以历史那一件只能从它自己那张卡回去（spec §4.3）。
 *
 * 版式基准：评审稿（mockup）左半边。三列并排、金额最响、覆盖率「条＋数字」、
 * 未盖满与金额下界用琥珀色。方案网格由 {@link SCHEME_METRICS} 定义，右侧面板复用同一份
 * —— 两个面不会各自把同一份出参读成两个样子。
 */
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client';
import type { ReactNode } from 'react';
import { buildDeliverableView } from './scheme-view.js';
import type { DeliverableView, SchemeView } from './scheme-view.js';
import { schemeCardCss } from './styles.js';

/**
 * 结果阶段交给视图的块；从槽位契约上取，免得再引一个包只为一个类型。
 *
 * 注意 props 用的是**全阶段**的 `ToolCallViewProps` 而不是 `StartedToolCallViewProps`：
 * 注册点的组件契约按全阶段校验（preparing 也会被派发到这个 key），
 * 少一个阶段的成员就过不了注册的类型检查 —— 官方那几行也是这么写的。
 */
type ResultBlock = Extract<ToolCallViewProps, { phase: 'result' }>['block'];

/** 后端方案 key → 人话。不认识的 key 一律原样显示：编一个名字比显示 `FOO` 更糟。 */
const SCHEME_LABELS: Record<string, string> = {
  CUSTOM: '你的条件', CHEAPEST: '最省', SHARPEST: '最清晰', LATEST: '时相最新',
};

const label = (key: string): string => SCHEME_LABELS[key] ?? key;

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
  /** 整行的语气；琥珀用于"未盖满"这类需要用户决定的读数。 */
  readonly tone?: (scheme: SchemeView) => 'warn' | undefined;
}

/** 未盖满 ⇒ 琥珀。`≥` 前缀的琥珀由 {@link amountText} 自己带（它只影响一个前缀）。 */
const notFullyCovered = (scheme: SchemeView): 'warn' | undefined =>
  (scheme.coveragePercent < 100 ? 'warn' : undefined);

export const SCHEME_METRICS: readonly SchemeMetric[] = [
  {
    id: 'coverage',
    label: '覆盖率',
    tone: notFullyCovered,
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
  { id: 'amount', label: '金额', read: (scheme) => amountText(scheme.amount) },
];

/**
 * 结果块里**唯一那段文本**的 JSON —— 与官方卡片同一读法（`singleResultText` 的口径）：
 * 多段内容就当作读不懂，宁可回落，不去猜哪一段是出参。
 */
function parseResult(block: ResultBlock): unknown {
  if (block.content.length !== 1) return undefined;
  const only = block.content[0];
  if (only === undefined || only.type !== 'text') return undefined;
  try {
    return JSON.parse(only.text);
  } catch {
    return undefined;
  }
}

/**
 * 一次调用 → 交付物读数。**两个面共用这一个入口**：卡据此决定画不画，
 * 自动弹也据此决定"这一轮有没有交付物"（Task 4）。
 */
export function deliverableViewOf(props: ToolCallViewProps): DeliverableView | undefined {
  if (props.phase !== 'result') return undefined;
  return buildDeliverableView({ phase: props.phase, result: parseResult(props.block) });
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

/** 卡与面板共用的方案网格（面板把它排成一列，见 `SchemeMetrics`）。 */
export function SchemeTable({ view }: { readonly view: DeliverableView }): ReactNode {
  const { primary } = view;
  return (
    <div className="wd-sc-table-wrap">
      <table className="wd-sc-table">
        <thead>
          <tr>
            {/* 左上角空着：评审稿如此，指标名在每行第一个格子里。 */}
            <th className="wd-sc-col-metric" scope="col" />
            {view.schemes.map((scheme) => (
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
              {view.schemes.map((scheme) => {
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

/** 面板用的同一份读数：一套方案、一行一个指标（376px 塞不下并排，见评审稿的注）。 */
export function SchemeMetrics({ scheme }: { readonly scheme: SchemeView }): ReactNode {
  return (
    <dl className="wd-sc-metrics">
      {SCHEME_METRICS.map((metric) => (
        <div key={metric.id} className={metric.tone?.(scheme) === 'warn' ? 'wd-sc-row is-warn' : 'wd-sc-row'}>
          <dt>{metric.label}</dt>
          <dd>{metric.read(scheme)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 对话内的卡。props 的注入面（`openDeliverable`）在 `client.tsx` 的注册点给出。 */
export function SchemeCompareCard(
  props: ToolCallViewProps & { readonly openDeliverable: (callId: string) => void },
): ReactNode {
  const view = deliverableViewOf(props);
  // 认不出形状、或一套方案都没有 ⇒ 回落官方通用卡片（这就是回落判据的落点）。
  if (view === undefined || view.primary === undefined) return null;
  const relax = view.next?.kind === 'relax' ? view.next : undefined;
  return (
    <section className="wd-sc">
      <style>{schemeCardCss}</style>
      <div className="wd-sc-head">
        <h2>选景方案</h2>
        <span className="wd-sc-sub">按你给的条件算出来，并附同池对照</span>
        <span className="wd-sc-spacer" />
        <span className="wd-sc-amount">
          <span className="wd-sc-amount-k"><b>{label(view.primary.key)}</b> · 预估金额</span>
          <span className="wd-sc-amount-v">{amountText(view.primary.amount)}</span>
        </span>
      </div>
      <SchemeTable view={view} />
      {view.pool ? <PoolLine pool={view.pool} /> : null}
      {relax ? <p className="wd-sc-relax">放宽到 {trimmed(relax.value)}% 即可盖满</p> : null}
      <div className="wd-sc-actions">
        <button type="button" onClick={() => { props.openDeliverable(props.callId); }}>查看详情</button>
        <span className="wd-sc-why">在右侧「交付物」里看这次检索的步骤与完整方案</span>
      </div>
    </section>
  );
}
