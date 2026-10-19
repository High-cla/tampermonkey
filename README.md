# FX 简单! · 量化辅助台 v2.1.0

B站小游戏「FX 简单!」(<https://www.bilibili.com/toy/fx-simple/index.html>) 的 Tampermonkey 辅助脚本。
**模拟盘游戏**，不接任何真实资金。桌面（Chrome / Edge）与 Android（Chromium + Tampermonkey）通用。

## 架构：一个总线 + 八个互不引用的模块

v2.1 按单一职责把 Data（301 行）拆成 **data**（快照+触发源）与 **series**（序列+指标），
把 Ui（422 行）拆成 **ui**（面板+渲染）与 **input**（拖拽+断点+位置），模块间仍只经总线通信。

| 模块 | 行数 | 职责 |
|---|---|---|
| bridge | 153 | 双通道注入 + 工具句柄 + 存档读取（引用缓存） |
| store | 24 | 配置持久化 + 调试环 |
| data | 155 | 快照采集 + tick 计数 + 新闻识别 + 触发源 |
| series | ~140 | 序列获取（存档/采样/frankfurter）+ 指标缓存 + ctx 构建 |
| engine | 187 | 漂移/指标决策 + 风控退出 + 定量与敞口（凯利按引用缓存） |
| exec | 181 | 下单/平仓/推进日/弹窗白名单清扫/全平队列（DOM 引用缓存） |
| input | ~120 | Pointer 拖拽 + 断点检测 + 位置持久化 + 折叠状态 |
| ui | 325 | 面板 DOM + diff 渲染（含 CSS 与模板约 90 行） |

```
        ┌──────────────── bus（事件总线，独立实例）────────────────┐
        │  on(name, fn) / off / emit(name, payload)              │
        └───▲────────▲────────▲────────▲────────▲────────▲──────┘
            │        │        │        │        │        │
        bridge     store     data    engine    exec      ui
        （桥）    （配置）  （数据） （决策） （执行）  （面板）
```

- **模块之间零直接调用**：每个 `createXxx(bus)` 只 `bus.on(...)` / `bus.emit(...)`，函数体内不出现其他模块的标识符。
- **每个模块只暴露一个入口**：`init()`，返回 `{ dispose, debug }`；`debug` 仅供测试与兼容层使用。
- **纯函数库**（指标、漂移数学、汇率换算）无状态，可被任意模块使用，不算耦合。

`test-arch.mts` 静态校验这三条约束：模块互不引用、无跨模块 `debug` 访问、每个 emit 事件都有订阅者且每个订阅都有发布者。

### 事件契约（18 条，双向闭合）

| 事件 | 发布 | 订阅 | payload |
|---|---|---|---|
| `bridge:ready` | bridge | data/exec | `{ via, call, has, readSave }` |
| `bridge:blocked` | bridge | ui | `{ reason }` |
| `config:save` | ui | store | `{ patch }` |
| `config:changed` | store | data/engine/exec/ui | `{ cfg }` |
| `log:add` | 任意 | ui/store | `{ msg }` |
| `data:request` | exec/ui | data | — |
| `data:bar` | data | engine | `{ at, count }` |
| `data:snapshot` | data | engine/exec/ui | `{ snap, ctx }` |
| `news:changed` | data | engine | `{ news }` |
| `engine:plan` | engine | exec/ui | `{ plan }` |
| `engine:exits` | engine | exec | `{ exits }` |
| `series:ready` | series | engine/ui | `{ snap, ctx }` |
| `ui:mounted` | ui | input | `{ root, head }` |
| `ui:state` | input | ui | `{ collapsed, mobile }` |
| `exec:opened` | exec | engine | `{ position, plan }` |
| `exec:closed` | exec | engine | `{ position, reason }` |
| `ui:command` | ui | exec/engine | `{ cmd, value }` |
| `ui:sweep` | data | exec | — |

数据流：`bridge →(工具能力)→ data →(快照)→ series →(快照+ctx)→ engine →(计划+退出)→ exec`，失败一律经 `log:add` 汇到 ui，模块之间不互相 catch。

### 触发源：事件驱动 + 兜底

`MutationObserver` 监听游戏 render 改动的 `#pairTitle` / `#currentPrice` / `#positions` / `#equity` / `#cash`，
DOM 一变即采集（对齐游戏的 1.5s tick）；另有 500ms 定时兜底 —— 行情冻结（`riskPaused`）或回放暂停时 DOM 不动，仍需巡检。

## 移动端

| 项 | 做法 |
|---|---|
| 断点 | `matchMedia('(max-width: 720px)')` + `change` 事件，另监听 `visualViewport.resize`（软键盘） |
| 首次进入 | 默认折叠为 57px 标题条，**不遮挡下单区**；展开/折叠状态记入 `localStorage['fxq-fold']` |
| 拖拽 | Pointer Events（`pointerdown/move/up` + `setPointerCapture`），鼠标与触摸同一套代码 |
| 边界 | 拖拽与恢复位置都钳制在视口内；位置记入 `localStorage['fxq-panel-pos']` |
| 安全区 | `bottom: calc(12px + env(safe-area-inset-bottom))` |
| 尺寸 | `max-width: calc(100vw - 24px)`、`max-height: calc(100dvh - 24px)` |
| 触摸目标 | 移动端按钮 `min-height: 32px`、标题条 44px、`touch-action: none`（拖拽区）/ `manipulation`（按钮） |

实测（iPhone 13 视口 390×844）：折叠态 302×57 且不遮挡 `#longBtn`；展开态 302×511 完全在视口内；Pointer 拖拽位移正确并被边界钳制。

## 三引擎

| 引擎 | 适用 | 依据 | 实测 |
|---|---|---|---|
| **漂移引擎**（白盒） | 模拟行情 / 每日挑战 | 解析 `tickSim()` 的正弦漂移项 | 60 秒 8 笔，胜率 62.5%，权益 +22.7% |
| **前瞻引擎**（真先知） | 真实回放 / 经典战役（开「前瞻」） | 直接读 frankfurter 未来价 | 14 个交易日 6 笔 5 胜，权益 +18.6% |
| **指标引擎**（黑盒） | 无前瞻数据时兜底 | EMA/MACD/RSI/布林 五因子评分 | 随机游走里无 edge，仅作兜底 |

漂移引擎原理：`drift = sin(Date.now()/13000 + index*2 + marketIndex*0.7) * 0.00036` 完全可解析；
单 tick 被噪声（σ=0.121%）盖住，累积 10–27 tick 后达 0.3–0.6%，噪声只按 √n 长到 0.42%，方向命中率 74–80%。
持有期动态取 `argmax |漂移累积|/√H`（H∈[8,30]），比固定 H=12 高 53.8%。

### 前瞻引擎：为什么它之前反倒亏

游戏 real/battle 模式的价格就是 frankfurter 历史（`app.js:714` → `real.items[cursor].prices[pair]`），
所以拉同一份数据就能看到真实未来价。探针实测游戏价与 frankfurter 价的比值恒为 **1.000000**。

修复前三个缺陷叠加，让前瞻从未真正生效、或生效后反向磨损：

1. **区间错配**：原实现读 `#rangeStart`/`#rangeEnd` 输入框推区间，但游戏每次 render 用内部 `state.realRange` 覆盖输入框（`app.js:913`）→ `cursor = -1` → `future = null`，前瞻恒为 null。
   改为以 `snap.date` 为中心前后各拉 180 天，`cursor` 必然命中（实测 `129/252`）。
2. **开平不同源**：开仓用 `score*0.25 + 前瞻*75`，平仓仍读原始指标分 → 前瞻开多、指标喊跌 → 下一轮立刻「反转」平仓，反复摩擦。
   改为 `prepareFused(ctx)` 每轮算一次融合分数，开仓与平仓共用；前瞻改为方向确认（同向 ×1.3、反向 ×0.4），不再单方面覆盖指标。
3. **没有到期平仓**：前瞻看 3 天，但唯一持有期约束是 `timeStopBars = 20` 且只在亏损时触发 → 3 天后利润回吐。
   改为 `exitBars = barCount + horizon`，到期无条件平，且到期前跳过指标反转判据（否则真先知被滞后指标砍掉）。

前瞻引擎开仓条件：`|future[2]/prices[cursor] - 1| - (0.00005 + lev*0.000005) ≥ 0.15%`，持有 3 个交易日后平仓。

## 风控与定量

**漂移引擎**两条退出路径：零交叉反手（优先，剩余持有期已负期望就换向）+ 到期平仓；外加**止损随漂移强度缩放** `clamp(0.25 + |漂移|/0.15% × 0.05, 25%, 50%)`。
**前瞻引擎**：止损 40% / 到期平仓（3 个交易日，无条件）；到期前不看指标反转。
**指标引擎**：止损 40% / 止盈 90% / 反转（评分反向 ≥30）/ 时间止损（20 bar 未盈利）。

**定量（共用）**：半凯利（从游戏平仓记录在线估 p、b，夹在 [8%,25%]）；货币净敞口超「权益 × 5」按比例缩仓，缩后低于权益 2% 放弃；同品种同向 15 秒冷却，反手放行。

## 性能实测（Edge + CDP，15 秒全自动）

| 项 | 数值 | 说明 |
|---|---|---|
| JS 执行占比 | 0.1% 单核 | 不是瓶颈 |
| 主线程任务 | 0.2% | — |
| 布局 / 样式重算 | 0 / 0 ms | diff 渲染生效 |
| 堆内存 | 7.3 MB | — |
| `Math.sin` | 29.9/s | 正弦和用闭式解 + 和角公式查表（原 7 759/s） |
| `JSON.parse` | 0.9/s | 存档字符串引用未变即复用（原 19.3/s） |
| `toLocaleString` | 19.0/s | 复用 `Intl.NumberFormat` 实例 |

## 游戏规则（由 app.js 反推）

| 项 | 值 |
|---|---|
| 手续费 | `margin × leverage × (0.00005 + leverage × 0.000005)`，仅开仓 |
| 爆仓线 | `riskRatio = −pnl / margin`；≥0.6 弹窗并置 `riskPaused=true`（行情冻结），≥0.8 强平 |
| 解除冻结 | 只能关闭那个模态框 |
| 弹窗语义 | `modalCancel` 显隐 = 是否带 `modalAction`（会改账户状态） |
| 存档 | `localStorage['fx-heartbeat-save-v3'] = { mode, accounts, sim }`，每跳重写 |
| 历史数据 | `api.frankfurter.dev`，交叉汇率本地换算 |
| 挑战模式 | 每日 3 次，本金 $10,000，不可贷款，最多 5 仓 |

## 语言特性与 API 选型

**采用**（收益/成本比为正）：

| 特性 / API | 用途 | 收益 |
|---|---|---|
| `?.` 15 处 | 判空链 | 可读性；两处**故意保留** `a && a.b`（见下） |
| `catch {}` 20 处 | 可选 catch 绑定 | 省掉无用参数 |
| `Array.prototype.toSorted` | 信号排序 | 省一次 `slice()` 拷贝 |
| `Intl.NumberFormat` / `Intl.DateTimeFormat` 缓存 | 金额与时间格式化 | 每轮不再新建 formatter |
| `document.hidden` + `visibilitychange` | 后台降频 | 兜底 500ms → 2000ms，切回前台立即刷新（移动端省电） |
| 折叠态跳过渲染 | 面板折叠 | 只维护标题红点，跳过整段文本渲染 |
| `MutationObserver` | 事件驱动主源 | 对齐游戏 1.5s render，无需轮询 |
| `matchMedia` / `visualViewport` | 断点与软键盘 | 原生断点事件，无需监听 `resize` |
| Pointer Events + `setPointerCapture` | 面板拖拽 | 鼠标 / 触摸 / 笔同一套代码 |
| `AbortSignal.timeout` | 历史序列 fetch | 原生超时，无需手写 setTimeout 竞速 |
| `Array.at` / `Object.freeze` / getter | 只读视图与不可变常量 | 配置与契约不可被误改 |
| `Map` / `Set` | 缓存、冷却、去重 | O(1) 查表替循环 `find` |

**不采用**（明确理由，避免过度工程）：

| 特性 / API | 理由 |
|---|---|
| `EventTarget` / `CustomEvent` 替代自建 bus | 每次 emit 需 `new CustomEvent` + `detail` 包装；本脚本每 500ms 级联 3 条事件，40 行的同步回调 bus 更轻，且能保持 `emit(name, payload)` 形态 |
| `IntersectionObserver` | 目的是「不可见不渲染」，直接判断 `ui.collapsed` 即可，不必引入观察器 |
| `ResizeObserver` | 面板尺寸只随断点变化，`matchMedia` 已覆盖 |
| `requestAnimationFrame` 合批渲染 | 布局 / 样式重算实测 0 ms，无抢帧问题 |
| `requestIdleCallback` / `queueMicrotask` / `scheduler.postTask` | 决策与执行需要同步语义，异步化会引入时序 bug |
| `structuredClone` | 快照是显式构造的新对象，不需要深拷贝 |
| `WeakRef` / `FinalizationRegistry` | 缓存已有 TTL + 指纹，不需要 GC 感知 |
| `Object.groupBy` / `Map.groupBy` | 需要的是累加（`currencyNotional`）而非分组 |
| `flat` / `flatMap` / `replaceAll` / `findLast` / `Object.hasOwn` | 无对应场景，现有写法更直接 |
| `AbortController` | fetch 已有超时；切模式后旧请求自然失效 |
| `dialog` / `popover` | 面板在游戏 iframe 内，无需焦点陷阱 |
| `BroadcastChannel` | 无多标签同步场景 |
| `Element.animate` | CSS transition 已够 |
| 顶层 `await` | 油猴 IIFE 内不可用 |
| `BigInt` | 金额量级 $10^5，double 足够 |
| 私有字段 `#x` / 类 | 不用 class，模块用工厂 + 闭包 |

**两处故意保留 `&&` 而非 `?.`**（语言特性不能机械替换）：

```js
// ① 改 boll?.upper 后，条件为真时仍会访问 boll.lower —— boll 为 null 时抛错
const bollPos = boll && boll.upper > boll.lower ? (last - boll.lower) / (boll.upper - boll.lower) : 0.5;

// ② 改 sig?.side 后 undefined !== pos.side 恒为 true —— 会误触发反手平仓
if (sig && sig.side !== pos.side) { ... }
```

## 测试

单条命令：`node run-tests.mts` —— **约 55 秒**（同样的 9 个测试串行需要 277 秒，加速 5×）。

| 层 | 文件 | 内容 |
|---|---|---|
| 静态（并行，<1s） | `test-arch.mts` / `test-indicators.mts` / `test-drift-math.mts` | 8 模块互不引用与 18 条事件契约、指标与汇率换算、闭式解等价性 |
| 浏览器（单 browser + 两批 context 并行） | `test-all.mts` | 六场景 **42 条断言**：e2e / closeall / drift / automation / replay / mobile |

**并行策略**（为什么是两批而不是六路全开）：

- 单 `chromium.launch()` 共享浏览器进程，每个场景独立 `context`（localStorage / cookie 隔离），省掉 6 次 launch 与 6 次冷启动。
- 分两批：`drift + automation + e2e + closeall` 并行 → `replay + mobile` 并行。**六路全并行实测会把 bilibili 壳页与游戏 iframe 加载压垮**（`net::ERR_CONNECTION_CLOSED` / 面板未挂载）。
- 批内错峰 200ms 启动；`goto` 失败自动重试 3 次（指数退避）。
- 所有等待改为**条件轮询**而非固定 `sleep`：等 iframe、等面板挂载、等首次渲染、等持仓数变化。固定 8 秒在并发下必然抖动。
- 观察窗口压缩：drift / automation 30s（原 60s）、replay 8s（原 15s）。断言改为「有交易 + 退出路径被触发」，不依赖固定样本量。

单个 `test-e2e.mts` / `test-closeall.mts` / `test-drift.mts` / `test-automation.mts` / `test-replay.mts` / `test-mobile.mts` 保留用于细粒度调试（单独跑更快定位）。

## 已知限制

- **这是白盒套利**：利用 `tickSim` 的实现细节（不读未来、不改状态），真实市场不存在这种确定性。
- 脚本只自动清理**没有 `modalAction`** 的弹窗；带 action 的（重新开始 / 借款 / 还款 / 金盆洗手）一律留给玩家。
- 挑战模式的行情由 `challengeSim` 驱动且不存档：漂移引擎不需要 K 线即可交易，但指标区显示为空。
- 货币敞口按开仓瞬间的 equity 计算上限，浮盈会让 equity 上升，实测可能超出 0.6%。

## 文件

- `fx-quant.user.js` — 油猴脚本（可直接安装）
- `test-arch.mts` — 架构约束：模块互不引用、事件契约双向闭合、单一入口
- `test-mobile.mts` — 移动端：默认折叠、视口内、触摸目标、Pointer 拖拽、边界钳制、桌面恢复
- `test-drift.mts` / `test-drift-math.mts` — 漂移引擎行为与闭式解等价性
- `test-e2e.mts` / `test-closeall.mts` / `test-automation.mts` — 端到端、全平、自动化与安全边界
- `test-indicators.mts` — 指标与汇率换算（从源码抽取函数，零重复定义）
- `probe-*.mts` — 调研用探针（性能 / 移动端 / 漂移 / 事件日历）
- `panel.png` / `mobile-after.png` — 桌面与移动端实拍