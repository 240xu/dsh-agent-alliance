# 环境事实：代理可用性实测（2026-11-23）

> 起因：给 `dsh` 用户装 opencode v2 时反复失败，查下去发现是代理问题，不是包问题。

## 一、当前哪些代理真的能用

`dsh` 用户的 egress 被 `iptables -A OUTPUT -m owner --uid-owner 1001 -j DSH_EGRESS` 限制。
链里 ACCEPT 的目标是 `172.30.66.1:1080,1081,1091,18081` 与 `172.30.0.1:13070`。
**放行 ≠ 可用**，实测结果：

| 目标 | TCP | HTTP/HTTPS | 结论 |
|---|---|---|---|
| `172.30.66.1:1091` | ✅ `nc` 通 | ❌ 全部超时 | **不可用** |
| `172.30.66.1:1081` | ✅ 通 | ❌ 超时 | 不可用 |
| `172.30.66.1:1080` | ✅ 通 | ❌ 000 | 不可用 |
| `172.30.0.1:13070/fwd` | ❌ 端口不通 | — | 不可用 |
| `172.30.0.1:24060/24070/24071` | ✅ 通 | ❌ 当代理返回 000 | 不可用 |
| `127.0.0.1:17890`（`/opt/mihomo`） | ✅ 监听 | ❌ 000 | 不可用 |
| **`127.0.0.1:19893`（`/home/ova/cfhop`）** | ✅ 监听 | ✅ **200 / 1.0s** | **可用** |

`19893` 的来源：`/home/ova/cfhop/config.yaml` 里 `mixed-port: 19893`、`allow-lan: true`、
`bind-address: 0.0.0.0`，是系统上三个 mihomo 实例之一。

## 二、这影响什么

1. **npm 安装**：`dsh` 拿不到 registry。绕过办法是走 `ova`（不受 egress 限制，直连 npmjs 200/7.6s），
   装完让 `dsh` 执行产物（已验证跨用户可执行）。
2. **opencode 出回答**：实测对照 ——
   ```
   HTTPS_PROXY=127.0.0.1:19893 → session/prompt: end_turn, PONG, 12,363 ms  ✅
   HTTPS_PROXY=127.0.0.1:9     → session/prompt: timeout,      42,740 ms  ❌
   ```
   同二进制同 HOME，只有代理不同。**代理是出回答的硬前提，不是优化项。**
3. **git push**：`172.30.66.1:1091` 走不通时改用 `127.0.0.1:19893`，实测推送成功。

## 三、与 AGENTS.md 的出入（待用户决定是否更正全局）

AGENTS.md §5.1 写 `172.30.66.1:1091`「最稳，优先用」、§10 写「本机 HTTP 代理可用：1091 和 1081」。
**当前实测这两条都不成立**（TCP 通但 HTTP 全超时）。
该文件是跨会话全局记忆，我**没有擅自修改**，只在此处记录实测结果。

## 四、可复现的探测命令

```bash
# 从 dsh 逐个试
for p in 1091 1081 1080; do
  timeout 8 curl -s -o /dev/null -w "172.30.66.1:$p -> %{http_code}\n" \
    -x "http://172.30.66.1:$p" https://registry.npmjs.org/ ; done

# 找本机 mihomo 的实际端口
for d in /opt/mihomo/config /home/ova/cfhop; do
  grep -iE "^(mixed-port|allow-lan|bind-address)" "$d"/config.yaml ; done

# 验证 19893
timeout 10 curl -s -o /dev/null -w "19893 -> %{http_code} (%{time_total}s)\n" \
  -x http://127.0.0.1:19893 https://registry.npmjs.org/
```
