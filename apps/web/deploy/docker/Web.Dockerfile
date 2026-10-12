# syntax=docker/dockerfile:1

# WorkDSH Web —— 单用户自托管镜像
#
# 一个容器 = 一个前门 + 一个官方 dsh 进程。**不提供多用户隔离**，边界见 README。
#
# 构建上下文是 apps/web（不是仓库根）：那里同时有前门与已构建的发布产物。
#
#   cd apps/web
#   corepack pnpm install --frozen-lockfile
#   corepack pnpm build
#   corepack pnpm release:project:pack        # → apps/web/.artifacts/project-v<版本>/
#   cd ../..
#   docker build -f apps/web/deploy/docker/Web.Dockerfile -t workdsh-web:local apps/web
#
# 发布产物的目录名带版本号，所以用构建参数传入；默认值需与 apps/web/package.json 的
# version 一致（默认值漂移只会导致 COPY 找不到路径，构建会立即失败，不会静默出坏镜像）。

FROM node:22-bookworm-slim

ARG RELEASE_DIR=.artifacts/project-v0.1.0-alpha.15
# 国内网络建议换源：--build-arg NPM_REGISTRY=https://registry.npmmirror.com --build-arg APT_MIRROR=mirrors.tencentyun.com
ARG NPM_REGISTRY=https://registry.npmjs.org/
ARG APT_MIRROR=

# git / python3 / make / g++ 是官方运行时的实际依赖：node-pty 是原生模块，装 dsh 时要编译。
#
# 容器里的 bash 沙箱由 DSH 的功能探针回退到 Landlock（bubblewrap 在默认容器里创建
# 命名空间会失败）。**不要**为此加 --privileged 或 --cap-add SYS_ADMIN：那会实打实
# 扩大攻击面，而沙箱该走哪条路由 DSH 自己探测，加了也不改变结果。
RUN if [ -n "${APT_MIRROR}" ]; then \
      for f in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do \
        [ -f "$f" ] && sed -i "s|deb.debian.org|${APT_MIRROR}|g; s|security.debian.org|${APT_MIRROR}|g" "$f"; \
      done; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY ${RELEASE_DIR}/ /opt/workdsh/release/

# 两个版本都不硬编码，构建期从 manifest 读出：
#
#   harness        官方 CLI 的版本。install-workdsh.mjs 要求 `dsh --version` 与它
#                  完全一致，不一致会直接报错退出。
#   packageManager profile 声明的 pnpm 版本。**必须用 corepack prepare 把默认版本
#                  钉到它**：corepack 解析版本时看的是当前工作目录，而安装器是用
#                  `corepack pnpm --dir <profile>` 调用的（cwd 不随之改变），容器
#                  cwd 是 / 没有 package.json，corepack 就会用最新版 pnpm。新版
#                  pnpm 见到 packageManager 声明不一致会直接
#                  `ERR_PNPM_BAD_PM_VERSION`，首启安装整段失败。
# 最后一行的 corepack pnpm --version 是断言：解析不到钉住的版本就让构建失败。
RUN DSH_VERSION="$(node -p "require('/opt/workdsh/release/release-manifest.json').harness")" \
 && PNPM_VERSION="$(node -p "require('/opt/workdsh/release/release-manifest.json').packageManager")" \
 && echo "安装官方 dsh@${DSH_VERSION}；把 corepack 默认 pnpm 钉到 ${PNPM_VERSION}" \
 && npm install --global --no-fund --no-audit --registry="${NPM_REGISTRY}" "@deepseek-ai/dsh@${DSH_VERSION}" \
 && corepack enable \
 && corepack prepare "${PNPM_VERSION}" --activate \
 && dsh --version \
 && cd / && corepack pnpm --version

COPY deploy/docker/front.mjs /opt/workdsh/front.mjs

# DSH_HOME 下是会话、凭据、资料库、项目与 Profile —— 必须挂卷，否则重建容器即丢。
ENV DSH_HOME=/srv/dsh \
    WORKDSH_RELEASE_DIR=/opt/workdsh/release \
    WORKDSH_PROFILE=workdsh \
    WORKDSH_LISTEN_PORT=3080 \
    WORKDSH_INNER_PORT=3081
RUN mkdir -p /srv/dsh
VOLUME /srv/dsh

EXPOSE 3080
# 前门会 spawn dsh，并用 init 回收 reparent 的孙进程（见 compose.yml 的 init: true）。
CMD ["node", "/opt/workdsh/front.mjs"]
