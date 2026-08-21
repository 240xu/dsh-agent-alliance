# P1 验证记录

## 离线（已完成）

- node --test 全量：47/47 通过（config/runner/parse/provider×4/factory/tools/apply）
- 真实探测（仅 --version，零额度）：claude OK 2.1.232 / codex OK 0.148.0 / opencode OK 1.18.18 / zcode 按设计关闭
- profile 安装：file: 依赖 + bundle 追加完成；从 profile 目录 import('dsh-agent-alliance') 成功

## 在线（重启宿主后执行）

- [ ] 新会话工具列表出现 agent_dispatch / agent_sessions / agent_session_read
- [ ] agent_sessions ×3 家各返回历史会话列表（只读，零额度）
- [ ] agent_session_read 抽取一家会话内容（只读，零额度）
- [ ] agent_dispatch 最小探针：每家一条「回复一个词：ok」级别任务（消耗少量额度，需用户同意）
      - 校验 parse.js 与真实输出一致；不符则回修 parse+fixture
- [ ] 后台模式：background:true 返回 jobId，job_output 可读，job_kill 可停
- [ ] 续聊：dispatch 带 resumeSessionId 二轮对话上下文连贯
- [ ] 结果记录到本文件

## 已知事项

- codex 输出解析按容错策略实现（人类可读输出末段），在线探针后如不符再修
- opencode --format json 事件形状按 NDJSON part 流实现，同上
- zcode 协同为模板占位（官方无公开无头规范）；导入器在 P3 按 db.sqlite schema 实现

## 事故复盘（2026-08-21 16:35–17:00 web 连崩）

**责任链（我的错误）**：
1. P1 尚未实现 client 半边，却在 package.json 提前声明了 `dsh.client` + `exports["./client"]`；
2. 把插件加入共享 profile 的 bundles 前没有做「带插件启动」验证——宿主启动读取
   client/index.js（不存在）→ ENOENT → 整个 web 进程崩溃，且反复重启反复崩；
3. 违反了「不静默动共享 3080 实例」的协作约定（虽然未主动 kill，但装包即影响下次重启）。

**修正（本次提交）**：
- 移除整个 client 声明面，P1–P3 回归 host-only 形态（根因消除，而非占位糊弄）；
- 新增 tests/manifest-guard.test.js 崩溃向量守卫：未来 P4 重新声明 client 面时，
  必须同时存在含 __ModuleLoader__.load 与 apply 的完整入口，否则测试红；
- 手动同步安装副本（pnpm 对 file: 目录依赖在 up-to-date 时不会重拷——教训）；
- 移除 opencode 应救会话加的 TEMP disabled 块；dump-config 离线校验通过。

**采纳的流程约定（来自事故报告）**：
1. 进 bundles 前必须先本地起一次验证；
2. 不静默 kill/重启共享 3080 实例，重启前知会；
3. 崩溃现场看 ~/dsh-web-3080.log 尾部栈 + ~/.dsh/monitor/dsh-web-monitor.log。

## 进度更新（同日稍后）

- **P2 圆桌完成**：runRoundtable 并发扇出+失败隔离+格式化；agent_roundtable 工具（默认后台 job）
- **P3 导入器完成（代码级）**：
  - convertToDshEvents：外部会话→DSH 事件流（schema 从真实 session.jsonl.zstd 多帧采样固化；
    多帧 zstd 用 magic 切帧+node zlib 逐帧解码，与 fzstd 等效，零依赖）
  - 四家 exportSession（claude 含工具配对；codex/opencode/zcode 文本级）
  - persist：agents.create 优先 / sessionPersistence 回退；台账 imports.json 幂等
  - agent_import_scan / agent_import 工具接入（共 6 工具）
- **实测发现并修复**：工具输出含 undefined 违反宿主无损 JSON 契约 → lossless() 消毒（live-test finding）
- 测试 74/74；安装副本已同步

## 待办

- [ ] 协调重启：激活 6 工具（运行中实例仍是 4 工具旧版）
- [ ] 在线验证：import_scan 真实扫描 + import 一条真实会话 + dispatch 探针（需额度同意）
- [ ] P4 Web 面板（client 入口须过 manifest-guard 守卫测试）
