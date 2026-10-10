# deploy/docker — WorkDSH Web 单用户自托管容器

**一个容器 = 一个前门 + 一个官方 `dsh` 进程**，单用户、单一 `DSH_HOME`。

## 边界（先读这段）

这个容器**不提供任何多用户隔离**：谁能访问这个端口，谁就拥有同一份会话、资料库、项目与凭据。它的定位是"把现在单进程的 WorkDSH Web 放到服务器上自托管"，不是团队共享服务。

- 前门**不做认证**，认证仍由 `dsh` 自己完成（启动令牌换 cookie）。所以**不要把 3080 直接暴露到公网**，只能经终止 TLS 的反向代理访问。
- 前门**不做多用户**：没有账号、没有每用户进程、没有每用户 `DSH_HOME`。

## 为什么需要前门

官方的 `dsh web` 只绑定回环地址——`--host 0.0.0.0` 被显式拒绝：

```
error: --host 0.0.0.0 is intentionally not supported yet for safety:
it would expose remote code execution to the network; use 127.0.0.1 instead
```

所以容器要对外提供服务就必须有人转发。前门是最小传输层：**原样透传 `Host` 与 `Origin`**，不做其他改写。

这不是可有可无的讲究——`dsh` 的两处机制都依赖它们：

1. `/api` 的浏览器信任围栏要求 `Host` 属于回环或 `--trusted-host` 列表，**且 `Origin.host` 等于 `Host`**；
2. 登录 cookie 按 authority 签名（`dsh-auth-<sha256(authority)>`）。

改写任一个都会同时破坏围栏与 cookie。对外域名交给 `--trusted-host` 认领，而不是由前门伪造 `Host`。

## 构建

先在 `apps/web` 构建发布产物（这一步需要联网装依赖）：

```sh
cd apps/web
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm release:project:pack        # → .artifacts/project-v<版本>/
cd ../..
```

**先提交再打包。** `release-manifest.json` 会记录 `sourceCommit` 与 `sourceDirty`；工作区有未提交改动时打包出来的产物会带 `sourceDirty: true`，来源就说不清了。

**注意产物版本号与 harness 是两回事。** 本地打包出的 `version` 取自 `apps/web/package.json`（当前仍是 `0.1.0-alpha.14`），而 `harness` 取自仓库当前的官方运行时对齐（当前是 `0.2.0-rc.2`）。也就是说：**本地构建的同名产物会比已发布的 alpha.14 跑在更新的 DSH 上**——已发布的那份要求 `0.1.7-rc.2`。这正是镜像要从 manifest 读 `harness`、而不是照文档硬编码的原因。

再构建镜像。**构建上下文是 `apps/web`**，`apps/web/.dockerignore` 已经把 `node_modules` 与 `.test-runtime` 排除掉——不排除的话上下文会有数 GB：

```sh
docker build -f apps/web/deploy/docker/Web.Dockerfile -t workdsh-web:local apps/web
```

发布产物的目录名带版本号，所以升级版本后要跟着改 `RELEASE_DIR`：
默认值是 `.artifacts/project-v0.1.0-alpha.14`，与 `apps/web/package.json` 的 `version` 对应。

镜像里的官方 CLI 版本**不硬编码**：构建期从 `release-manifest.json` 的 `harness` 字段读出。这不是洁癖——`install-workdsh.mjs` 要求 `dsh --version` 与该字段完全一致，硬编码迟早会撞上版本漂移。

国内网络可以换源：

```sh
docker build -f apps/web/deploy/docker/Web.Dockerfile -t workdsh-web:local \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
  --build-arg APT_MIRROR=mirrors.tencentyun.com \
  apps/web
```

## 运行

```sh
cp deploy/docker/.env.example deploy/docker/.env    # 填 WORKDSH_PUBLIC_URL
docker compose -f deploy/docker/compose.yml up -d
```

**首次启动会联网**：安装器要把官方 DSH 运行时装进 `DSH_HOME`（`install-workdsh.mjs` 会执行 `corepack pnpm add`）。之后的启动不再需要网络。

### 拿到登录链接

`dsh` 的启动令牌是**每进程一次**的，前门会把它打印成对外可用的地址：

```sh
docker compose -f deploy/docker/compose.yml logs web | grep -o 'https://[^ ]*token=[^ ]*'
```

在浏览器里打开这个地址，令牌会换成 authority 绑定的签名 cookie，之后直接访问域名即可。

## 反向代理

由你在外层终止 TLS，并把 `Host` 与 `Origin` **原样**传给容器。Caddy 示例：

```
dsh.example.com {
    reverse_proxy 127.0.0.1:3080
}
```

**HTTPS 是功能前提**：DSH 浏览器端调用 `crypto.randomUUID`，该 API 仅在安全上下文可用。回环地址算安全上下文（所以本机 `http://127.0.0.1` 可以），但经域名或局域网 IP 访问时必须 HTTPS。

## 数据、升级与备份

| 内容 | 位置 |
|---|---|
| 会话、凭据、资料库、项目 | 具名卷 `workdsh-home` → `/srv/dsh` |
| Profile（含插件 node_modules） | 同上，`/srv/dsh/profiles/workdsh` |
| pnpm 存储 `storeDir` | 同上，`/srv/dsh/.pnpm-store` |

### 关于卷里的 `.pnpm-store`

**不要把它挪出卷，也不要当冗余目录清掉。** pnpm 把存储放在项目所在的文件系统上，是为了让它与 `node_modules` 之间建立**硬链接**：同一个包只占一份磁盘。存储换到别的文件系统后只能退化成复制，安装更慢、占用更大。

它还直接决定**升级的速度**：升级镜像时前门会重跑安装器，存储里已有的包只做链接、不重新下载。首次安装要从 npm 取几百个包，是最慢的一步；有存储的升级快得多。

（它不影响镜像构建和本地构建——那两处用的是各自的缓存，与此卷无关。）

⚠️ 备份包含 `.credentials.yaml` 与会话内容，不是可以公开的归档。

- **卷必须保留**：不挂卷时重建容器会丢掉全部会话与凭据。
- **升级**：构建新版本产物 → 构建新镜像 → `up -d`。卷里的 Profile 会被安装器按已有 Profile 处理（`install-workdsh.mjs` 对已存在的 Profile 走升级路径）。升级前建议先停容器并备份卷。
- **回滚**：换回旧镜像 tag；卷里的数据保持不动。
- **备份**：

```sh
docker run --rm -v workdsh-home:/data -v "$PWD":/backup alpine \
  tar czf /backup/workdsh-home-$(date +%F).tar.gz -C /data .
```

## 已验证的约束

1. **沙箱走 Landlock，不是 bubblewrap**，且不需要任何额外权限。bubblewrap 在默认容器里创建命名空间会失败，DSH 用功能探针判定后端并回退。**不要**为此加 `--privileged` 或 `--cap-add SYS_ADMIN`。
2. **`init: true` 是必需的**：前门 `spawn` 出 `dsh`，`dsh` 被强杀时其孙进程会 reparent 给 PID 1。
3. **前门必须原样透传 `Host`/`Origin`**，理由见上文。`apps/web/tests/deploy/front.test.mjs` 对此有断言——改前门时先跑 `corepack pnpm test:deploy`。
4. **官方进程只绑容器内回环**：宿主经端口映射访问不到它，只有同容器的前门能访问。宿主上不能用 `curl localhost:<内部端口>` 调试。

## 已知限制

- **单用户**：多个浏览器/标签页共享同一份会话与资料库，互相可见。
- **首次启动慢**：要在容器内安装官方运行时（几分钟，取决于网络）。
- **镜像与卷各存一份 Profile 的 `node_modules`**：磁盘占用约为两倍。
- **非回环页面的「预览版说明」弹窗**：DSH 在非回环页面上记不住"已确认"（该设置命名空间仅限宿主），刷新会再次出现。
- 未验证：Windows/macOS 之外的宿主、多架构镜像（当前只按 `linux/amd64` 构建）、反向代理之外的接入方式。
