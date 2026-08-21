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
