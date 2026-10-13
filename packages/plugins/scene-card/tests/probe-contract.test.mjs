/**
 * 交付物两面（对话内卡 + 右侧面板）· 契约探针
 *
 * 这不是最终功能测试，而是一组**可复跑的判定**：它把四个"拿不到就不能画"的问题
 * 钉在官方包的实际产物上（`.d.ts` 类型声明 + 编译后的 `lib/*.js`），这样后来者
 * 不必靠记忆或一次性 grep 复现结论。四个问题对应 spec
 * `2026-10-12-agent-recommend-conditions-card-design.md` 的 §9-5 / §9-6 / §9-7 / §9-8。
 *
 * 结论（详见同目录既有 spec §9）：
 *   §9-5 耗时       —— 能做。tool-call / tool-result 节点都带 epoch 毫秒时间戳；
 *                       `ToolResultNode.time` − `ToolResultNode.callTime` 即该次调用耗时。
 *   §9-6 用户关掉    —— 拿不到。唯一的关闭信号 `registerCloseHandler` 是**同步清理钩子**
 *                       （移除前触发、按 kind 注册），无法区分"用户关掉"与程序化关闭/替换。
 *   §9-7 窄屏       —— 覆盖式全屏。`viewportWidth < 768` 时右侧栏自动全屏覆盖，
 *                       既不隐藏也不占位 ⇒ 窄屏一律不弹（阈值 768px）。
 *   §9-8 重复打开    —— 重绑。kind 未声明 `multiple` 时，同一 kind 复用同一
 *                       contentId/地址，再次 `openTabIn` 会把该 tab 的 navigation.params
 *                       覆盖为新 params（revision+1），不新开第二个、也不被拒。
 *
 * 运行：
 *   node --test packages/plugins/scene-card/tests/probe-contract.test.mjs
 *
 * 依赖：本仓 Web 工作区的官方包（`apps/web/node_modules/.pnpm/@deepseek-ai+dsh-client-ui-*`）。
 * 该目录不存在时**整组失败**并点名缺哪个包 —— 本探针已被 CI 白名单收录（见
 * `.github/workflows/ci.yml` 的 Scene deliverable 那一步），会跳过的门等于没有门。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** `packages/plugins/scene-card/tests` → 仓库根。 */
const repoRoot = join(here, '..', '..', '..', '..');
const pnpmStore = join(repoRoot, 'apps', 'web', 'node_modules', '.pnpm');

/** 版本号带 peer 后缀（如 `...@0.2.0-rc.2_@deepseek-ai+cordis@4.0.4`），按前缀取第一个即可。 */
function packageDir(scopeName, ...parts) {
  if (!existsSync(pnpmStore)) return undefined;
  const entry = readdirSync(pnpmStore).find((dir) => dir.startsWith(`@deepseek-ai+${scopeName}@`));
  if (entry === undefined) return undefined;
  return join(pnpmStore, entry, 'node_modules', '@deepseek-ai', scopeName, 'lib', ...parts);
}

const typesDir = (name) => packageDir(name, 'types');
const libDir = (name) => packageDir(name);

const chatTypes = typesDir('dsh-client-ui-chat');
const conversationTypes = typesDir('dsh-client-ui-conversation');
const toolTypes = typesDir('dsh-client-ui-tool');
const sidebarRightTypes = typesDir('dsh-client-ui-sidebar-right');
const sidebarRightLib = libDir('dsh-client-ui-sidebar-right');

const missing = [
  ['dsh-client-ui-chat', chatTypes],
  ['dsh-client-ui-conversation', conversationTypes],
  ['dsh-client-ui-tool', toolTypes],
  ['dsh-client-ui-sidebar-right (types)', sidebarRightTypes],
  ['dsh-client-ui-sidebar-right (lib)', sidebarRightLib],
].filter(([, dir]) => dir === undefined || !existsSync(dir)).map(([name]) => name);

/**
 * 缺依赖即失败，不再 `{ skip: SKIP }`。本探针在 Task 6 被接进 CI 白名单，成了回归门：
 * 静默跳过的门等于没有门，所以"缺料"必须表现为**失败**，并在消息里说清缺什么。
 */
function requireOfficialPackages() {
  if (missing.length > 0) {
    assert.fail(
      `缺 Web 依赖：${missing.join(', ')}；本探针是 CI 门，缺依赖即失败 —— `
      + '先在 apps/web 下 `pnpm install` 再跑。',
    );
  }
}

function read(file) {
  return readFileSync(file, 'utf8');
}

/** 去掉 JSDoc 行首装饰并把换行/缩进摊平成单空格，用于匹配会被折行的散文串。 */
function flat(src) {
  return src
    .replace(/^[ \t]*\*[ \t]?/gm, ' ')
    .replace(/\/\*\*?/g, ' ')
    .replace(/\*\//g, ' ')
    .replace(/\s+/g, ' ');
}

/** 取 `interface|type NAME { ... }` 的花括号体（按大括号配平，避免正则吃到邻块）。 */
function bracedBody(src, headerRe) {
  const m = headerRe.exec(src);
  if (m === null) return undefined;
  const open = src.indexOf('{', m.index);
  if (open === -1) return undefined;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return undefined;
}

function interfaceBody(src, name) {
  return bracedBody(src, new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?interface\\s+${name}\\s*\\{`));
}

test('§9-5 耗时：tool-call 与 tool-result 节点都带可读 epoch 毫秒时间戳', () => {
  requireOfficialPackages();
  const records = read(join(conversationTypes, 'client', 'contract', 'records.d.ts'));

  const resultBody = interfaceBody(records, 'ToolResultNode');
  assert.ok(resultBody, 'ToolResultNode 应存在于 records.d.ts');
  assert.match(resultBody, /\btime:\s*number\b/, 'ToolResultNode 必须声明 time: number（result 事件时刻）');
  assert.match(
    resultBody,
    /\bcallTime:\s*number\s*\|\s*null\b/,
    'ToolResultNode 必须声明 callTime: number | null（配对的 tool/call 时刻）',
  );
  // callTime 的文档明写它服务"call-row duration" —— 即耗时是承重用途，不是巧合字段。
  assert.match(records, /used for call-row duration/);

  // call 侧：Preparing/Started 共用的 ToolCallHead 也有 time（该阶段开始时刻）。
  const headBody = interfaceBody(records, 'ToolCallHead');
  assert.ok(headBody, 'ToolCallHead 应存在于 records.d.ts');
  assert.match(headBody, /\btime:\s*number\b/, 'ToolCallHead 必须声明 time: number（该阶段开始时刻）');
  assert.match(records, /Unix epoch ms when this stage began/);
  assert.match(records, /interface PreparingToolCall extends ToolCallHead/);
  assert.match(records, /interface StartedToolCall extends ToolCallHead/);

  // 取法成立的前提：tool.call.toolview 的 owner 在 result 阶段就把该 block 交给视图。
  const toolSlots = read(join(toolTypes, 'client', 'contract', 'slots.d.ts'));
  const toolSlotsFlat = flat(toolSlots);
  assert.ok(/\btype\s+ToolCallPhaseProps\s*=/.test(toolSlots), 'ToolCallPhaseProps 应存在于 tool 的 slots.d.ts');
  assert.match(toolSlotsFlat, /phase: 'preparing'; readonly block: PreparingToolCall;/);
  assert.match(toolSlotsFlat, /phase: 'start'; readonly block: StartedToolCall;/);
  assert.match(toolSlotsFlat, /phase: 'result'; readonly block: ToolResultNode;/);
  assert.match(toolSlotsFlat, /ToolCallOwnerProps = ToolCallCommonProps & ToolCallPhaseProps/);

  // chat 把 tool-call 节点载荷包成 { root: ToolCallBlock }，并把相关类型再导出。
  const toolNode = read(join(chatTypes, 'client', 'conversation-nodes', 'tool.d.ts'));
  assert.match(toolNode, /'tool-call':\s*ToolChatData/);
  const chatNodes = read(join(chatTypes, 'client', 'contract', 'chat-nodes.d.ts'));
  const toolChatBody = interfaceBody(chatNodes, 'ToolChatData');
  assert.ok(toolChatBody, 'ToolChatData 应存在于 chat 的 chat-nodes.d.ts');
  assert.match(toolChatBody, /readonly\s+root:\s*ToolCallBlock/);

  const chatIndex = read(join(chatTypes, 'client', 'index.d.ts'));
  for (const name of ['ToolCallBlock', 'ToolResultNode', 'StartedToolCall', 'PreparingToolCall']) {
    assert.match(chatIndex, new RegExp(`\\b${name}\\b`), `chat/client 应再导出 ${name}`);
  }

  // 面板侧同一读法：uiConversation.binding(sessionId).target('chat') → ChatSnapshot.nodes.turnDataSource。
  const chatSnapshot = read(join(chatTypes, 'client', 'contract', 'snapshot.d.ts'));
  const nodeStore = interfaceBody(chatSnapshot, 'ChatNodeStore');
  assert.ok(nodeStore, 'ChatNodeStore 应存在于 chat snapshot.d.ts');
  assert.match(nodeStore, /turnDataSource<[\s\S]*?ObservableSnapshot<readonly\s+ChatNodeDataMap\[Kind\]\[\]>/);
});

test('§9-6 用户关掉：唯一信号是清理钩子，拿不到"用户拒绝"语义', () => {
  requireOfficialPackages();
  const service = read(join(sidebarRightTypes, 'client', 'service.d.ts'));
  const client = read(join(sidebarRightLib, 'client.js'));

  // 实现：唯一触发点是 removeAfterCleanup（同步、移除前），且它也被 replaceTab 替换路径调用。
  assert.match(client, /removeAfterCleanup\(sessionId, tab, commit\) \{\s*this\.closeHandlers\.get\(tab\.kind\)\?\.\(sessionId, tab\);/);
  assert.match(client, /this\.removeAfterCleanup\(sessionId, replaced, commit\);/,
    'removeAfterCleanup 也服务 replaceTab 替换，不能当作"用户关掉"');

  assert.match(
    service,
    /export type SidebarRightCloseHandler = \(sessionId: SessionId, tab: TabRecord\) => void/,
    '关闭钩子签名只有 (sessionId, tab)，没有"用户意图"参数',
  );
  // 文档用途写明是"显式移除前的清理与保存"，不是"用户拒绝了"。
  assert.match(service, /Register resource cleanup before explicit removal/);
  assert.match(service, /saves any background cleanup before returning and allowing removal/);
  assert.match(service, /registerCloseHandler\(kind: string, handler: SidebarRightCloseHandler\): \(\) => void/);

  // 负向断言：整个 sidebar-right 类型面里没有"用户关闭/用户拒绝"的词汇。
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.d.ts')) {
        const text = read(full);
        for (const word of ['userClosed', 'userDismissed', 'userRejected', 'userCloseHandler', 'onUserClose', 'dismissedBy']) {
          if (text.includes(word)) offenders.push(`${entry}: ${word}`);
        }
      }
    }
  };
  walk(sidebarRightTypes);
  assert.deepEqual(offenders, [], '不应存在区分"用户关闭"的信号；有则说明结论需重核');

  // 顺带钉住：`dismiss` 只属于 tab 菜单，不是 tab 关闭信号，别误用。
  const slots = read(join(sidebarRightTypes, 'client', 'contract', 'slots.d.ts'));
  assert.match(slots, /interface SidebarRightTabMenuOwnerProps[\s\S]*?dismiss: \(\) => void/);
});

test('§9-7 窄屏：<768px 自动全屏覆盖（不隐藏、不占位）', () => {
  requireOfficialPackages();
  const client = read(join(sidebarRightLib, 'client.js'));

  assert.match(client, /const autoFullscreen = viewportWidth < 768;/, '阈值常量 768px 应存在');
  assert.match(client, /const fullscreen = autoFullscreen \|\| surface\?\.layout\.mode === "fullscreen";/,
    '窄屏时 fullscreen 为真 ⇒ 面板以全屏方式呈现');
  assert.match(client, /const track = shown && !autoFullscreen;/, '窄屏不保留轨道 ⇒ 覆盖而非占位');

  // 类型面上没有把该判定暴露给插件；插件只能自测视口，故记录这一点。
  const service = read(join(sidebarRightTypes, 'client', 'service.d.ts'));
  const host = interfaceBody(service, 'SidebarRightHost');
  assert.ok(host, 'SidebarRightHost 应存在于 service.d.ts');
  assert.match(host, /readonly autoFullscreen: \(\) => boolean/,
    'autoFullscreen 只出现在 host（官方内部接口）上');
  const iface = interfaceBody(service, 'ISidebarRight');
  assert.ok(iface, 'ISidebarRight 应存在于 service.d.ts');
  assert.doesNotMatch(iface, /autoFullscreen/, 'ISidebarRight 未暴露窄屏判定');
});

test('§9-8 重复 openTabIn：重绑同一 tab，不新开第二个也不被拒', () => {
  requireOfficialPackages();
  const client = read(join(sidebarRightLib, 'client.js'));

  // kind 未声明 multiple 时，地址是稳定的 pageAddress(kind) ⇒ contentId 相同 ⇒ 同一 tab。
  assert.match(
    client,
    /const address = definition\.multiple === true \? `\$\{pageAddress\(kind\)\}\/\$\{randomUUID\(\)\}` : pageAddress\(kind\);/,
    '未声明 multiple 的 kind 复用同一地址 ⇒ 打开是幂等的',
  );

  // openContent 中：page 型内容按 (pane, kind) 找已存在的页，命中即聚焦旧 tab、回传其 tabId。
  assert.match(client, /const held = page \? panePage\(state, paneId \?\? [\s\S]*?, kind\) : void 0;/);
  assert.match(client, /const revealed = page \? held : /);
  assert.match(client, /type: "focusTab",[\s\S]*?tabId: revealed/,
    '命中已存在页时只聚焦旧 tab（settled 回传同一 tabId）');

  // 随后 openTabIn 回调把新的 address+params 写回同一 tab 的 navigation（revision+1）⇒ 重绑。
  assert.match(client, /existing\.navigation\.set\(\{/);
  assert.match(client, /revision: existing\.navigation\.getSnapshot\(\)\.revision \+ 1/);

  // 副作用须记录：openContent 每次都会把列展开，故"已开着时不动布局"不能靠 openTabIn 保证。
  assert.match(client, /const ops = \[\.\.\.\(0, _deepseek_ai_dsh_client_ui_dockkit\.planSetExpanded\)\(state, true\)\];/,
    'openTabIn 总是展开右侧栏');

  // 契约文档同样钉住"同一地址即同一 tab"。
  const registry = flat(read(join(sidebarRightTypes, 'client', 'tab-registry.d.ts')));
  assert.match(registry, /Two opens of the same address are the same tab, which is what makes opening idempotent/);
  assert.match(registry, /omission keeps one page per kind in each pane/);
});
