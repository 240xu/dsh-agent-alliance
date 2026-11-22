# dsh-agent-alliance 0.2.0 验证记录

> 2026-11-06。环境：DSH（`@deepseek-ai/dsh`）`0.2.1-rc.2`，Node v22.20.0，Linux x86_64。
> 本文件只记录**本版本**的验证；0.1.0 时代的记录见下方「历史」小节，其中的契约描述已过期。

## 离线测试（无外部依赖、零额度）

```
node --test 'tests/*.test.js'
# tests 186 | # pass 186 | # fail 0
```

覆盖：backend 解析（17）、config 优先级与大声报错、http 信任校验与 `{ ok }` 信封、tools 的
JSON-Schema 参数与 job owner、importer 的 v4 事件流与 handle 调用顺序、provider×4 / parse / runner /
roundtable 的既有 fixture 套件、manifest 守卫。

零外部依赖校验：

```
grep -rn "@deepseek-ai/" index.js client.js src/ locale/     # 无输出
node -e "…package.json"                                       # dependencies: none, peerDependencies: none
```

## 真实宿主校验（关键）

全部用**已安装**的 0.2.1-rc.2 代码执行，不是 mock。

### 1. 会话事件流通过 v4 准入与关系校验

```
assertV4RowAdmission(event, KNOWN_SESSION_EVENT_TYPES)      # 每一行
assertReleasedV4Relationships(artifact, knownEventTypes)    # 全流
→ PASS
```

这一步专门证伪了 SPEC 初稿的三处错误（详见 `docs/SPEC-v2.md` 的「Three rules here are
enforced by the installed validators」）：`tool-result` 外壳被拒、`tool/call` 前必须有
`assistant/message` 广告、`text-chunks` 的 `dt` 长度必须是 `texts.length - 1`。

### 2. assistant stream 能被宿主展开

```
expandAssistantStream(event.data.stream)   # 3 条 assistant/message，全部接受
→ [{time, chunk:{type:'text-delta',…}}] / tool-call-delta
```

### 3. 模型可见消息投影正确

用 `deriveEventMessage` 逐事件投影，得到预期的 `user` / `assistant` / `tool` 三类消息，
`tool-call` 块与 `tool/result` 的 `role: 'tool'` + `toolCallId` 均正确。

### 4. 真实 JSONL 后端写入 → 校验 → 读回

```
new Context(); ctx.plugin(dsh-session-persistence-jsonl, {root})
handle = await svc.create({version:4,…})
await handle.append(events); await handle.flush(); await handle.close()
svc.open(id,'read').read(0)
→ 23 events 原样读回，类型顺序一致
```

读回路径会跑 header 校验、逐行准入、关系校验与尾部修复，因此这一条同时证明了导入落盘的完整性。

### 5. 插件在真实 Cordis 上挂载

```
ctx.plugin(dsh-system-prompt); ctx.plugin(ToolRuntime); ctx.plugin(plugin, {legacyConfigFile:false})
→ 6 个工具注册：agent_dispatch / agent_roundtable / agent_sessions /
                agent_session_read / agent_import_scan / agent_import
→ 每个工具 parameters 都是合法 JSON Schema（type/properties/required 齐备）
```

### 6. HTTP 面

```
webServer.register → 1 条 kind:'prefix' path:'/__agent-alliance'
GET /state → 200 {"ok":true,"providers":[…]}
GET /nope  → 404 {"ok":false,"code":"not-found"}
```

### 7. 生命周期归属

```
fiber.dispose() → 工具 6→0，路由 1→0
```

证明确实每个注册都经由 `ctx.effect()` 归属到插件 fiber，卸载即回收。

## 尚未验证（需要真实环境与额度）

- [ ] **官方子代理真实派发**：装上 `@deepseek-ai/dsh-subagent-codex` / `-claude-code` 后，
      用 `agent_dispatch` 发一条最小任务，确认返回值 `backend: "subagent"`。
      这是唯一需要真实额度的验证项。
- [ ] **CLI 包装层真实运行**：本机当前**没有**安装 `claude` / `codex` / `opencode` / `zcode`
      任何 CLI（`which` 全部为空），因此 `detect()` 会如实报告不可用；机制层的 argv/解析由
      fixture 测试覆盖，但未在本机跑过真实二进制。
- [ ] **Web 面板视觉确认**：`client.js` 已通过语法检查、manifest 守卫，并由作者在 jsdom + React 18
      下无头渲染验证（五标签、错误行重试、zh/en 均正常，无字面颜色、无 `react-dom`/`document.body`）；
      但未在浏览器里实际点验。
- [ ] **`ctx.connection` 真实信任校验**：无 connection 服务时按放行处理（有测试），
      未在带鉴权的实例上做过 401/403 的真实请求。

## 历史（0.1.0，2026-08-22）

以下记录保留作事故与经验参考。其中描述的 jobs `owner: Agent`、`sessionPersistence.append(id,events)`、
`assistant/chunk` 事件、ACP 桥挂载**均已失效**，请勿据此实现。

- 2026-08-21 web 连崩事故：先声明 `dsh.client` 却没有 client 入口 → 宿主 ENOENT 崩。
  修正后保留 `tests/manifest-guard.test.js` 作为崩溃向量守卫。
- 真实导入演练：opencode 会话 466 轮 / 9368 对 tool_call↔tool_result / 23197 事件。
- 工作区归组：59 轮真实会话导入后计入 `workspace.json`。
