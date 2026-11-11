# 实机验证报告 — 运行中的 web profile

> 日期：2026-11-11
> 目标：在**活着的 web profile**（非临时 Cordis Context、非单元测试 mock）上逐层验证插件
> 运行环境：`dsh web` pid 3751811，bundle 来自 `/home/dsh/.dsh-exp022/runtime/`（0.2.2-rc.1）

## 验证方法

GUI 鉴权是签名 cookie，不是静态 header。按官方 `dsh-client-connection` 的流程，
从 `/home/ova/re-agent/dsh-web.log` 取当次启动的 `?token=`，用 `/?token=...` 换
`set-cookie`（303），后续所有请求带该 cookie。token 每次重启轮换，不写入本文件。

---

## 一、逐层结果

### L1 运行中 Agent 的工具可见性 — PASS

`Tool.listTools`（host inspect）返回的工具列表里，6 个 `agent_*` 工具全部在位：

```
agent_dispatch / agent_roundtable / agent_sessions / agent_session_read
agent_import_scan / agent_import
```

描述是定位收窄后的版本（"EXTERNAL"、明确指向 `subagent` / `subagent_fork`），
`agent_dispatch.parameters.required = ["prompt"]`。
这是**当前会话的模型真实可见的工具集**，不是测试里的 fake registry。

### L2 Host 插件行状态 — PASS

`plugin_manager list_plugins`：
```
entryId: include:agent-alliance
moduleName: dsh-agent-alliance
enabled: true, fiberPhase: active, patchId: agent-alliance
```

### L3 真实 HTTP 路由（带认证） — PASS

| 路由 | 结果 |
|---|---|
| `GET /__agent-alliance/state` | **200** `{"ok":true,"providers":[...],"recentDispatches":[]}` |
| `GET /__agent-alliance/tasks` | **200** `{"ok":true,"tasks":[]}` |
| `GET /__agent-allianceX/state` | **404** —— prefix 路由不误匹配 |
| `GET /__agent-alliance/nope` | **404** |
| 无 cookie 访问 `/state` 与 `/dispatch` | **401**（webserver 前置鉴权） |

`/state` 里 `zcode` 被正确隐藏（`enabled:false` 的展示层过滤生效），
三家 `available:false` 的 `detail` 是官方化分类格式，无原始 stderr。

### L4 真实派发到缺失的 CLI — PASS（并发现缺陷 1）

```
POST /__agent-alliance/dispatch {"provider":"claude","prompt":"say hello"}
→ 502 {"ok":false,"error":"External CLI failure (product: claude; stage: dispatch;
       category: unknown; exit code: -1)","code":"dispatch-failed"}
```

**首次实机暴露的分类缺陷**：`codex` 报 `category: service`。查明原因是 node 栈帧里的
`loader:1568` 被 `/5\d\d/` 误读为 HTTP 503。修复后（见下）三家统一 `product-error`。

### L5 Client 模块 — PASS（DOM 渲染未验证，见边界）

GUI `index.html` 的 `__DSH_BOOT__` 里明确注册了 client 模块：
```json
{"id":"dsh-agent-alliance","url":"plugins/??dsh-agent-alliance/client.js&rev=85bc43869abc",
 "inject":["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-settings"],
 "immediately":true}
```
按该 URL 取回 `client.js` → **HTTP 200 / 68646 字节**，内容含 `__ModuleLoader__`、
`sidebar.panellist` 槽位注册、"Agent 协同" 标签。

### L6 生命周期（3 次热重载） — PASS

用 `plugin_manager set_plugin` 对 `include:agent-alliance` 做 disable→enable 往返 3 次，
每次 `application: applied`。每轮之后工具、路由、诊断分类都正确重建，无残留注册。

---

## 二、实机发现并已修复的两个缺陷

### D1 — 栈帧行号被误判为 HTTP 5xx

- **现象**：真实 `codex` 派发返回 `category: service`（应是安装失败）
- **根因**：`classifyCliFailure` 的 `/5\d\d|service unavailable/i` 命中 node 栈帧
  `at Module._resolveFilename (node:internal/modules/cjs/loader:1564:15)` 里的裸数字
- **修复**（`src/diagnostic.js`）：`ENOENT` / `Cannot find module` / `command not found`
  优先归 `product-error`；5xx 必须带 HTTP 语境（`HTTP 503`、`503 service unavailable`）
- **实机复验**：热重载后 `/state` 与四家派发的 `detail`/`error` 全部 `product-error`

### D2 — 面板前台圆桌被 503 挡死

- **现象**：`{"background":false}` 的 `/roundtable` 也返回 503 `jobs-refused`
- **根因**：HTTP handler 无条件在 `ctx.jobs` 存在时调 `jobs.start`，**没读** `background` 参数。
  第四轮把 `start()` 拒绝改成 fail-loud 后，这个被忽略的参数就变成了真实回归——
  在没有 job controller 的组合里，前台圆桌完全不可用
- **修复**（`src/http.js`）：`background !== false` 才查 jobs 服务
- **实机复验**：
  - 前台 `background:false` → **200**，返回两家格式化文本
  - 后台 `background:true` → **503 fail-loud**，点名 `@deepseek-ai/dsh-tool-jobs`
  （第四轮对齐没被破坏）

两个修复都在**活 Host** 上通过 disable/enable 热重载后复验，不是只跑单元测试。
提交 `f216ea3`，已推送。

---

## 三、验证边界（如实记录）

1. **Client 面板的 DOM 渲染未验证**。`Slots.listSubTree` 返回
   "Client inspect query Slots.listSubTree has no connected Harness page"——
   当前没有连接着的浏览器页面。已能证明的是：boot 注入了模块、client.js 可取回、
   内容含槽位注册。**「侧边栏里肉眼可见」需要在你刷新 GUI 页面后确认。**
2. **无真实外部 agent 可用**。`claude`/`codex`/`opencode`/`zcode` 四个 CLI 全 MISSING，
   两个官方 bundle `availability: missing`。所以派发验证的是「缺失时的诊断行为」，
   **不是「成功派发到真实 agent」**。要验证成功路径必须先装一个 CLI 或启用官方包。
3. **后台 job 成功路径未验证**。此 profile 的 `tool-jobs` 在 host plane 被禁用，
   后台派发按设计 fail-loud。要验证成功路径需在 agent preset 内启用 controller。

## 四、最终状态

```
远端/本地 main: f216ea3（已推送）
测试: 231 pass / 0 fail
工作树: 0
Host 插件: enabled / fiberPhase active / 已热重载 3 次
```
