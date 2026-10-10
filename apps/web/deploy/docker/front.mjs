#!/usr/bin/env node
/**
 * WorkDSH Web 单用户自托管前门。
 *
 * 官方的 `dsh web` 只绑定回环地址——`--host 0.0.0.0` 被显式拒绝（"it would
 * expose remote code execution to the network"）——所以容器要对外提供服务，
 * 就必须有一个前门把 0.0.0.0 上的请求转发到回环。
 *
 * 这个前门是**最小传输层**，只做三件事：
 *   1. 首次启动时把 WorkDSH Profile 装进 DSH_HOME
 *   2. 拉起 `dsh` 并等它打印就绪行
 *   3. 把请求原样转发到回环端口
 *
 * 它**不做**认证、不做多用户、不改写任何业务头。认证仍由 dsh 自己完成：
 * dsh 的浏览器信任围栏要求 Origin.host 等于 Host，登录 cookie 又按 authority
 * 签名，因此 Host 与 Origin 必须原样透传——改写任一个都会同时破坏围栏和 cookie。
 * 对外域名通过 `--trusted-host` 交给 dsh 认领，而不是由前门伪造 Host。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { join, resolve } from 'node:path'

/** dsh 在 Loader 树稳定后打印的就绪行。 */
export const READY_PATTERN = /dsh web: (https?:\/\/\S+)/

const DEFAULTS = {
  profile: 'workdsh',
  listenPort: 3080,
  innerPort: 3081,
}

/**
 * 从就绪行里取出内部端口与启动令牌。
 *
 * @param line - dsh 的一行 stdout。
 * @param pattern - 就绪行正则，测试可替换。
 * @returns 解析结果；该行不是就绪行时为 undefined。
 */
export function parseReadyLine(line, pattern = READY_PATTERN) {
  const match = pattern.exec(line)
  if (!match) return undefined
  let url
  try {
    url = new URL(match[1])
  } catch {
    return undefined
  }
  const port = Number(url.port)
  if (!Number.isInteger(port) || port <= 0) return undefined
  return { port, token: url.searchParams.get('token') ?? undefined }
}

/**
 * 把内部回环地址换成对外地址，并保留启动令牌。
 *
 * dsh 只知道自己绑在回环上，打印出来的 URL 对外不可用；操作者拿到的是
 * 带上对外域名的等价地址。cookie 按 authority 签名，而请求经前门后 dsh
 * 看到的 Host 就是对外域名，因此这个替换与 dsh 的判定是一致的。
 *
 * @param publicUrl - 对外基地址，可以是 `example.com` 或完整 URL。
 * @param token - 启动令牌；缺省时不附加查询参数。
 */
export function publicUrl(publicUrl, token) {
  const base = /^https?:\/\//.test(publicUrl) ? publicUrl : `https://${publicUrl}`
  const url = new URL(base)
  if (token) url.searchParams.set('token', token)
  return url.toString()
}

/**
 * 从对外地址取出 `--trusted-host` 要用的 authority（含端口，若非默认端口）。
 */
export function trustedHost(publicUrl) {
  return new URL(/^https?:\/\//.test(publicUrl) ? publicUrl : `https://${publicUrl}`).host
}

/**
 * 启动转发服务。Host 与 Origin 连同其余请求头一并透传。
 *
 * @returns 已开始监听的 http.Server。
 */
export function startProxy({ listenPort, listenHost = '0.0.0.0', innerPort, innerHost = '127.0.0.1' }) {
  const server = createServer((request, response) => {
    const upstream = httpRequest(
      {
        host: innerHost,
        port: innerPort,
        method: request.method,
        path: request.url,
        // 原样透传：Host 与 Origin 是 dsh 的信任判定依据，不能改写。
        headers: request.headers,
        // 单用户前门不需要连接池；不复用连接才能让上游连接的生命周期与请求一致，
        // 否则进程退出时会有闲置 socket 挂着不放。
        agent: false,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
        upstreamResponse.pipe(response)
      },
    )
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('workdsh front: upstream unavailable\n')
    })
    request.pipe(upstream)
  })

  // WebSocket / SSE 升级同样需要原样转发，理由与上面一致。
  server.on('upgrade', (request, socket, head) => {
    const upstream = httpRequest({
      host: innerHost,
      port: innerPort,
      method: request.method,
      path: request.url,
      headers: request.headers,
      agent: false,
    })
    upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      socket.write(
        `HTTP/1.1 ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}\r\n` +
          Object.entries(upstreamResponse.headers)
            .flatMap(([name, value]) => (Array.isArray(value) ? value.map(item => [name, item]) : [[name, value]]))
            .map(([name, value]) => `${name}: ${value}\r\n`)
            .join('') +
          '\r\n',
      )
      if (upstreamHead.length) socket.unshift(upstreamHead)
      if (head.length) upstreamSocket.unshift(head)
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
    })
    upstream.on('error', () => socket.destroy())
    upstream.end()
  })

  server.listen(listenPort, listenHost)
  return server
}

/** 等子进程打印就绪行，返回解析结果。 */
function awaitReady(child, pattern = READY_PATTERN) {
  return new Promise((resolveReady, rejectReady) => {
    let buffered = ''
    const onData = (chunk) => {
      buffered += chunk.toString()
      process.stdout.write(chunk)
      const ready = parseReadyLine(buffered, pattern)
      if (ready) {
        child.stdout.off('data', onData)
        resolveReady(ready)
      }
    }
    child.stdout.on('data', onData)
    child.once('exit', (code) => rejectReady(new Error(`dsh exited before it reported readiness (code ${code ?? 'unknown'})`)))
  })
}

/** 首次启动把 WorkDSH Profile 装进 DSH_HOME；已在则跳过。 */
function installProfileIfNeeded({ releaseDirectory, dshHome, profile }) {
  const installed = join(dshHome, 'profiles', profile, 'package.json')
  if (existsSync(installed)) {
    console.log(`[front] profile ${profile} 已存在于 ${dshHome}，跳过安装`)
    return Promise.resolve()
  }
  console.log('[front] 首次启动：正在把 WorkDSH Profile 安装到 DSH_HOME（需要访问 npm registry）')
  return new Promise((resolveInstall, rejectInstall) => {
    const installer = spawn(
      process.execPath,
      [join(releaseDirectory, 'install-workdsh.mjs'), '--profile', profile],
      { stdio: 'inherit' },
    )
    installer.once('error', rejectInstall)
    installer.once('exit', (code) =>
      code === 0 ? resolveInstall() : rejectInstall(new Error(`install-workdsh.mjs 以退出码 ${code} 结束`)),
    )
  })
}

async function main() {
  const dshHome = resolve(process.env.DSH_HOME ?? '/srv/dsh')
  const releaseDirectory = resolve(process.env.WORKDSH_RELEASE_DIR ?? '/opt/workdsh/release')
  const profile = process.env.WORKDSH_PROFILE ?? DEFAULTS.profile
  const publicAddress = process.env.WORKDSH_PUBLIC_URL
  const listenPort = Number(process.env.WORKDSH_LISTEN_PORT ?? DEFAULTS.listenPort)
  const innerPort = Number(process.env.WORKDSH_INNER_PORT ?? DEFAULTS.innerPort)

  process.env.DSH_HOME = dshHome
  await installProfileIfNeeded({ releaseDirectory, dshHome, profile })

  const child = spawn(
    'dsh',
    [
      '--profile', profile,
      '--port', String(innerPort),
      '--no-open',
      // 官方支持的信任围栏开关：让 dsh 认领对外 authority，而不是由前门改写 Host。
      ...(publicAddress ? ['--trusted-host', trustedHost(publicAddress)] : []),
    ],
    { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] },
  )
  child.once('exit', (code, signal) => {
    console.error(`[front] dsh 退出：code=${code ?? 'null'} signal=${signal ?? 'null'}`)
    process.exit(code ?? 1)
  })

  const ready = await awaitReady(child)
  if (publicAddress) {
    console.log(`\nWorkDSH Web 就绪：${publicUrl(publicAddress, ready.token)}\n`)
  } else {
    console.warn('[front] 未设置 WORKDSH_PUBLIC_URL，仅能经回环访问；对外服务需要 HTTPS（见 README）')
  }

  startProxy({ listenPort, innerPort })
  console.log(`[front] 正在 ${listenPort} 上转发到 127.0.0.1:${innerPort}`)
}

// 仅在作为入口运行时启动；被测试 import 时不执行。
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    console.error(`[front] ${error.message}`)
    process.exit(1)
  })
}
