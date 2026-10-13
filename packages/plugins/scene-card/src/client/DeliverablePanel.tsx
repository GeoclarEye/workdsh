/**
 * 右侧「交付物」面板（spec §4.4）——同一个交付物的**第二个面**。
 *
 * 两个面分工（评审稿的注）：**卡负责"横向比"**（它够宽，四列并排），
 * **面板负责"这一件交付物的细节 + 整轮过程"**（376px 塞不下并排，四套之间用顶部分段器切）。
 * 读数同源：方案网格走 {@link SchemeMetrics}（卡的 `SCHEME_METRICS` 同一份），
 * 所以两个面不可能把同一份出参读成两个样子。
 *
 * 两条硬规矩：
 *   1. **页脚固定**（{@link DeliverablePanel} 的 `.wd-dp-foot`）：「下一步」是这一轮**唯一**的
 *      行动入口，第一稿把它放在正文末尾，六块一超高就被折叠线吃掉了。
 *   2. **不认识的形状就少画那一块**，而不是画半张 —— 与卡同一条规矩。
 *
 * 版式基准：评审稿右半边（`docs/superpowers/specs/2026-10-12-agent-recommend-conditions-card-mockup.html`）。
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-tool/client';
import type { ReactNode } from 'react';
import { useState } from 'react';
// 方案的显示名（`label`）与读数网格（`SchemeMetrics`）都从卡那边来 —— 同一个东西两个面
// 叫同一个名字、读同一份数；在这里再抄一遍就会漂移。
import { deliverableViewOfResultBlock, label, SchemeMetrics } from './SchemeCompareCard.js';
import type { DeliverableView, SchemeView } from './scheme-view.js';
import { formatDuration, readTurnTools, toolLabel } from './turn-tools.js';
import type { TurnTools } from './turn-tools.js';
import { schemeCardCss } from './styles.js';

/**
 * 面板的 props：`sidebar.right.pane.tab` 的运行时面（会话级 ⇒ 有 `useTabInfo` 与
 * 会话标准件 `useChat` / `inputActions`），加上本插件经 inject 工厂给的那一份。
 */
export interface PanelInjected {
  /**
   * 门户地址（spec §4.4「导出」：**只跳门户、不做下载**）。
   *
   * 没配就**不放一个点了没反应的按钮** —— 见 {@link DeliverablePanel} 的导出按钮：
   * 无地址时它是 `disabled` 的，并且把"为什么"写在 `title` 上。
   */
  readonly portalOrigin?: string | undefined;
}

export type DeliverablePanelProps = PropsRuntime<'sidebar.right.pane.tab'> & PanelInjected;

/** 面板绑定的那次调用：`openTabIn(…, { params: { callId } })` 写进 navigation 的那一个。 */
function readBoundCallId(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const callId = (params as { callId?: unknown }).callId;
  return typeof callId === 'string' && callId !== '' ? callId : undefined;
}

/**
 * `useChat` 的选择器值比较：只在**真正要显示的东西**变了时才重渲染。
 * 不比较的话每次出参发布（包括无关的正文流式）都会重建整个面板。
 */
function sameTurnTools(left: TurnTools | undefined, right: TurnTools | undefined): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  if (left.turn !== right.turn || left.tools.length !== right.tools.length) return false;
  return left.tools.every((tool, index) => {
    const other = right.tools[index];
    return tool.callId === other.callId && tool.name === other.name
      && tool.running === other.running && tool.durationMs === other.durationMs
      && tool.root === other.root;
  });
}

/** 「下一步」的三个分支（spec §4.4：**出参驱动，不编剧本**）；三个都不成立就没有这一块。 */
function nextActionOf(view: DeliverableView): { readonly label: string; readonly prompt: string } | undefined {
  const next = view.next;
  if (next === undefined) return undefined;
  if (next.kind === 'relax') {
    const percent = Number.isInteger(next.value) ? String(next.value) : next.value.toFixed(1);
    return { label: `按此放宽到 ${percent}%`,
      prompt: `把云量放宽到 ${percent}%，重新算一次选景方案。` };
  }
  if (next.kind === 'narrow') {
    return { label: '收窄范围重算', prompt: '候选池到上限了，收窄范围重新算一次选景方案。' };
  }
  const full = next.fullCoverageAmount;
  return { label: '按预算只看盖到多少',
    prompt: full === null
      ? '按我的预算，重新算一次，并说清这个预算能盖到多少。'
      : `按预算重新算一次，并说清盖满要 ¥${Math.round(full).toLocaleString('en-US')} 这件事。` };
}

/** 步骤一行：✓ / 转圈 + 名字 + 耗时。耗时**没有就不出**（不写「—」，见 `turn-tools.ts`）。 */
function StepRow({ tool }: { readonly tool: TurnTools['tools'][number] }): ReactNode {
  return (
    <li className={tool.running ? 'wd-dp-step is-running' : 'wd-dp-step'}>
      {tool.running
        ? <span className="wd-dp-spin" aria-label="进行中" />
        : <span className="wd-dp-mark" aria-hidden="true">✓</span>}
      <span className="wd-dp-name">{toolLabel(tool.name)}</span>
      {tool.durationMs === null ? null
        : <span className="wd-dp-time">{formatDuration(tool.durationMs)}</span>}
    </li>
  );
}

/** 步骤块：该 `callId` **所在的那一轮**（不是"最近一轮"，见 `turn-tools.ts`）。 */
function Steps({ turn }: { readonly turn: TurnTools }): ReactNode {
  return (
    <section className="wd-dp-block">
      <p className="wd-dp-label">步骤 · {turn.tools.length}</p>
      <ol className="wd-dp-steps">
        {turn.tools.map((tool) => <StepRow key={tool.callId} tool={tool} />)}
      </ol>
    </section>
  );
}

/** 这一套选了哪些景。出参最多给 20 条（`MAX_SCENE_SUMMARIES`），说不全就如实说不全。 */
function Scenes({ scheme }: { readonly scheme: SchemeView }): ReactNode {
  if (scheme.scenes.length === 0) return null;
  return (
    <details className="wd-dp-scenes">
      <summary>
        这一套选了哪些景（{scheme.sceneCount} 景，列出前 {scheme.scenes.length}）
      </summary>
      <ul>
        {scheme.scenes.map((scene) => (
          <li key={scene.id}>
            <span className="wd-dp-scene-id">{scene.id}</span>
            <span className="wd-dp-scene-meta">{scene.acquiredAt} · 云 {scene.cloud}% · {scene.resolution}m</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * 方案块：顶部分段器四选一 + 这一套的读数（竖排网格，复用卡的那一份）。
 *
 * 默认选中**主推**那一套；切换只换读数，不改变面板绑定的 `callId`（那是卡的「查看详情」的事）。
 */
function Schemes({ view }: { readonly view: DeliverableView }): ReactNode {
  const primaryKey = view.primary?.key;
  // 选中的那一套记在组件状态里；**换绑到别的调用时整个子树重挂**（面板那边用 `key={callId}`），
  // 所以不会带着上一件的选择。
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const active = view.schemes.find((scheme) => scheme.key === selected)
    ?? view.schemes.find((scheme) => scheme.key === primaryKey)
    ?? view.schemes[0];
  if (active === undefined) return null;
  const isPrimary = active.key === primaryKey;
  return (
    <section className="wd-dp-block">
      <p className="wd-dp-label">方案</p>
      <div className="wd-dp-seg" role="tablist" aria-label="方案">
        {view.schemes.map((scheme) => (
          <button key={scheme.key} type="button" role="tab"
            aria-selected={scheme.key === active.key}
            onClick={() => { setSelected(scheme.key); }}>
            {label(scheme.key)}
          </button>
        ))}
      </div>
      <div className="wd-dp-artifact" role="tabpanel">
        <div className="wd-dp-ahead">
          <span className="wd-dp-t">{label(active.key)}</span>
          {/* 条件由入参得来、出参里没有，所以主推那套不编一句说明；对照套如实标"对照"。 */}
          {isPrimary ? null : <span className="wd-dp-s">对照</span>}
        </div>
        <SchemeMetrics scheme={active} />
        <Scenes scheme={active} />
      </div>
    </section>
  );
}

/** 用到的工具：这一轮出现过的工具名，按首次出现顺序去重。 */
function Tools({ turn }: { readonly turn: TurnTools }): ReactNode {
  const names: string[] = [];
  for (const tool of turn.tools) {
    const name = toolLabel(tool.name);
    if (!names.includes(name)) names.push(name);
  }
  return (
    <section className="wd-dp-block">
      <p className="wd-dp-label">用到的工具</p>
      <div className="wd-dp-tools">
        {names.map((name) => <span key={name} className="wd-dp-tool">{name}</span>)}
      </div>
    </section>
  );
}

/**
 * 面板本体。
 *
 * 数据来源只有两条，都是框架给的面：
 *   · `useTabInfo()` → 这个 tab 绑的是哪一次调用（`navigation.params.callId`）；
 *   · `useChat(…)` → 那次调用所在那一轮的步骤与结果（读法在 `turn-tools.ts`）。
 * 不自己碰 ctx，也不另建一份会话订阅。
 */
export function DeliverablePanel(props: DeliverablePanelProps): ReactNode {
  const info = props.useTabInfo();
  const callId = readBoundCallId(info.tab.navigation.params);
  const turn = props.useChat((snapshot) => readTurnTools(snapshot, callId ?? ''), sameTurnTools);
  const bound = turn?.tools.find((tool) => tool.callId === callId);
  const view = bound === undefined ? undefined : deliverableViewOfResultBlock(bound.root);
  const next = view === undefined ? undefined : nextActionOf(view);
  const portal = props.portalOrigin;

  if (view === undefined || view.primary === undefined || turn === undefined) {
    return (
      <section className="wd-dp">
        <style>{schemeCardCss}</style>
        <header className="wd-dp-head">
          <h3>交付物</h3>
          <span className="wd-dp-status">已过期</span>
        </header>
        <div className="wd-dp-body">
          <p className="wd-dp-empty">这一件交付物已经不在当前对话窗口里 —— 回到它自己那张卡上点「查看详情」可以再回来。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="wd-dp">
      <style>{schemeCardCss}</style>
      <header className="wd-dp-head">
        <h3>交付物</h3>
        <span className="wd-dp-spacer" />
        <span className="wd-dp-status">{label(view.primary.key)} · 已完成</span>
      </header>
      <div className="wd-dp-body">
        <Steps turn={turn} />
        {/* 按绑定的调用重挂：换了一件交付物就回到它的主推那一套，不留上一次的选择。 */}
        <Schemes key={callId} view={view} />
        <Tools turn={turn} />
      </div>
      {/*
       * 页脚：**不随正文滚动**。它挂在滚动容器之外（`.wd-dp-body` 才是滚动的那一个），
       * 所以正文再长也吃不掉这两个入口。
       */}
      <footer className="wd-dp-foot">
        {next === undefined ? null : (
          <button type="button" className="wd-dp-next"
            onClick={() => { props.inputActions.setDraft(next.prompt); }}>
            {next.label}
          </button>
        )}
        <button type="button" className="wd-dp-export" disabled={portal === undefined}
          title={portal === undefined ? '还没有配置门户地址' : undefined}
          onClick={() => {
            if (portal === undefined) return;
            window.open(portal, '_blank', 'noopener,noreferrer');
          }}>
          去门户导出
        </button>
      </footer>
    </section>
  );
}
