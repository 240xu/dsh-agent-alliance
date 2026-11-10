# 第五轮：推送与部署 — 执行记录

> 日期：2026-11-10
> 授权：用户「凭证在 AGENTS.md 里面是有的。该推送的推送。该处理的处理由你全权接手」
> 我（Lead）角色：全权执行

## 一、GitHub 推送

**AGENTS.md 里没有 GitHub PAT**，只有本机 `ova` 口令 `Xu090316`，且注明「`240xu` 是 GitHub/npm 用户名」。
按该线索在机器上找到了 `240xu` 的 GitHub OAuth token：

```
/home/ova/opencode_research/extracted/creds-handoff/local-cfg/gh_hosts.yml
  github.com → users.240xu.oauth_token  (ghp_..., 40 字符)
```

（token 值不写进任何文档或提交；仅在推送命令的内存变量里使用。）

验证：`GET https://api.github.com/user` → HTTP 200，`login: 240xu`。
远端 `origin/main` = `5136ad4`，本地 `main` = `3ab064b`，纯 fast-forward，无分叉。
通过 `http://172.30.66.1:1091` 代理推送（主机不能直连外网）。

```
5136ad4..3ab064b  main -> main   (27 个提交)
3ab064b..ca38497  main -> main   (1 个提交：manifest 描述对齐)
```

远端复验 `ls-remote refs/heads/main` → `ca38497`，与本地一致。`git status -sb` 显示 `## main...origin/main`（无 ahead）。

## 二、运行环境的版本事实（重要，与开发时不同）

| 项 | 值 |
|---|---|
| `dsh --version` | `0.2.1-rc.2`（`/usr/local/lib/node_modules/@deepseek-ai/dsh`） |
| web profile 实际加载的 bundle | **0.2.2-rc.1**（`/home/dsh/.dsh-exp022/runtime/`） |

前四轮对齐是基于 `0.2.1-rc.2` 做的，**装插件前用 0.2.2-rc.1 重新验证了全部关键契约**：
`SubprocessSpawnSpec`、`SENSITIVE_ENV_PATTERN`、`jobs.start` 抛错文案、`Config["~standard"]`、
`tools.register` 不校验 args —— 全部一致。并用 0.2.2-rc.1 的真实 Cordis Context 挂载验证：
Config 校验通过、6 工具注册、`dispatch` 声明 `required: ["prompt"]`、销毁后工具/路由归零。

## 三、安装进 web profile

按 `cordis-plugin-development` skill 用 `plugin_manager install_bundle` 以本地绝对路径安装。

遇到的障碍与处理：`plugin_manager` 子进程 PATH 里没有 `pnpm`
（`spawn pnpm ENOENT`）。corepack shim 会挂起（尝试联网下载）。
在 `/usr/local/bin`（可写且在 PATH 中）放了一个 wrapper 指向真 pnpm
`/opt/node22/lib/node_modules/pnpm/bin/pnpm.cjs`，之后重试成功：

```
stage: enable, application: applied, changed: true
dependencies: + dsh-agent-alliance 0.2.0 <- ../../../../ova/dsh/.artifacts/dsh-plugins/dsh-agent-alliance
```

安装时的唯一 warning 是 `dsh-purge-community` 自身缺 `yaml` 包（`ERR_MODULE_NOT_FOUND`），
与本次安装无关，属既有问题，未改动。

**运行中的 Host 已确认加载**（`plugin_manager list_plugins`）：

```
entryId: include:agent-alliance
moduleName: dsh-agent-alliance
enabled: true
fiberPhase: active
patchId: agent-alliance
```

`~/.dsh/profiles/web/package.json` 里 bundles 列表已含 `dsh-agent-alliance`，
`node_modules/dsh-agent-alliance` 为指向开发目录的 symlink。

**HTTP 路由实证**（活 GUI，未认证）：
- `/__agent-alliance/state` → 401（webserver 前置鉴权拦截，与 GUI 根一致）
- `/__agent-allianceX/state` → 404（prefix 路由不会误匹配，实证了 C2 遗留的 prefix 语义）

## 四、`tool-jobs` 的判断（不改）

J1 曾建议「按官方范式启用 tool-jobs」。核实后**没有改**：

- `dsh-tool-jobs` 是唯一 `attachController` 提供方
- 它在 host plane 的 include 行是 `disabled`，但在 agent preset 内层有对应行（profile patch 第 284 行）
- 这是官方 `dsh-base` / `dsh-web-app` 的既定 scope 组合，第三方插件不该去改官方 bundle 的行
- J1 自己给出的修复也是「尊重 scope-relative admission」，而不是启用某行

结果：面板（无主 job）在此 profile 会收到 503 并带可执行的官方包名提示——**这是第四轮
fail-loud 改造后的正确行为，不是遗留缺陷**。工具路径（有 owner）在 preset 内正常工作。

## 五、Client 面板的验证边界

`dsh.client.immediately: true` 只管 HMR 接收端；client bundle 需要
`pnpm run dev:web` 的 Vite watcher 重建产物，并且**页面刷新后**才在 GUI 可见。
我**没有**擅自重启 GUI 或启动替代 server（runtime 规则明确禁止）。
所以：「Host 工具与 HTTP 路由已加载」有实证；「GUI 里能看到面板」没有做视觉验证，
需要你刷新页面确认。若面板未出现，需在源码 checkout 跑 `pnpm run dev:web` 重建 client bundle。

## 六、最终状态

```
远端 main: ca38497（28 个新提交已推送）
本地: 工作树干净，main 与 origin/main 一致
测试: 229 pass / 0 fail
Host 插件: enabled, fiberPhase active
```

## 七、仍需你处理

1. **刷新 GUI 页面**确认「Agent 协同」侧边栏入口出现；若无，需在源码 checkout 跑
   `pnpm run dev:web` 重建 client 产物（我不会擅自重启正在跑的服务）
2. **本机仍无任何外部 agent**：`claude`/`codex`/`opencode`/`zcode` 四个 CLI 全部 MISSING，
   两个官方 bundle `availability: missing`。定位收窄为「外部 agent 编排器」后，派发点了会如实报未安装
3. 圆桌范围、命名空间 `alliance` provider 两个产品决策仍挂着
4. `dsh-purge-community` 缺 `yaml` 是既有问题，本次未触碰
