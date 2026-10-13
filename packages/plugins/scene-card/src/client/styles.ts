/**
 * 交付物两个面的样式（对话内简版卡 + 右侧面板），版式基准是评审稿左半边
 * `docs/superpowers/specs/2026-10-12-agent-recommend-conditions-card-mockup.html`。
 *
 * 颜色一律走 `--dsw-alias-*` 主题令牌（深浅色主题自动跟随），只有"琥珀"取的是评审稿的
 * 那个值 —— 主题里它有名字（`--dsw-alias-state-warn-primary`），所以也走令牌。
 * 两个面共用这一份：面板复用卡里的方案网格，样式跟着一起复用，不各写一套。
 */
export const schemeCardCss = `
.wd-sc{--wd-sc-accent:var(--dsw-alias-state-business-primary);--wd-sc-warn:var(--dsw-alias-state-warn-primary);--wd-sc-line:var(--dsw-alias-border-l2);--wd-sc-muted:var(--dsw-alias-label-tertiary);box-sizing:border-box;margin-top:2px;border:1px solid var(--wd-sc-line);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:18px 19px 14px;font:13px/1.7 "PingFang SC","Microsoft YaHei",system-ui,sans-serif}
.wd-sc *{box-sizing:border-box}
.wd-sc h2{margin:0;font-size:14px;font-weight:600}

/* 标题行：方案名 + 一句话说明 + 最响的那块（主推的预估金额）。 */
.wd-sc-head{display:flex;align-items:baseline;gap:10px;padding-bottom:12px;border-bottom:1px solid var(--wd-sc-line)}
.wd-sc-sub{color:var(--wd-sc-muted);font-size:11.5px}
.wd-sc-spacer{flex:1}
.wd-sc-amount{text-align:right;line-height:1.25}
.wd-sc-amount-k{display:block;color:var(--wd-sc-muted);font-size:10.5px}
.wd-sc-amount-k b{color:var(--wd-sc-accent);font-weight:600}
.wd-sc-amount-v{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--wd-sc-accent)}

/*
 * 兜底：容器放不下四列时横向滚动，而不是让表格溢出到卡外（溢出 = 数据被裁掉且没有提示）。
 * 与"预设态去掉滚动"不是一回事：presets 是**减少列数**（12 → 1），列少了自然不用滚；
 * custom 是**列数固定为 4**，只有在真的放不下时才滚 —— 放得下时不出现（auto 不产生滚动条）。
 */
.wd-sc-table-wrap{overflow-x:auto}
.wd-sc-table{width:100%;border-collapse:collapse}
/* 四列并排时的横向预算：指标列 56px + 单元格左右各 4px（评审稿的 6px 收窄，省下的给读数列）。 */
.wd-sc-table th,.wd-sc-table td{padding:8px 4px;vertical-align:baseline;border-bottom:1px solid var(--wd-sc-line)}
.wd-sc-table tr:last-child td{border-bottom:0}
.wd-sc-col-metric{width:56px}
.wd-sc-col{font-weight:400;text-align:right;padding-bottom:5px;white-space:nowrap}
.wd-sc-name{display:block;font-size:12px;color:var(--dsw-alias-label-primary);font-weight:600}
.wd-sc-tag{display:block;font-size:10.5px;color:var(--wd-sc-muted);margin-top:1px}
.wd-sc-metric{color:var(--dsw-alias-label-secondary);font-size:11.5px;text-align:left;padding-left:0;white-space:nowrap}
.wd-sc-val{text-align:right;font-variant-numeric:tabular-nums;font-size:13px;white-space:nowrap}
/*
 * 琥珀只留给"这个数不能直接当结论用"的两种情形：金额是**下界**（「≥」，见 .wd-sc-loose）、
 * 以及预算把方案截断了（budgetCapped，整格的金额转琥珀）。覆盖率**不上琥珀** —— 盖不满是常态，
 * 全标黄等于没有信号；高低由数字与「未覆盖」那行说。
 */
.wd-sc-val.is-warn,.wd-sc-row.is-warn dd{color:var(--wd-sc-warn)}
.wd-sc-u{color:var(--wd-sc-muted);font-size:10.5px;margin-left:2px}
/* 主推那一列：底色 + 左右描边，名字用强调色 —— 三列并排时要一眼认出"你这一套"。 */
.wd-sc-table .is-primary{background:var(--dsw-alias-bg-layer-2);border-left:1px solid var(--wd-sc-line);border-right:1px solid var(--wd-sc-line)}
.wd-sc-table .wd-sc-col.is-primary .wd-sc-name,.wd-sc-table .wd-sc-col.is-primary .wd-sc-tag{color:var(--wd-sc-accent)}

/* 覆盖率：条 + 数字。没盖满时整格转琥珀 —— 那是"要不要继续"的读数。 */
.wd-sc-cover{display:flex;align-items:center;justify-content:space-between;width:104px;margin-left:auto}
.wd-sc-bar{width:54px;height:4px;border-radius:2px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden;flex:0 0 auto}
.wd-sc-bar i{display:block;height:100%;background:var(--wd-sc-accent)}
.wd-sc-n{text-align:right}
/* 金额下界：前缀「≥」。写成琥珀是怕有人把它当成精确值读。 */
.wd-sc-loose{color:var(--wd-sc-warn);font-weight:600}

/* 脚注块：提示行 / 池诊断 / 放宽建议共用一条上分隔线，一行一句。 */
.wd-sc-cfoot{margin-top:11px;padding-top:10px;border-top:1px solid var(--wd-sc-line);color:var(--wd-sc-muted);font-size:11.5px;line-height:1.8}
.wd-sc-cfoot .wd-sc-limit{margin-left:8px}
.wd-sc-relax{margin:2px 0 0;color:var(--wd-sc-warn)}

/* 卡底固定「查看详情」：历史可达性的唯一入口（面板是按调用的活状态，三天后早换了）。 */
.wd-sc-actions{display:flex;align-items:center;gap:9px;margin-top:11px;padding-top:10px;border-top:1px solid var(--wd-sc-line)}
.wd-sc-actions button{background:none;border:1px solid var(--wd-sc-line);color:var(--dsw-alias-label-primary);border-radius:7px;font:inherit;font-size:11.5px;padding:5px 11px;cursor:pointer}
.wd-sc-actions button:hover{border-color:var(--wd-sc-accent);color:var(--wd-sc-accent)}
.wd-sc-actions button:focus-visible{outline:2px solid var(--wd-sc-accent);outline-offset:2px}
.wd-sc-why{color:var(--wd-sc-muted);font-size:11px}

/* 面板里同一份读数的竖排形态（右侧只有 376px，三列并排读不清）。 */
.wd-sc-metrics{margin:0;padding:10px}
.wd-sc-row{display:flex;align-items:baseline;gap:10px;padding:3px 0}
.wd-sc-row dt{width:58px;flex:0 0 auto;color:var(--wd-sc-muted);font-size:11px}
.wd-sc-row dd{margin:0 0 0 auto;text-align:right;font-size:12.5px;font-variant-numeric:tabular-nums;white-space:nowrap}
.wd-sc-metrics .wd-sc-cover{margin-left:auto}
.wd-sc-metrics .wd-sc-u{font-size:10px}
`;
