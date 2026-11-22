# dsh-agent-alliance 规格书

> 2026-08-21 经用户批准的设计。双面 DSH 插件：让 DeepSeek Harness 与
> Claude Code / Codex / OpenCode / ZCode 协同运行。

## 目标

1. **子代理派发** — DSH 会话把任务无头派给外部 agent CLI，后台运行、取回结果、多轮续聊；
2. **圆桌讨论** — 同一问题并发发给多个 agent，收集观点输出对比汇总；
3. **会话管理** — 浏览/读取各外部 agent 的本地历史会话；
4. **自研导入** — 四格式历史会话导入为可继续的 DSH 会话（独立实现，不复用 dsh-chat-import）；
5. **Web 面板** — 侧边栏入口 + 中央视图（Provider 状态/会话列表/任务状态/圆桌发起/导入）。

## 非目标

- 不做外部 agent 的 GUI 内嵌终端；
- 不修改 dsh-chat-import 及其 registry（两插件并存，互不感知）；
- zcode 无头协同不做硬编码适配（官方未公开 CLI 无头规范），走可配置命令模板。

## 架构

双面插件（参照 dsh-plugin-session-delete / dsh-client-ui-task-board 先例）：

- Host 半边（node ESM，exports "."）：apply(ctx) 注册工具 + 可选 webServer 端点。
- Client 半边（浏览器 classic script，exports "./client"，经 dsh.client 声明由
  /plugins/<id>/client.js 下发）：window.__ModuleLoader__.load({id, factory})，
  DOM 注入侧边栏入口 + 独立 React root 中央视图。

目录：src/{index,config,runner,parse}.js + src/provider/{types,detect,claude,codex,opencode,zcode}.js
+ src/roundtable.js(P2) + src/importer/*(P3) + src/http.js(P4) + client/*(P4) + tests/(node --test)。

## Provider 统一接口

defineProvider({ id, label,
  async detect() -> {available, version?, detail?},
  async dispatch({prompt,cwd,resumeSessionId,model,timeoutMs,signal}) -> {text, externalSessionId?, raw?},
  async listSessions({query,limit}) -> [{id,title?,cwd?,createdAt?,messageCount?}],
  async readSession(id,{maxChars}) -> {title?, messages:[{role,text}]},
})

registry：createRegistry(providers) -> { list(), get(id), detectAll() }。

## 各 agent 接入事实（本机已验证）

| Agent | 本机形态 | dispatch | 续聊 | 解析 |
|---|---|---|---|---|
| claude 2.1.232 | glibc 二进制，须 grun 启动（$PREFIX/lib/node_modules/@anthropic-ai/claude-code-linux-arm64/claude） | -p <prompt> --output-format stream-json | --resume <id> / --continue | stream-json 行：assistant 消息取 text 块；system/init 取 session_id |
| codex 0.148.0 | node 入口 $PREFIX/lib/node_modules/@openai/codex/bin/codex.js（绝对路径调用规避 PATH 问题） | exec <prompt> | exec resume <id> / --last | 实现时探测 --json 或末段文本，fixture 固化 |
| opencode 1.18.18 | 二进制 ~/.local/share/xucodex/opencode/bin/opencode；必须 TMPDIR=$PREFIX/tmp | run <prompt> --format json | -s <sessionId> / -c | json 事件流，fixture 固化 |
| zcode | 未安装；CLI 内嵌桌面应用，无公开无头规范 | commandTemplate 模板（{prompt}{session}{cwd}），默认 disabled | 模板变量 | 纯文本 |

### 存储规范（导入器依据）

- claude: ~/.claude/projects/<cwd-slug>/<uuid>.jsonl
- codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
- opencode: ~/.local/share/opencode/opencode.db（SQLite 只读；session/message/part/project）
- zcode: ~/.zcode/cli/db/db.sqlite（SQLite 只读；schema 已交叉验证）

SQLite 用 node:sqlite（本机 node v26.4.0 已验证 readOnly 打开 opencode.db）。

## 工具面

| 工具 | 参数 | 返回 |
|---|---|---|
| agent_dispatch | provider*, prompt*, cwd?, resumeSessionId?, model?, background?(auto) | 同步 {provider,text,externalSessionId,durationMs}；后台 {kind:'background',jobId} |
| agent_roundtable | prompt*, providers?, cwd? | 后台 job；观点+分歧对比（P2） |
| agent_sessions | provider*, query?, limit?=20 | {sessions} |
| agent_session_read | provider*, sessionId*, maxChars?=8000 | {title,messages} |
| agent_import_scan | provider?, query?, limit?=50 | {total,sessions}（P3） |
| agent_import | provider*, sessionId*, restamp? | 导入结果，幂等（P3） |

工具描述必须写明：真实消耗各家 API 额度、可能在 cwd 内改文件；重要操作先征得用户同意。

## 后台任务契约

ctx.jobs.start({kind:'agent-alliance', label:'<provider>: <prompt 前60字>', owner: exec.agent, outputLimitBytes, run})
-> JobHooks{cancel, done, readOutput?}。取消用自有 AbortController，与 exec.signal 解耦；前台模式才耦合 exec.signal。

## HTTP 端点（P4）

GET /__agent-alliance/state、sessions?provider=&query=、jobs；POST /__agent-alliance/dispatch。
webServer 可选注册（ctx.inject(['webServer']) 兜底），终端 profile 不挂。

## Web 面板（P4）

侧边栏 DOM 注入按钮（New Session 后、MutationObserver 自愈、data 标记防重挂）；
中央 React root：Provider 卡片/会话列表/任务状态/圆桌表单/导入入口；zh/en locale。

## 配置

~/.dsh/dsh-agent-alliance.json（先例 dsh-ssh.json）。默认：claude/codex/opencode enabled:true；
zcode enabled:false 且 commandTemplate 为空；defaults.timeoutMs=300000, maxConcurrent=3, defaultCwd=""。

## 全局约束

- node >= 22（node:sqlite）；ESM；零运行时 npm 依赖（仅 peerDep @deepseek-ai/dsh-tools）；
- 测试 node --test，fixture 驱动，不真调外部 CLI、不消耗额度；
- 外部存储一律只读；导入幂等（自带标记，不写 dsh-chat-import registry）;
- apply 抛错会拖垮 GUI 启动——注册全程防御性容错。

## 分期

P1 协同核心 → P2 圆桌 → P3 导入器 → P4 面板；每期真实 GUI 验证后进入下一期。
