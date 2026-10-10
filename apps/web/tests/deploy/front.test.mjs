import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import test from 'node:test'

import { needsInstall, parseReadyLine, publicUrl, startProxy, trustedHost } from '../../deploy/docker/front.mjs'

test('安装判定：首次启动、版本变化、半途失败都要重装', () => {
  const current = { version: '0.1.0-alpha.14', harness: '0.2.0-rc.2' }

  // 首次启动：没有标记
  assert.equal(needsInstall(undefined, current), true, '缺标记时不该跳过安装')
  // 半途失败：标记没写出来
  assert.equal(needsInstall(null, current), true)

  // 同一版：跳过
  assert.equal(needsInstall({ version: '0.1.0-alpha.14', harness: '0.2.0-rc.2' }, current), false)

  // 换了发布版本，或换了官方 harness —— 都要重装，否则卷里留着旧 Profile
  assert.equal(needsInstall({ version: '0.1.0-alpha.13', harness: '0.2.0-rc.2' }, current), true)
  assert.equal(needsInstall({ version: '0.1.0-alpha.14', harness: '0.1.7-rc.2' }, current), true)
})

/** 上游替身：把收到的请求头原样回显，用来验证前门有没有改写它们。 */
function echoServer() {
  return new Promise((resolve) => {
    const received = []
    const server = createServer((request, response) => {
      received.push(request.headers)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(request.headers))
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port }))
  })
}

/** 经前门发一个请求，返回上游看到的请求头。 */
function requestThroughProxy(port, headers) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      // Connection: close 让测试的连接不被复用，测试结束时事件循环能自然清空。
      { host: '127.0.0.1', port, path: '/', method: 'GET', headers: { connection: 'close', ...headers } },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => { body += chunk })
        response.on('end', () => {
          let headers
          try {
            headers = JSON.parse(body)
          } catch {
            // 上游失败时前门返回纯文本，解析失败不应让 promise 悬空。
            headers = undefined
          }
          resolve({ status: response.statusCode, headers, body })
        })
      },
    )
    request.on('error', reject)
    request.end()
  })
}

/** 关掉服务并断开既有连接；server.close() 不处理 keep-alive 连接，会挂住测试进程。 */
function closeServer(server) {
  server.closeAllConnections?.()
  return new Promise((resolve) => server.close(resolve))
}

test('解析就绪行：取出内部端口与启动令牌', () => {
  const line = 'dsh web: http://127.0.0.1:3081/?token=bSzl9aXqd71qPykgMcSrLtB3qe4eEPF469dyd-Acek\n'
  assert.deepEqual(parseReadyLine(line), {
    port: 3081,
    token: 'bSzl9aXqd71qPykgMcSrLtB3qe4eEPF469dyd-Acek',
  })
})

test('解析就绪行：非就绪行返回 undefined，不抛异常', () => {
  assert.equal(parseReadyLine('dsh: warning: 1 entry did not activate'), undefined)
  assert.equal(parseReadyLine('dsh web: not-a-url'), undefined)
})

test('对外地址：替换 authority 并保留令牌', () => {
  assert.equal(
    publicUrl('https://dsh.example.com', 'abc'),
    'https://dsh.example.com/?token=abc',
  )
  // 裸域名按 HTTPS 处理：对外服务必须是安全上下文，否则浏览器端 crypto.randomUUID 不可用。
  assert.equal(publicUrl('dsh.example.com'), 'https://dsh.example.com/')
})

test('trusted-host：非默认端口要带上端口', () => {
  assert.equal(trustedHost('https://dsh.example.com'), 'dsh.example.com')
  assert.equal(trustedHost('http://dsh.internal:8443'), 'dsh.internal:8443')
})

test('前门原样透传 Host 与 Origin —— dsh 的信任围栏和登录 cookie 都依赖它们', async () => {
  const upstream = await echoServer()
  const proxy = startProxy({ listenPort: 0, innerPort: upstream.port })
  await new Promise((resolve) => proxy.once('listening', resolve))
  const proxyPort = proxy.address().port

  try {
    const sent = {
      host: 'dsh.example.com',
      origin: 'https://dsh.example.com',
      'sec-fetch-site': 'same-origin',
      'user-agent': 'proxy-test',
    }
    const { status, headers } = await requestThroughProxy(proxyPort, sent)
    assert.equal(status, 200)
    assert.equal(headers.host, 'dsh.example.com', 'Host 被改写了，dsh 的围栏会失配')
    assert.equal(headers.origin, 'https://dsh.example.com', 'Origin 被改写了，Origin.host ≠ Host 将导致 403')
    assert.equal(headers['sec-fetch-site'], 'same-origin')
    assert.equal(headers['user-agent'], 'proxy-test')
  } finally {
    await closeServer(proxy)
    await closeServer(upstream.server)
  }
})

test('上游不可用时返回 502，而不是挂起', async () => {
  const proxy = startProxy({ listenPort: 0, innerPort: 1 })
  await new Promise((resolve) => proxy.once('listening', resolve))
  try {
    const { status, body } = await requestThroughProxy(proxy.address().port, { host: 'dsh.example.com' })
    assert.equal(status, 502)
    assert.match(body, /upstream unavailable/)
  } finally {
    await closeServer(proxy)
  }
})
