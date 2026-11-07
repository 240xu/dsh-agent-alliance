# A1 — 对抗性复核：三条 claim 的驳回尝试

> 角色：ADVERSARIAL AUDITOR A1。任务不是复述结论，而是**尽力证伪**。
> 对象：`/home/ova/dsh/.artifacts/dsh-plugins/dsh-agent-alliance`，commit `2d68e3f`（审计基线 `e15fcf8`），版本 0.2.0。
> 被复核的 claim 出自 [docs/audit/00-REPORT.md](../audit/00-REPORT.md) 的 C1 / C2 / C4。
> 本文件是唯一写入；源码零改动。
>
> 状态：进行中（本文件按下述顺序增量落盘，网络中断不丢已完成部分）
> 1. Claim A — `jobs.start()` 在无 controller 时恒抛
> 2. Claim B — `/state` 谎报 `available: true`
> 3. Claim C — 圆桌第 2 轮与第 1 轮零前缀共享
> 4. 新缺陷 — 比上述三条更严重、且前一轮审计遗漏
> 5. 复核方法与被驳回的「我自己的猜想」

---

<!-- SECTIONS BELOW ARE APPENDED AS EACH VERDICT IS REACHED -->
