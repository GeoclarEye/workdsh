/**
 * 一次真实调用的出参摘录 —— **两个面（对话内的卡、右侧面板）的渲染测试共用这一份**。
 *
 * 共用不是图省事：两个面的全部理由就是"同一份出参、同一份读数"，夹具若各写一份，
 * 测出来的"两个面一致"就只是两份手抄件恰好一致。
 *
 * `CUSTOM` 那一套取自一次真实调用；三套同池对照的值是评审稿的示意值（后端确实产出这四套，
 * 但这里没有真实样本可引）。
 */

export const custom = { key: 'CUSTOM', sceneCount: 235, coveredAreaKm2: 35984.07, coveragePercent: 65.16,
  uncoveredAreaKm2: 19239.18, estimatedAmount: 5564229.98, pricingComplete: true, budgetCapped: false,
  budgetFullCoverageAmount: null, dateFrom: '2024-12-06', dateTo: '2026-10-09',
  gsdMin: 0.25, gsdMax: 0.5, cloudCoverMax: 33.0, cloudCoverMean: 1.33,
  scenes: [{ id: 'SVN1-02-20261008-00755433', acquiredAt: '2026-10-08 06:29:48', cloud: '13', resolution: 0.3 }] };

/** 这一套演示"预算把它截断了" ⇒ 金额整格琥珀（pricingComplete 为真，所以不是下界）。 */
export const latest = { ...custom, key: 'LATEST', sceneCount: 312, coveragePercent: 58.4, uncoveredAreaKm2: 22982,
  estimatedAmount: 6120400, budgetCapped: true, budgetFullCoverageAmount: 7111222.5,
  dateFrom: '2025-06-01', dateTo: '2026-10-01', gsdMin: 0.3, gsdMax: 0.8,
  cloudCoverMax: 22, cloudCoverMean: 2.4 };

export const sharpest = { ...custom, key: 'SHARPEST', sceneCount: 118, coveragePercent: 41.0, uncoveredAreaKm2: 32589,
  estimatedAmount: 7980150, pricingComplete: false, dateFrom: '2025-01-01', dateTo: '2026-09-01',
  gsdMin: 0.25, gsdMax: 0.3, cloudCoverMax: 8, cloudCoverMean: 0.6 };

export const cheapest = { ...custom, key: 'CHEAPEST', sceneCount: 640, coveragePercent: 72.6, uncoveredAreaKm2: 15140,
  estimatedAmount: 3215700, dateFrom: '2024-11-01', dateTo: '2026-10-01', gsdMin: 0.5, gsdMax: 2.0,
  cloudCoverMax: 20, cloudCoverMean: 4.1 };

/** 精算态的真实形状：出参顺序 = 列序，CUSTOM 打头，后接三套同池对照。 */
export const payload = { mode: 'custom', pool: { candidateCount: 861, usableCount: 561, skippedByCloud: 0,
  skippedByFilter: 299, skippedNoGeometry: 1, skippedNoIntersection: 0, effectiveCloudCoverMax: 100,
  regionAreaKm2: 55226.95, coveredAreaKm2: 36625.09, coveragePercent: 66.32 },
  candidatePoolLimit: 100, poolAtLimit: true, schemes: [custom, latest, sharpest, cheapest],
  returnedCount: 4, truncated: false, relaxation: { kind: 'CLOUD_COVER_MAX', value: 26, coveragePercent: 100 } };

/** 12 套预设：键与顺序取自后端 `SceneSchemeKey.presetKeys()`（VALUE 排在第 11）。 */
export const presetKeys = ['LATEST', 'SHARPEST', 'CLEAREST', 'CHEAPEST', 'SHARP_CLEAN', 'CLEAN_SHARP',
  'RECENT_SHARP', 'RECENT_CLEAN', 'CLEAN_CHEAP', 'SHARP_CHEAP', 'VALUE', 'CONSISTENT'];

export const presets = { ...payload, mode: 'presets', relaxation: null,
  schemes: presetKeys.map((key, index) => ({ ...custom, key, sceneCount: 100 + index, coveragePercent: 40 + index })) };
