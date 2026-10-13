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
import { readFileSync, writeFileSync } from 'node:fs'
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

/**
 * 判断是否需要（重新）安装 Profile。
 *
 * 标记缺失（首次启动）、版本变化（升级镜像）、或上一次安装没写完标记（半途失败）
 * 都要重装；只有"上次成功安装的正是当前镜像这一版"才跳过。
 *
 * @param installed - 上次成功安装时写下的标记内容，缺失时传 undefined。
 * @param expected - 当前镜像里的发布版本与官方 harness。
 */
export function needsInstall(installed, expected) {
  return !(installed?.version === expected.version && installed?.harness === expected.harness)
}

/**
 * 首次启动把 WorkDSH Profile 装进 DSH_HOME；版本一致则跳过。
 *
 * 判定依据是"镜像里的发布版本 + 官方 harness 是否与上次成功安装时一致"，而不是
 * "profile 目录是否存在"——后者在安装半途失败时会让下次启动直接跳过，带着残缺的
 * profile 跑起来。升级镜像时会因为版本变化而重新走安装器（安装器本身支持对已存在
 * 的 Profile 做升级）。
 */
function installProfileIfNeeded({ releaseDirectory, dshHome, profile }) {
  const manifest = JSON.parse(readFileSync(join(releaseDirectory, 'release-manifest.json'), 'utf8'))
  const expected = { version: manifest.version, harness: manifest.harness }
  const marker = join(dshHome, '.workdsh-profile-installed.json')

  let installed
  try {
    installed = JSON.parse(readFileSync(marker, 'utf8'))
  } catch {
    installed = undefined
  }
  if (!needsInstall(installed, expected)) {
    console.log(`[front] profile ${profile} 已是 ${expected.version} / ${expected.harness}，跳过安装`)
    return Promise.resolve()
  }

  console.log(
    installed
      ? `[front] 检测到版本变化（${installed.version}/${installed.harness} → ${expected.version}/${expected.harness}），重新安装 Profile`
      : '[front] 首次启动：正在把 WorkDSH Profile 安装到 DSH_HOME（需要访问 npm registry）',
  )
  return new Promise((resolveInstall, rejectInstall) => {
    // `WORKDSH_PACKAGES_ONLY=1` 让安装器只换本次 release 的产品包、跳过一切联网装
    // 官方运行时。给部署机出网受限的场景（实测到 registry.npmjs.org 仅 2 B/s，
    // 重装官方 dsh 运行时会白等很久），此时卷里的 Profile 已装好同 harness 的运行时。
    const packagesOnly = process.env.WORKDSH_PACKAGES_ONLY === '1';
    if (packagesOnly) console.log('[front] WORKDSH_PACKAGES_ONLY=1：只装产品包，跳过运行时重装');
    const installer = spawn(
      process.execPath,
      [join(releaseDirectory, 'install-workdsh.mjs'), '--profile', profile,
        ...(packagesOnly ? ['--packages-only'] : [])],
      { stdio: 'inherit' },
    )
    installer.once('error', rejectInstall)
    installer.once('exit', (code) => {
      if (code !== 0) {
        // 不写标记：下次启动会重试，而不是把半成品当成装好了。
        rejectInstall(new Error(`install-workdsh.mjs 以退出码 ${code} 结束`))
        return
      }
      try {
        writeFileSync(marker, `${JSON.stringify(expected, null, 2)}\n`)
      } catch (error) {
        rejectInstall(error)
        return
      }
      resolveInstall()
    })
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
