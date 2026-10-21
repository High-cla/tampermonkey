# FX 简单! · 量化辅助台 v2.5.0

B站小游戏「FX 简单!」(<https://www.bilibili.com/toy/fx-simple/index.html>) 的 Tampermonkey 辅助脚本。
**模拟盘游戏**，不接任何真实资金。桌面（Chrome / Edge）与 Android（Chromium + Tampermonkey）通用。

## 架构：一个总线 + 八个互不引用的模块

v2.1 按单一职责把 Data（301 行）拆成 **data**（快照+触发源）与 **series**（序列+指标），
把 Ui（422 行）拆成 **ui**（面板+渲染）与 **input**（拖拽+断点+位置），模块间仍只经总线通信。

v2.3 只动边界、不动交易阈值：未来数据隔离、配置启动顺序、统一敞口闸、开仓回读核验、受管仓位范围。
v2.4 补生命周期：模块可卸载、在途请求可取消、异步工具接口明确失败。
v2.5 按全参数回测调整三个默认值：`STOP_RATIO` 0.40→0.20、`LOOKAHEAD_HORIZON` 1→5、`DRIFT_MAX_BARS` 30→20。

| 模块 | 行数 | 职责 |
|---|---|---|
| bridge | 162 | 同 world 直挂 polyfill（沙盒模式才退回注入）+ 工具句柄 + 存档读取（引用缓存） |
| store | 24 | 配置持久化 + 调试环（初始广播交给引导层，避免订阅前丢事件） |
| data | 155 | 快照采集 + tick 计数 + 新闻识别 + 触发源 |
| series | 181 | 序列获取（存档/采样/frankfurter）+ `historyView` 未来隔离 + 指标缓存 + ctx 构建 |
| engine | 266 | 漂移/指标决策 + 统一敞口闸 + 受管仓位退出 + 定量（凯利按引用缓存） |
| exec | 193 | 下单 / 回读核验 / 平仓 / 推进日 / 弹窗白名单清扫 / 全平队列（DOM 引用缓存） |
| input | 135 | Pointer 拖拽 + 断点检测 + 位置持久化 + 折叠状态 |
| ui | 361 | 面板 DOM + diff 渲染（含 CSS 与模板约 90 行） |

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
| `config:changed` | store / 引导层（初始一次） | data/engine/exec/ui | `{ cfg }` |
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

### 正确性边界（v2.3）

五条不变量，任何调参都不能绕过：

| 边界 | 实现 | 回归测试 |
|---|---|---|
| **未来隔离** | `historyView(series)` 按 `cursor` 截断价格与 K 线；`future` 只给前瞻引擎 | 改 `cursor` 之后的价格，评分必须不变 |
| **配置必达** | store 不在 `init` 里广播；引导层在八个模块订阅完成后才 `emit(config:changed)` | 存储 5×/固定 5% 必须传到 engine/exec/ui |
| **敞口闸** | `applyExposure` 被 drift / lookahead / indicator 三引擎共用；首仓（原敞口为 0）同样受限 | 权益 $10,000、上限 5× → 首仓名义 ≤ $50,000 |
| **执行核验** | `commit()` = 下单 → `read_fx_game_state` 回读 → 确认持仓才发 `exec:opened` | 回读无持仓时不得登记风控 |
| **受管范围** | `managed` 集合只装脚本开出的仓位；手动仓位需点「接管」才纳入自动风控 | 手动仓位不自动处置，接管后按止损退出 |

「自动开仓：关」的语义是**只禁止自动开仓**，自动风控继续工作；面板标签已从「自动化」改为「自动开仓」消除歧义。

### 生命周期（v2.4）

`__FXQ__.dispose()` 卸载：逐个调用八模块的 `dispose()`，清掉定时器、`MutationObserver`、`matchMedia` / `visualViewport` 监听，`AbortController.abort()` 取消在途历史请求，最后删掉 `__FXQ_BOOTED__` 让脚本可被重新注入。重复调用幂等。

`bridge.call()` 检测工具返回 Promise：原生 WebMCP 规范里 `execute` 是异步的，而当前决策链是同步的。遇到 thenable 一律返回 `failed` 并记日志，**不会把 Promise 当数据用**——这条为将来接原生 `executeTool` 留出明确失败面。

**实测请求不是瓶颈**（`probe-fetch.mts`，真实 Edge 回放）：推进 90 个交易日、77 秒，只发出 **1 次** frankfurter 请求（`historyKeys` 1→2，仅 TTL 到期重拉一次）；7 个品种共享同一份 EUR-base 数据，**0 次重复请求**。所以没有引入请求去重或缓存上限——现状已够，加了只是多余实体。

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

前瞻引擎开仓条件：`|future[H-1]/prices[cursor] - 1| - (0.00005 + lev*0.000005) ≥ 0.05%`，持有 `LOOKAHEAD_HORIZON` 个交易日后**无条件**平仓（当前 H=5）。

### 参数扫参：前瞻三参数里两个在回测中无效

`sim/` 目录是一套离线回放器：把 `planLookahead` / `computeExits` / `sizePosition` / `exposureScale` / `kellyFraction`
逐行复刻成纯函数（对照 `app.game.js:724/730` 与 `fx-quant.user.js:338/948/957/1023`），
配 2015-2026 共 3021 个交易日的 frankfurter 数据，1170 组参数在 3.8 秒内跑完。

**结论一：`LOOKAHEAD_MIN_NET` 在 0.0015~0.005 区间完全无效。**
真实游戏 26 天对照，0.0015 / 0.002 / 0.003 / 0.005 四档终值**完全相同**（14117，+41.2%）。
因为 `bias` 是 3 天累积波动，7 个品种取最大值，几乎总是远超 0.5%；门槛直到 0.01 才开始起作用（+30.1%），0.02 直接停止交易（-0.3%）。

**结论二：`LOOKAHEAD_SCALE` 完全无效。** `strength = clamp(net / scale, 0.4, 1)`，而 `net` 通常 > 0.004，
所以 `strength` 恒为 1 —— 扫参里 scale 从 0.002 到 0.010，结果一模一样。

**结论三：`LOOKAHEAD_HORIZON` 只有 3 是局部最优，但差异大半是路径噪声。**
真实游戏 26 天对照：H=3 **+41.2%** / H=10 +39.9% / H=4 +37.7% / H=6 +36.7% / H=5 +31.1% / H=8 +20.5% / H=2 +19.2%。
排序非单调（H=8 最差而 H=10 又回升）说明差异来自「不同 H 选到不同品种 → 不同路径」，不是稳定的 edge。保持 3。

**方法论教训**：先做了 Node 复刻 + 浏览器逐日对比，结果终值差 35%（25549 vs 18922）。
逐笔日志定位到两个偏差源：① 真实游戏里快照到达时退出尚未执行，所以 `plan` 用的是**旧持仓**；
② `ENTRY_COOLDOWN_MS = 15000` 在 800ms/天 的自动推进下等于**约 19 天同向冷却**，复刻最初漏了它。
两处修正后趋势一致，但绝对值仍偏高（H=1 复刻 71x vs 实测 57%）——
**离线复刻能筛参数趋势，不能替代真实游戏验证**。

## 风控与定量

**漂移引擎**两条退出路径：零交叉反手（优先，剩余持有期已负期望就换向）+ 到期平仓；外加**止损随漂移强度缩放** `clamp(0.25 + |漂移|/0.15% × 0.05, 25%, 50%)`。
**前瞻引擎**：止损 40% / 到期平仓（3 个交易日，无条件）；到期前不看指标反转。
**指标引擎**：止损 40% / 止盈 90% / 反转（评分反向 ≥30）/ 时间止损（20 bar 未盈利）。

**定量（共用）**：半凯利（从游戏平仓记录在线估 p、b，夹在 [8%,25%]）；货币净敞口超「权益 × 5」按比例缩仓，缩后低于权益 2% 放弃；同品种同向 15 秒冷却，反手放行。

### 可调参数

**面板可调**（点击循环，存 `localStorage['fxq-config-v1']`）：

| 参数 | 默认 | 档位 | 作用 |
|---|---|---|---|
| 自动开仓 | 关 | 关 / 确认 / 自动 | 关 = 不自动开仓（**自动风控仍生效**）；自动 = 自动开仓 |
| 杠杆 | 30× | 5/10/20/30/50/100 | 名义敞口与手续费 |
| 风险 | 凯利 12% | 凯利 → 5/10/12/15/20/30% | 单笔保证金占权益 |
| 前瞻 | 关 | 开关 | real/battle 使用未来价 |
| 止盈 | 90% | 50/70/90/120/150% | 指标引擎止盈线 |
| 反转 | 30 | 20/25/30/40/50 | 指标引擎反转退出阈值 |
| 时间止损 | 20 | 10/15/20/30/50 | 指标引擎 N bar 未盈利离场 |
| 并发 | 4 | 2/3/4/5 | 同时持仓上限 |

**硬编码**（改需动源码常量区）：

| 常量 | 值 | 作用 |
|---|---|---|
| `STOP_RATIO` | **0.20** | 止损线（漂移仓按强度在 0.25~0.50 间动态）；全参数回测：0.2 的平均净利是 0.4 的 5 倍，5/5 窗口更优 |
| `STOP_MIN` / `STOP_MAX` | 0.25 / 0.50 | 漂移仓动态止损区间，上限避开游戏 0.6 冻结线 |
| `DRIFT_MIN_SUM` | 0.0015 | 漂移累积开仓阈值 |
| `DRIFT_MIN_BARS` / `DRIFT_MAX_BARS` | 8 / **20** | 持有期搜索范围；统一回测：20 比 30 平均 +7.4%、最差仍 +5.8% |
| `LOOKAHEAD_HORIZON` | **5** | 前瞻天数。全参数回测（STOP=0.2，5 窗口）：H=5 中位数最高（$233K vs H=1 的 $21K）、3/5 窗口最优。最优 H 会在 1/3/5 间跳变，属路径依赖 |
| `LOOKAHEAD_MIN_NET` | 0.0005 | 前瞻扣费后最小净空间（回测：0.05% 年化 1425%，0.15% 只有 1162%） |
| `ENTRY_COOLDOWN_MS` / `_FAST_MS` | 15000 / 1000 | 同品种同向重进冷却：sim 1.5s/tick 用 15s，real 800ms/天用 1s |
| `LOOKAHEAD_BOOST` / `LOOKAHEAD_CONFLICT` | 0.3 / 0.4 | 前瞻与指标同向放大 / 反向削弱 |
| `MAX_CCY_NOTIONAL_MULT` | 5 | 单一货币净名义上限（权益倍数） |
| `KELLY_FRACTION` | 0.5 | 半凯利系数 |
| `SIGNAL_THRESHOLD` / `SIGNAL_STRONG` | 30 / 55 | 指标评分开仓 / 强弱分界 |
| `SCORE_WEIGHTS` | 30/20/20/15/15 | 五因子权重（和为 100） |
| `IND` | 12/26/9/40/14/14/20/2/10 | EMA / MACD / RSI / ATR / BOLL / ROC 周期 |

**工程参数**（不建议暴露）：`FALLBACK_MS` 500、`BACKGROUND_MS` 2000、`SWEEP_MS` 1500、`ACTION_COOLDOWN_MS` 2500、`DAY_ADVANCE_MS` 800、`SERIES_TTL_MS` 60000、`SAMPLE_INTERVAL_MS` 1200。

### 参数回测依据

`backtest-params.mts` 用 frankfurter 2023-10 ~ 2025-10 的 EUR/USD（512 个交易日）做完美预测回测（前瞻引擎在 real 模式确实能预知方向，游戏价与 API 价比值恒 1.000000）：

| 持有期 H | 笔数 | 止损 | 在仓率 | 终值 | 年化 |
|---|---|---|---|---|---|
| **1** | 321 | 0 | 63% | **$1,726,440** | **1162%** |
| 2 | 219 | 0 | 86% | $712,783 | 717% |
| 3 | 155 | 0 | 91% | $334,055 | 462% |
| 5 | 97 | 0 | 95% | $171,106 | 305% |
| 10 | 50 | 0 | 98% | $79,907 | 178% |
| 20 | 25 | 2 | 98% | $32,038 | 77% |

阈值扫描（H=1）：0% 年化 1471%、0.05% 1425%、0.10% 1325%、0.15% 1162%、0.30% 658% —— 越低越好，但低于手续费（0.02% 名义）会亏本。

**回测暴露的冷却冲突**：`ENTRY_COOLDOWN_MS = 15000` 是为 sim（1.5s/tick）设计的；real 模式自动推进 800ms/天，等 15 秒等于错过 18 天，H=1 策略会被自己的冷却卡死。已按模式区分。

### 全参数大规模回测

| 引擎 | 样本规模 | 参数 | 结论 |
|---|---|---|---|
| 指标引擎 | frankfurter 1999-01 ~ 2025-10，6850 日 × 7 品种 = **47,950 品种-日**（27.2 年） | STOP / TP / REV / TSTOP / THRESHOLD / SCORE_WEIGHTS / MIN_POSITION / MAX_POSITIONS / CCY_MULT / LEV / RISK | **全线负收益** −0.4% ~ −28.7%（限该回测模型，见「回测与实盘的已知偏差」） |
| drift 引擎 | 合成 sim（app.game.js:1062 同公式），50,000 tick × 7 品种 = **350,000 品种-tick**（20.8 小时） | DRIFT_MIN_SUM / DRIFT_MIN_BARS / DRIFT_MAX_BARS | 胜率 **81.3%**、单笔 **16.70%**（毛，未扣开仓费）、回撤 **3.8%**；回测里只有 `DRIFT_MAX_BARS` 有效 |
| 前瞻引擎 | frankfurter 512 日（**oracle 基准**：直接用真实未来决定方向） | LOOKAHEAD_HORIZON / MIN_NET | H=1 年化 1162%（H=3 的 2.5 倍）；0.05% 阈值最优。这是游戏白盒玩法的上限，不是市场预测能力 |

**指标引擎为什么必亏**（限回测模型）：胜率 28.9% + 盈亏比 tp/stop = 0.9/0.4 = 2.25 → 打平需 30.8% 胜率，缺 2 个百分点 × 1728 笔 = 复利归零（终值只剩两美元）。缩小仓位（risk 2% → −1.1%、maxPos 1 → −0.4%、ccyMult 1 → −1.1%、lev 5x → −2.4%）只是**按比例减小亏损**，期望值恒为负。唯一接近打平的是纯反转权重（−0.8%，但只有 218 笔）。

**drift 参数实测（8 个 seed 平均单笔 16.98%）**：

- `DRIFT_MIN_SUM`：**该结论已被推翻**。复刻回测里 0% ~ 0.5% 结果完全相同，但那是复刻引擎只在候选过滤处用了它；真实引擎还用它算仓位强度与动态止损。统一回测（见下）显示它**确实有效**。
- `DRIFT_MIN_BARS`：**同样被推翻**。复刻回测里 1 ~ 12 完全相同只说明优化器很少选小 h，真实引擎里 12 / 20 都会改变结果。
- `DRIFT_MAX_BARS`：复刻回测里 10 → 5001 笔 / 单笔 9.79%、27+ → 2474 笔 / 单笔 16.70%。方向与统一回测一致，但最优值不同。

**drift 相位模型勘误**：app.game.js:1066 的 `index` 是 `PAIRS.forEach((pair, index)` 的**品种索引**（常数偏移），只有 `Date.now()/13000` 随时间增长 → 每 tick 相位增量 0.11538 rad，周期 **54.5 tick（81.7 秒）**。早前按 `index*2` 也随时间增长建模会得到 3 tick 周期，导致合成回测全 0 笔。

**回测与实盘的已知偏差**（结论只能当趋势，不能当复现）：

| 项 | 回测 | 实盘 |
|---|---|---|
| 指标 ATR | `atrSeries` 首次扣窗越界（`v[i-n+1]-v[i-n]`），留下异常前缀 | `atrOf` 取末 n 根真实区间 |
| MACD 归一化 | 全历史 EMA ÷ (ATR×0.4) | 末 40 窗 EMA ÷ (ATR×0.5) |
| drift 仓位 | 单仓、固定 12%、封顶 $1000、40% 止损 / 90% 止盈 | 多仓、半凯利、新闻权重、敞口闸、25~50% 动态止损、反手 |
| drift 退出 | 固定止损/止盈 | 零交叉反手 + 到期，**不走止盈** |
| 冷却 | 无 | sim 15s / real 1s 重进冷却 + 2.5s 执行节流 |
| 样本独立性 | 7 品种共用同一正弦时钟与汇率换算，seed 只改噪声 | — |
| 引擎 | 手写复刻（`backtest-drift-sim.mts`） | 真实脚本函数（`backtest-unified.mts` + `engine-core.mts`） |

因此 **350,000 品种-tick 不是 350,000 笔独立交易**，扫参也没有样本外验收。

### 统一回测（决策与结算直接来自脚本）

`engine-core.mts` 把 `fx-quant.user.js` 装进 vm 沙箱（冻结时钟、假 localStorage、可注入游戏工具），
`backtest-unified.mts` 直接调用脚本里的 `driftSignals` / `planDrift` / `computeExits` / `exec.commit` / `exec.closeTrade`——**没有一行复刻**。
行情用 `app.game.js:1062` 同公式，结算走真实 `place_fx_trade` / `close_fx_trade` 假实现（含手续费），状态机（受管仓位、到期、冷却）全部由脚本自己维护。

固定保证金 $1000 隔离复利，20,000 tick × 7 品种，6 个种子：

| 配置 | 笔数 | 胜率 | 单笔 | 净利 | 回撤 |
|---|---|---|---|---|---|
| **当前默认**（minSum 0.0015 / maxBars 30） | 4427 | 78.8% | 14.24% | $603,837 | 4.4% |
| maxBars **20** | 4411 | **81.2%** | **15.28%** | **$647,495** | 4.8% |
| minSum **0.005** | 4260 | 80.7% | 15.52% | $635,509 | 4.2% |
| minSum 0.005 + maxBars 20 | 3928 | 80.6% | 16.13% | $609,913 | 4.4% |
| minSum 0.006 + maxBars 20 | 0 | — | — | $0 | 0% |

多种子稳健性（6 个种子，相对默认）：

- **maxBars 30 → 20**：平均 **+7.4%**，最差 +5.8%，**6/6 为正**。
- **minSum 0.0015 → 0.005**：平均 +6.0%，最差 +3.4%，6/6 为正。
- **两者同时改**：只剩 +1.0%——效果重叠，都在过滤低质量信号，叠加没有额外收益。

**结论：`DRIFT_MAX_BARS = 20` 是唯一值得考虑的改动**（+7.4% 且最差情形仍 +5.8%）。**v2.5 已应用。**

### 全参数回测（真实汇率 3021 天）

`backtest-params-all.mts` 用 `sim/fx-history.json`（2014-12-31 ~ 2026-10-19，7 品种日线），
决策与结算同样来自脚本本身，单变量扫描每个参数。回测窗口 800 天 × 5 个起始点。

**有效且已调整：**

| 参数 | 旧 → 新 | 证据 |
|---|---|---|
| `STOP_RATIO` | 0.40 → **0.20** | 5 个窗口平均净利 $11.4K → $56.8K（**5 倍**），5/5 窗口更优；0.2 = 30x 下价格反向 0.67% |
| `LOOKAHEAD_HORIZON` | 1 → **5** | 中位净利 $21K → $233K；3/5 窗口最优。最优 H 会在 1/3/5 间跳变（路径依赖），H=5 是稳健性最好的选择而非唯一最优 |
| `DRIFT_MAX_BARS` | 30 → **20** | 统一回测 6 种子平均 +7.4%，胜率 78.8%→81.2% |

**有效但未改（与其它引擎冲突）：**

| 参数 | 指标引擎 | 前瞻引擎 | 结论 |
|---|---|---|---|
| `maxPositions` | 1 最优（-$2.2K vs 4 仓 -$6.7K） | 4 最优（$10.8K vs 1 仓 $2.9K） | 冲突，保持 4 |
| `MAX_CCY_NOTIONAL_MULT` | 1 最优（-$3.6K vs 5x -$6.7K） | 5 最优（$10.8K vs 1x $5.1K） | 冲突，保持 5 |
| `leverage` | 越低越好 | 50x 最优（$24.5K vs 30x $10.8K） | 冲突，保持 30 |

**完全无效（改了等于没改）：**

| 参数 | 现象 | 原因 |
|---|---|---|
| `takeProfitRatio` / `reverseExitScore` / `timeStopBars` | 指标引擎 6 个取值结果**完全相同** | 30x 杠杆下价格反向 1.33% 就触发止损，而止损在 `computeExits` 里是第一个判断，后面三个分支永远走不到 |
| `LOOKAHEAD_MIN_NET` | 0 ~ 0.003 结果完全相同 | `\|bias\|` 总是远超门槛，过滤从未生效 |
| `LOOKAHEAD_SCALE` | 0.002~0.008 差异 <3% | `strength` 被 clamp 在 [0.4, 1]，scale 影响被吃掉 |
| `KELLY_FRACTION` / `KELLY_MIN_SAMPLE` | 4 个取值结果完全相同 | 指标引擎期望为负 → 凯利算出来是负数 → 被 `clamp(…, 0.08, 0.25)` 强制成下限 0.08，系数怎么乘都还是负 |
| `MIN_BARS_FOR_SIGNAL` | 20~90 结果完全相同 | 序列长度远超 90，门槛从未卡住 |

**一个设计缺陷：**`kellyFraction` 在期望为负时返回 `clamp(负值, 0.08, 0.25)` = **0.08**，
即「明知是负期望，仍强制用 8% 权益开仓」。正确行为应该是返回 0（停止交易）。这一条没有改，因为会改变默认交易行为，需要单独决策。

**指标引擎的结论：**在真实汇率 + 30x 杠杆下，任何参数组合都是负收益（最好 -$2.2K / 800 天）。
面板上的止盈 / 反转 / 时间止损三个参数对它**完全无效**。它只适合作为没有 drift / 前瞻数据时的兜底，且应当把并发降到 1。

**前瞻引擎的多窗口细节（STOP=0.2）：**

| 窗口起点 | H=1 | H=3 | H=5 |
|---|---|---|---|
| 2016-03-03 | $21,018 | $180,032 | **$325,577** |
| 2018-02-14 | **$63,022** | $26,507 | $25,135 |
| 2020-01-31 | $175,266 | **$1,696,533** | $56,235 |
| 2022-01-11 | $21,780 | $121,069 | **$838,342** |
| 2023-08-02 | $4,314 | $104,478 | **$233,018** |

H=5 赢 3 个窗口、H=1 和 H=3 各赢 1 个。**没有任何 H 在所有窗口都最优**——这正是「参数扫参只能看趋势，不能当承诺」的实证。

另外两个由统一回测暴露的事实：

- **退出几乎全靠反手**：4427 笔里 4417 笔是「反手」，止损只触发 7 次。动态止损 `clamp(0.25 + |drift|/0.0015 × 0.05, 25%, 50%)` 在实盘路径上基本不起作用——信号翻转总是先发生。
- **手续费占净利 4.4%**（$26,562 / $603,837）：高频反手是主要成本，但仍在盈利区间内。

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
| `AbortSignal.any` + `AbortController` | 卸载时取消在途请求 | 一个信号合并「超时」与「卸载」，dispose 即停 |
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

## 真实环境安装（Edge + Tampermonkey）

**必须手动开启「允许用户脚本 / Allow User Scripts」，否则脚本根本不会注入。**

Chromium 138+ 起，MV3 扩展调用 `chrome.userScripts` 需要用户在扩展详情页显式开启。实测本机 Edge 149 + 篡改猴测试版 5.6.6242：

- 扩展的 `chrome.userScripts` 是 `undefined` → TM 无法注入 `@sandbox raw`，`window.__FXQ__` 恒为 `undefined`。
- 直接改 `Preferences` / `Secure Preferences` 里的 `user_scripts_allowed` **无效**——这两个文件有完整性校验，浏览器启动时会回退。

步骤：`edge://extensions` → 篡改猴测试版 → 详情 → 打开「允许用户脚本」→ 刷新游戏页。

`test-tm.mts` 分三段跑：

1. **安装链路**（任何环境都应通过）：扩展进程、安装页弹出、脚本写入 TM 存储、`enabled`、`version`、`@match`、`@sandbox`、`@run-at`、源码字节数。
2. **能力检测**：`chrome.userScripts` 是否可用。
3. **注入验证**（能力就绪才跑）：MAIN world 可见、`document.modelContext` 已 hook、`via=api`、四个游戏工具全部捕获、`dispose` 可用。

未开启开关时第 3 段输出 **SKIP 并打印操作指引**，不会误报成脚本缺陷。实测：`9 PASS / 0 FAIL / 1 SKIP`。

## 测试

单条命令：`node run-tests.mts` —— **约 27~30 秒**（静态 5 个并行 + 浏览器 1 个独占；波动全来自 `test-all.mts` 的 26~30s）。

| 层 | 文件 | 内容 |
|---|---|---|
| 静态（并行，<1s） | `test-arch.mts` / `test-contract.mts` / `test-indicators.mts` / `test-drift-math.mts` / `test-kelly.mts` | 8 模块互不引用与 18 条事件契约、**28 条正确性边界**（vm 沙箱离线）、指标与汇率换算、闭式解等价性、凯利 |
| 浏览器（单 browser + 四组 context 并行） | `test-all.mts` | 六场景 **46 条断言**：e2e / closeall / drift / automation / replay / mobile |

**并行策略**（为什么是四组而不是六路全开）：

- 单 `chromium.launch()` 共享浏览器进程；**四组各一个 context，组内 1~2 个场景共享同一 page**，省掉重复 `goto`（每次约 5s）。
- 分组：`drift`（独占，并行下 tick 会变慢需要完整窗口）/ `automation + e2e` / `replay + closeall` / `mobile`（iPhone 视口必须独立 context）。
- **六路全并行实测会把 bilibili 壳页与游戏 iframe 加载压垮**（`net::ERR_CONNECTION_CLOSED` / 面板未挂载），四组是稳定上限。
- 组间错峰 300ms 启动；`goto` 失败自动重试 3 次（指数退避）。
- 所有等待改为**条件轮询**而非固定 `sleep`：等 iframe、等面板挂载、等首次渲染、等持仓数变化。固定 8 秒在并发下必然抖动。
- 组内共享 page 的副作用要显式处理：`closeall` 开头先平掉前一个场景留下的持仓。
- 观察窗口：drift 25s（独占组）、automation 15s、replay 8s。

单个 `test-e2e.mts` / `test-closeall.mts` / `test-drift.mts` / `test-automation.mts` / `test-replay.mts` / `test-mobile.mts` 保留用于细粒度调试（单独跑更快定位）。

`test-tm.mts` **不在** `run-tests.mts` 里：它需要本机装有 Tampermonkey 扩展，属于环境验收而非代码回归，单独执行 `node test-tm.mts`。

## 已知限制

- **这是白盒套利**：利用 `tickSim` 的实现细节（不读未来、不改状态），真实市场不存在这种确定性。
- 脚本只自动清理**没有 `modalAction`** 的弹窗；带 action 的（重新开始 / 借款 / 还款 / 金盆洗手）一律留给玩家。
- 挑战模式的行情由 `challengeSim` 驱动且不存档：漂移引擎不需要 K 线即可交易，但指标区显示为空。
- 货币敞口按开仓瞬间的 equity 计算上限，浮盈会让 equity 上升，实测可能超出 0.6%。
- **DOM 通道拿不到保证金**：`domSnapshot` 的 `margin` 为 `NaN`，该通道下自动风控会跳过并在日志告警；需要完整风控请确保走游戏工具接口。
- **回测不是当前实现的同引擎复现**：见「回测与实盘的已知偏差」表，历史数字只能当趋势。
- **E2E 是 `addInitScript` 直注**，绕过 Tampermonkey 的匹配、授权与沙箱；真实扩展通道见「真实环境安装」。
- **真实 TM 注入依赖手动开启 `Allow User Scripts`**：自动化无法代劳（改偏好文件会被完整性校验回退）。未开启时脚本在真实浏览器里完全不运行，且没有任何报错。
- 本机实测：TM 的 `Local Extension Settings` 里只有 LevelDB 骨架、无数据文件，说明此前从未真正加载过任何用户脚本。
- `test-indicators.mts` 会请求 frankfurter，属**网络契约测试**，不是纯离线。
- **指标引擎在 30x 杠杆下三参数失效**：`takeProfitRatio` / `reverseExitScore` / `timeStopBars` 全部走不到，因为止损总是先触发。降低杠杆才会让它们生效。
- **凯利在负期望时仍强制 8% 仓位**：`clamp(f*, 0.08, 0.25)` 的下限会在期望为负时强制开仓，未改。

## 文件

- `fx-quant.user.js` — 油猴脚本（可直接安装）
- `test-arch.mts` — 架构约束：模块互不引用、事件契约双向闭合、单一入口
- `test-contract.mts` — 正确性边界回归（离线 vm 沙箱）：未来隔离、配置恢复、敞口闸、受管仓位、执行核验、异步契约、可卸载
- `probe-fetch.mts` — 回放模式 frankfurter 请求基线（次数 / 去重 / 窗口复用），用来证明「请求不是瓶颈」
- `test-tm.mts` — 真实 Edge + Tampermonkey 冒烟（临时 profile + 真实扩展）：安装链路 / 能力检测 / 注入验证
- `engine-core.mts` — 把脚本装进 vm 沙箱并导出真实决策函数 + 记账式假游戏工具
- `backtest-unified.mts` — 统一回测：直接调脚本的 `planDrift` / `computeExits` / `exec.commit`，扫参 + 多种子稳健性
- `test-mobile.mts` — 移动端：默认折叠、视口内、触摸目标、Pointer 拖拽、边界钳制、桌面恢复
- `test-drift.mts` / `test-drift-math.mts` — 漂移引擎行为与闭式解等价性
- `test-e2e.mts` / `test-closeall.mts` / `test-automation.mts` — 端到端、全平、自动化与安全边界
- `test-indicators.mts` — 指标与汇率换算（从源码抽取函数，零重复定义）
- `probe-*.mts` — 调研用探针（性能 / 移动端 / 漂移 / 事件日历 / 权益曲线 / 一致性对照）
- `sim/fetch-fx.mts` — 抓 frankfurter 2015-至今全量数据（分段 120 天，`sim/fx-history.json`）
- `sim/engine.mts` — 引擎离线复刻（与脚本逐行对齐的纯函数，含冷却约束）
- `sim/scan.mts` — 1170 组三维网格扫参（滚动 15 起点 × 250 天窗口）
- `sim/validate.mts` — train / valid / game 三段样本外对照
- `sim/compare.mts` — Node 复刻 vs 浏览器实测逐日对比（定位偏差源用）
- `panel.png` / `mobile-after.png` — 桌面与移动端实拍
---

## 架构调优记录（v2.5.0 之后，纯重构）

用 ast-grep 0.42.3 + codebase-memory 代码图审计后重构 `createEngine`。**行为零变化**：
`backtest-unified.mts 20000 1000` 输出逐位一致（4411 笔 / 胜率 81.2% / 单笔 15.28% / 净利 $647,495 / 回撤 4.8%）。

### 问题

`createEngine` 是 266 行闭包，内含 14 个函数共享一块 16 字段的可变 `state`。
代价是 **`engine-core.mts` 必须用 `runInNewContext` 启动整个 88 KB 脚本**（配全套 DOM/时钟/存储桩）
才能调用 `planDrift` / `computeExits`。

### 改动

**P0 — 纯函数提到模块级**（不捕获闭包，入参显式）：

| 函数 | 签名 |
|---|---|
| `maxAffordable` | `(cash, leverage)` |
| `pairCooling` | `(book, pair, side, now, mode)` |
| `guardNewPosition` | `(snap, pair, side, cfg, book, now)` |
| `sizePosition` | `(snap, kelly, cfg, strength, weight)` |
| `exposureScale` / `applyExposure` | `(snap, ...)` |
| `activeNewsBias` | `(news, now)` |
| `fusedMap` | `(ctx, cfg)` → 返回新 Map |
| `planDrift` / `planLookahead` / `planIndicator` | `(snap, ctx, cfg, book, kelly, ...)` |
| `computeExits` | `(snap, ctx, cfg, book, barCount)` → `{ exits, warnings }` |

**P1 — 状态分组**：

```
let cfg                                  // 配置
const timing = { tickAt, barCount, lastActionAt, suppressUntil }
const book   = { managed, warnedIds, entryBars, exitBars, stopRatio, pairCooldown }
const signal = { snap, news, pending }
let kellyCache
```

### 结果（代码图实测）

| 指标 | 重构前 | 重构后 |
|---|---|---|
| `createEngine` 行数 | 266 | **111** |
| `createEngine` complexity | 63 | **11** |
| `createEngine` cognitive | **98** | **12** |
| 高复杂度函数（cx≥8）数量 | 12 | **10** |
| `sizePosition` / `guardNewPosition` / `applyExposure` | 闭包内不可达 | 模块级纯函数 |

`debug` 面对外签名保持 `(snap, ctx)` 不变，`backtest-unified` / `backtest-params-all` / `test-contract` 零改动。
`debug.state` 改为访问器门面，保持「活对象」读写语义（测试会往里写 `cfg` / `snap`）。

### 未做

**P2 双通道桥未动**：确认 fx-simple 仍在线（iframe 200 / app.js 101 KB / `longBtn` 存在），
script 通道与 direct 通道都有实际价值，不做简化。

`createUi` 361 行 / `createExec` 193 行 / `createSeries` 181 行 / `createBridge` 162 行未动——
内部已是 30+ 个小函数，拆出去只增加间接层。

### 顺带修复

项目缺 `node_modules`，`playwright-core` 解析失败导致 20 个浏览器测试全部无法运行。
已建 junction 指向 `@playwright/mcp/node_modules/playwright-core`，测试套件恢复。

### 回归

```
test-arch          ARCH ALL PASS
test-contract      CONTRACT ALL PASS
test-drift-math    DRIFT-MATH ALL PASS
test-indicators    ALL PASS
test-automation    AUTOMATION ALL PASS   (70.3s，与重构前 70.3s 一致)
backtest-unified   数字逐位一致
```

`test-all.mts`（4 context 并行）在新旧版本上都会偶发失败（`replay`/`closeall` 同组、`drift` 敞口），
属既有并发抖动，与本次重构无关。
