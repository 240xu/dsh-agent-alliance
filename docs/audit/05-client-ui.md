# 审计 E — 客户端 UI、Slot、i18n、主题、UX

被审对象：`dsh-agent-alliance` 0.2.0（commit `e15fcf8`）
审计者：Lead（团队已达 8 人上限，本条线由 Lead 亲自执行）
方式：**机械核验为主**（脚本比对），不靠目测。所有命令与输出附在每条结论后。

> 关于验证边界：本机没有可交互浏览器控制，因此**视觉渲染、真实焦点行为、点击路径未经浏览器实测**。
> 下文凡涉及"看起来如何"的结论都明确标注为「静态推断」。可用后端渲染证据见仓库
> `docs/VERIFICATION-P1.md` 中客户端作者报告的 jsdom + React 18 无头渲染结果。

## 结论摘要

| 严重度 | 数量 | 说明 |
|---|---|---|
| critical | 0 | — |
| high | 1 | tablist 缺方向键导航，键盘用户只能逐 Tab 穿过 |
| medium | 2 | 轮询错误无退避；`/tasks` 轮询在任务页常驻 |
| low | 3 | 图标缺 `aria-hidden`；标题层级；`immediately: true` 的加载成本 |
| **通过项** | 8 类 | 见文末「机械核验通过项」 |

整体判断：**这份客户端代码质量高于第三方插件的平均水准**。0.1.0 时代的
`MutationObserver` + 自挂 `react-dom` root 反模式已彻底清除，i18n 与主题纪律是干净的。

---

## 通过项（机械核验，逐条给命令）

### P1. 无 react-dom / document.body / MutationObserver / createRoot 残留

```
$ grep -cn "react-dom\|document.body\|MutationObserver\|createRoot" client.js
0
```

1.0 → 2.0 重写确实清除了 2026-08-21 事故的根因形态。`document` 只出现 4 次，全部合法：
读取 `document.documentElement.lang` 判断语言（`client.js:333`、`client.js:416`），
以及在自己的 `ctx.effect` 里插入 `<style>`（`client.js:1259-1262`，带 disposer）。

### P2. i18n 键完全对齐

```
$ node -e "<提取 zh/en 字典并比对>"
zh keys: 98
en keys: 98
only in zh: []
only in en: []
identical: true
```

98/98 严格一致，没有单向缺失键。

### P3. 无 CJK 泄漏到 zh 字典之外

```
$ node -e "<切出 zh 块，在其余源码中匹配 [\u4e00-\u9fff]>"
CJK 片段数（zh 块外）: 0
```

即所有中文都收在字典里，没有散落在渲染代码中的硬编码文案。

### P4. 零字面颜色

```
$ grep -nE "#[0-9a-fA-F]{3,8}\b|rgb\(|rgba\(|hsl\(" client.js
（无输出）
```

### P5. 使用的主题令牌全部真实存在

```
$ grep -rhoE "\-\-dsw-(alias|elevation|focus)[a-z0-9-]*" packages/client/ui-theme/src/ | sort -u | wc -l
117                       # ui-theme 定义的全部令牌数
$ comm -23 插件使用的令牌 ui-theme 令牌
（无输出）                 # 插件用到的 13 个令牌无一臆造
```

用到的 13 个：`--dsw-alias-bg-base`、`-bg-layer-1/2`、`-border-l1/l2`、
`-label-primary/secondary/tertiary`、`-state-error/success/warn-primary`、
`--dsw-elevation-prominent`、`--dsw-focus-ring-color`。

### P6. `dsh.client.inject` 声明的包全部存在

```
$ node -e "<逐个检查 node_modules 目录>"
OK      @deepseek-ai/dsh-client-locale
OK      @deepseek-ai/dsh-client-ui-settings
```

两者都在 0.2.1-rc.2 中真实存在，不存在"声明了不存在的包导致启动崩"的风险。
（注意：0.1.0 曾引用 `@deepseek-ai/dsh-client-runtime`，该包在当前版本**已不存在**；本次已移除。）

### P7. 轮询定时器有完整清理

```
$ grep -n "setTimeout\|clearTimeout" client.js
490:  if (isActiveJob(page.job)) timer = setTimeout(tick, JOB_POLL_MS)
499:  if (timer !== null) clearTimeout(timer)
1099: timer = setTimeout(tick, LIST_POLL_MS)
1111: if (timer !== null) clearTimeout(timer)
```

两处轮询（任务输出 `useJobOutput`、任务列表）都用 `live` 标志 + effect 清理函数双保险：

```js
// client.js:496-500
return () => {
  live = false
  if (timer !== null) clearTimeout(timer)
}
```

`live` 标志同时拦住了"卸载后 setState"（每个 `.then` 开头 `if (!live) return`）。
没有 `setInterval`，只有自续期 `setTimeout` 链——这种写法本身就不易堆积。

### P8. 错误路径覆盖完整

`request()`（`client.js:354-377`）把所有失败归一成带 `status`/`code` 的 `Error`：

```js
if (!response.ok || payload === null || payload.ok !== true) { ... throw failure }
```

`failureMessage()`（`client.js:379-383`）再按优先级降级：服务端 message → HTTP 状态 → 通用文案。
每个数据 tab 都有 `ErrorRow` + retry（`client.js:523-527`，用到 567/656/765/773 行）；
写操作（dispatch/roundtable/import/kill）失败走 `setNotice({tone:'error', retry})`，
渲染成带重试按钮的 ErrorRow（`client.js:699-700`、`client.js:830`）。

**不存在"空白页/死视图"路径**：最差情况是显示一行可重试的错误。

### P9. 双击提交防护

派发与圆桌都用 `busy` 状态禁用按钮（`client.js:799`、`857`、`866`）；
导入用按行 `busy`（`client.js:710`、`732-734`，文案切到 `sessions.importing`）。
共 18 处 `disabled` 绑定。

---

## 发现

### F1 (high) — `tablist` 缺方向键导航，键盘可达性不达标

`client.js:1224-1232` 声明了 ARIA tab 语义，但只做了点击：

```js
h('div', { className: 'aall_tabs', role: 'tablist', 'aria-label': t('a11y.tabs') },
  tabs.map((name) => h('button', {
    type: 'button', role: 'tab', 'aria-selected': tab === name ? 'true' : 'false',
    onClick: () => setTab(name),
  }, t('tab.' + name)))),
```

```
$ grep -n "ArrowRight\|ArrowLeft\|onKeyDown\|tabIndex" client.js
（无输出）
```

**用户看到什么**：用键盘的访客按 Tab 进入 tablist 后，必须**再按最多 4 次 Tab** 才能到达
目标标签，而不是用左右方向键。这对 `role="tablist"` 是 WAI-ARIA 的既有契约违背：
声明了 tablist/tab 角色，就应当实现 roving tabindex + 方向键。

**影响**：不算功能故障（点击与 Tab 都能用），但对无障碍是真实缺陷；声明 role 却不实现键盘
语义，比不声明更糟——辅助技术会按 tablist 预期播报，用户按键却无反应。

**修复**（约 15 行）：tablist 上挂 `onKeyDown` 处理 ArrowLeft/ArrowRight/Home/End，
切换时 `setTab` 并把焦点移到新激活的 tab；未激活 tab 设 `tabIndex: -1`，激活项 `tabIndex: 0`。

### F2 (medium) — 轮询失败无退避，故障期持续打点

`client.js:1099-1106`：`/tasks` 轮询无论成功失败都**立即**排下一次：

```js
}, (error) => {
  if (!live) return
  setList(...)
  timer = setTimeout(tick, LIST_POLL_MS)   // ← 失败也照排
})
```

`useJobOutput`（`client.js:491`）在失败路径 `setState({..., error})` 后**不再续期**（合理：
停止轮询），但 `/tasks` 这一处会以 `LIST_POLL_MS` 恒定频率重试。

**用户看到什么**：宿主重启或后端报错时，面板每 `LIST_POLL_MS` 就打一次 `/tasks`，
在故障窗口内持续制造请求与错误渲染。不会崩，但属于可避免的压力。

**修复**：失败分支做指数退避（例如 `min(base * 2**failures, 30s)`），成功一次后重置。

### F3 (medium) — `/tasks` 轮询在非任务页也常驻

任务列表轮询挂在 `TasksTab` 的 effect 上（`client.js:1090-1114`）。该 tab 一旦访问过，
只要停留在其上就会持续轮询；切到别的 tab 会卸载并清理（这一点是正确的），
但**每次切回都从 `attempt` 重置**，没有缓存。

**用户看到什么**：任务页首次打开总要先空转一轮；频繁切 tab 会产生重复请求。

**修复**：把任务列表状态提升到面板级（或用一个轻量 store），切 tab 不重取；
或至少在 `attempt` 未变时复用上次结果。

### F4 (low) — 侧边栏图标缺 `aria-hidden` / 可访问名

```
$ grep -c "aria-label" client.js
2
```

图标组件（`client.js:1236+`）返回裸 `<svg>`，没有 `aria-hidden="true"`，也没有
`<title>`。侧边栏标签文字由 slot 的 `label` 提供，所以功能上可辨识，
但纯装饰性 SVG 未标记隐藏，部分读屏器会播报一个无名图形。

**修复**：`h('svg', { ..., 'aria-hidden': 'true', focusable: 'false' })`。

### F5 (low) — 标题层级与区域语义

`client.js:1218-1233` 的结构是 `div.aall_page > div.aall_shell > header + div.aall_body`，
`header` 里有 `<h1>`（`client.js:1221`，标题取自 `t('panel')`）。
作为 `main` slot 的整页内容，缺 `<main>`/`role="main"` 语义；`h1` 与宿主其他
页面标题会并列出现在同一次点按遍历中。

**影响**：轻微。宿主是否已在 `main` slot 外层提供 `<main>` 未经确认（静态推断，未验证）。

**修复**：确认宿主外层语义后再决定；若宿主未提供，用 `role="region"` +
`aria-labelledby` 指向 `h1`。

### F6 (low) — `immediately: true` 的代价

`package.json` 声明 `dsh.client.immediately: true`。含义是该 client bundle 在页面启动时
即加载并激活，而非首次使用时才加载。

对"面板型"插件这是合理的（用户希望侧边栏入口立刻出现），但代价是**每次页面加载**都要
解析这份约 1260 行的 bundle。若未来 bundle 明显变大，可考虑改为按需加载
（`immediately` 省略），代价是入口图标首次出现会略慢。

**当前判断：维持现状**。记录在此仅为让这个权衡是显式的，而不是无意的。

---

## 未能验证的部分（需要浏览器）

以下 3 项**没有**在真实浏览器里验证过，不应被视为通过：

1. **视觉渲染**：布局在 320px 窄侧栏、浅色主题、高 DPI 下的实际观感。
2. **焦点行为**：`focus-visible` 样式（`client.js` 中 5 处）在真实 Tab 遍历下的可见性。
3. **交互路径**：派发/圆桌/导入/取消的完整点击链路与宿主的 toast/dialog 叠加关系。

已有的替代证据：客户端作者报告在 jsdom + React 18 下渲染了真实 bundle，验证了
五标签渲染、错误行重试实际重新取数、zh/en 均无泄漏键、以及无字面颜色。
这覆盖了逻辑层，但不覆盖像素与焦点。

## 建议的处置顺序

1. **F1**（high）——唯一影响可访问性的实质缺陷，约 15 行。
2. **F2**（medium）——故障期退避，约 5 行。
3. F3、F4 随下次迭代。
4. F5、F6 记录在案，暂不动。
