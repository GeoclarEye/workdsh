/**
 * 门户地址：面板页脚的「去门户导出」跳过去的地方（spec §4.4：**只跳门户、不做下载**）。
 *
 * 值来自**宿主的插件配置**（`cordis.patch.yml` 的 `config.portalOrigin`），由本插件的 Host
 * 半区经 `/api/workdsh-scene-card` 交给浏览器 —— 客户端半区**读不到** cordis 配置
 * （boot manifest 不携带 config，`ctx.config` 在客户端会抛），所以这一跳是必要的。
 *
 * 拿不到就返回 `undefined`：调用方据此**把按钮关掉并说明原因**，不放一个点了没反应的按钮。
 */

/** 与 `src/index.ts` 的 `sceneCardPath` 同一个路径（两个半区各写一份，靠测试钉住一致）。 */
export const portalPath = '/api/workdsh-scene-card';

/** 读一次门户地址；任何失败（没配 / 路由不在 / 网络错）都按"没配"处理。 */
export async function loadPortalOrigin(signal?: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetch(portalPath, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'portal', payload: {} }),
      signal: signal === undefined ? AbortSignal.timeout(5_000) : AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    });
    if (!response.ok) return undefined;
    const body = await response.json() as { ok?: unknown; value?: unknown };
    if (body.ok !== true || typeof body.value !== 'object' || body.value === null) return undefined;
    const origin = (body.value as { portalOrigin?: unknown }).portalOrigin;
    return typeof origin === 'string' && origin !== '' ? origin : undefined;
  } catch {
    return undefined;
  }
}
