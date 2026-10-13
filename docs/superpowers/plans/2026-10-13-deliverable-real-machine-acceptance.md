# 交付物即文件 · 真机验收清单

> 对应 spec `docs/superpowers/specs/2026-10-13-deliverable-as-file-design.md` §8 的「不可省」门。
> 本次改动 `921c74a286`（+ `33d91da65d` 发版），本地已全部合并进 `main`，PR https://github.com/techflag/workdsh/pull/58 。

## 现状：所有无头验证都已过，但没有一条碰过真机

已过（本地 `main`）：scene-card 全套 **139/139**；根 `corepack yarn check` exit 0；
alpha.18 产物 `sourceCommit=33d91da6`、`sourceDirty: false`，且 scene-card 的 tgz 内确含
`dist/runtime/deliverable-{document,store,producer}.js`、`tool-call-pairing.js`、`shared/primary-scheme.js`。

**但这些全都伪造了 `header.cwd`** —— 终审明确指出：生产者的单点失败被任何测试都没触及。
所以下面第 2 步之前，任何"绿"都不构成候选完整。

## 部署（推送与重启由人做）

```bash
# 产物已就绪
ls apps/web/.artifacts/project-v0.1.0-alpha.18/     # 13 个 tgz + manifest + SHA256SUMS + install-workdsh.mjs
docker images workdsh-web                           # 本地镜像应已构建出 :local
```

推镜像 + 重启（**会中断实例上正在使用的人**；回滚靠记下旧镜像 ID）：

```bash
OLD=$(docker inspect -f '{{.Image}}' workdsh-trial)   # 先记下，便于回滚
docker save workdsh-web:local | ssh root@39.105.35.182 'docker load'
ssh root@39.105.35.182 'docker restart workdsh-trial'
```

重启后应看到（`front.mjs` 判定版本变化 → 重装 Profile）：

```bash
ssh root@39.105.35.182 'docker logs workdsh-trial 2>&1 | tail -30'
#   期望看到 "检测到版本变化（0.1.0-alpha.17/… → 0.1.0-alpha.18/…），重新安装 Profile"
ssh root@39.105.35.182 'docker exec workdsh-trial cat /srv/dsh/.workdsh-profile-installed.json'
#   期望 version = 0.1.0-alpha.18
```

**若安装器空转**（版本没变）⇒ 别查代码，先查版本号：发布版本决定"安装器跑不跑"，
包版本决定"pnpm 换不换内容"，两处都要抬（先例 `5e461cf458`）。

## 验收步骤

### 1. 触发一次真实检索

在 <https://agent.geoclar.com> 新建会话，让助手跑一次 `geoclar_recommend_schemes`（说清 AOI 与条件）。

### 2. 文件真的落了吗 —— **核心一步**

```bash
ssh root@39.105.35.182 'docker exec workdsh-trial sh -lc "ls -R /root/geoclar/交付物 2>/dev/null || echo 空"'
```

期望：一个 `<UTC时间戳>-<主题>` 目录，内含 `manifest.json` 与 `v1.json`。
**看不到 = 生产者没挂上**，此时看容器日志里有没有 `workdsh-scene-card` 的 warn
（例：`交付物跳过：会话没有 cwd`、`交付物落盘失败：…`）。

### 3. 逐项核对内容（别只看"有文件"）

`manifest.json` 应含：`format=workdsh-deliverable`、`schemaVersion=1`、`slug`、`subject`、
`callId`、`current=v1.json`、`versions[1]`。

`v1.json` 应含：`type=scene-schemes`、`title`、`summary`、**`intent`**（`tool`/`scheme`/`aoi`/`conditions`）、`payload`。

**两条最容易被忽略、又最容易出错的**：

- **`intent.conditions` 是空的只有 AOI？** 那多半是**部署的 geoclar 后端早于"推荐条件链"那次发版**
  （工具不认那些条件入参 → 静默忽略）。这是后端版本问题，不是本次的 bug —— 但会让"凭据"退化
  （只能靠 AOI 重算，丢掉云量/预算/分辨率口径）。此时需要先把 geoclar 推到那个版本。
- **`payload` 里有没有出现 `_raw` / 厂商场景号 / `geometry` / `thumbUrl`？** 有就是**掩码边界被破了**，
  属严重问题。注意 `scenes[]` 每景只有 `id`/`acquiredAt`/`cloud`/`resolution` 四键，这是对的。

### 4. 面板渲染（消费侧不在本次）

面板**仍是旧实现**（读会话快照、按 `callId` 绑定）—— 面板改绑文件路径是**另一份计划**。
所以这一期面板能显示卡片与面板，但**面板的"已过期"空态问题依旧存在**（那正是下一期要治的）。
不要把"面板还能用"误读成消费侧已完成。

### 5. 「窗口截断后重开仍能渲染」—— **本期无法验**

这是 spec §8 点名要治的病，但它属于**消费侧**：文件确实落盘且含 intent，可**面板还没改成按文件渲染**，
所以截断后面板**仍会**显示"已过期"。这条**要等消费侧计划完成后才能验**。
本期能验的等价物是第 3 步：**文件在磁盘上、内容完整、`intent` 可重算**。

### 6. 已知不需要现在验的

- 交付物→下单：依赖 geoclar 侧四件事（写工具 / raw 承载 / 写权限身份 / 方案重建），见 spec §11。
  本次对 geoclar **零接口改动**。
- `excludeSceneIds` 未存进 `intent`（"换一景"的输入会丢）。影响重算口径，不挡下单。

## 判据

**通过**：第 2 步有文件、第 3 步 manifest 与 intent 完整、无掩码字段泄漏、`conditions` 非空（或已解释为空的原因）。

**不通过**：没有任何文件（查生产者是否挂上、`cwd` 是否有值、日志有无 warn）。

**无论通过与否都不算"候选完整"**：第 5 步要等消费侧。按 CLAUDE.md ——
"Report missing acceptance explicitly; never call a candidate complete while required plugins or entries are missing."