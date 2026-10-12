import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizationHeaderValue, toolCallTimeoutMs } from '../dist/manager.js';

// 每个连接器的授权值都作为整条 Authorization 头发出，所以"缺 scheme"是畸形头而不是另一种令牌形态：
// 后端按 RFC 7235 校验前缀，缺了就被判为无身份，而界面把它标成"访问令牌"，填的人自然会只粘令牌。
// 这组断言钉的就是补齐规则本身。

test('a scheme-less authorization value gains the Bearer scheme', () => {
  assert.equal(authorizationHeaderValue('gcp_abc123'), 'Bearer gcp_abc123');
});

test('an authorization value that already names a scheme is preserved verbatim', () => {
  assert.equal(authorizationHeaderValue('Bearer gcp_abc123'), 'Bearer gcp_abc123');
  assert.equal(authorizationHeaderValue('Basic dXNlcjpwdw=='), 'Basic dXNlcjpwdw==');
  assert.equal(authorizationHeaderValue('Digest realm="staging"'), 'Digest realm="staging"');
});

// 工具调用超时不设默认值：上游 MCP 客户端自己就有默认（60s），而插件此前硬编码 10s 把它压低了 6 倍，
// 于是任何真正干活的工具（多源检索 10~90s）都会被客户端取消。所以这里的契约是"没配就别覆盖"。

test('an unset tool-call timeout leaves the official client default in place', () => {
  assert.equal(toolCallTimeoutMs(undefined), undefined);
});

test('a nonsensical tool-call timeout does not become the override', () => {
  assert.equal(toolCallTimeoutMs(0), undefined);
  assert.equal(toolCallTimeoutMs(-1), undefined);
  assert.equal(toolCallTimeoutMs(Number.NaN), undefined);
});

test('a configured tool-call timeout is passed through', () => {
  assert.equal(toolCallTimeoutMs(180_000), 180_000);
});
