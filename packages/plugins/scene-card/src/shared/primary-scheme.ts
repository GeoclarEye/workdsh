/**
 * 主推那一套的选法：`CUSTOM` → `VALUE` → 第一套。**两个半区共用这一份**。
 *
 * 为什么要共用：这条规则有两个用户可见的出口 —— 面板高亮的那一套（`client/scheme-view.ts`）
 * 与交付物 `summary` 里引用的那一套（`runtime/deliverable-document.ts`）。各写一份，将来改规则
 * 时两者会各说各话，而它们的口径必须一致（同一份出参、同一次调用）。
 *
 * 只认元素上有个 `key`，不认具体类型：出参那一头是 `Record<string, unknown>`，视图这一头是 `SchemeView`。
 */
export function primaryOf<T extends { readonly key?: unknown }>(schemes: readonly T[]): T | undefined {
  const byKey = (key: string): T | undefined => schemes.find((scheme) => scheme.key === key);
  return byKey('CUSTOM') ?? byKey('VALUE') ?? schemes[0];
}
