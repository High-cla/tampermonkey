# 三脚本性能基准与兼容性验收

更新时间：2026-11-03

## 优化顺序

| 优先级 | 技术 | 收益来源 | 验收条件 |
|---|---|---|---|
| 最高 | 固定容量 Ring Buffer | 避免高频 shift() 引起的数组搬移 | 容量上限不变、FIFO 顺序与旧实现一致 |
| 最高 | 单次遍历计算多个指标 | 共用同一尾窗扫描，减少重复扫描 | 随机序列数值等价测试通过 |
| 最高 | API 缓存与请求去重 | 缓存命中、合并同 key 在途请求 | 相同 URL 同时请求只产生一次网络请求 |
| 高 | Map / Set 复用 | 避免热路径重复线性查找和临时集合 | 结果集合与原实现一致 |
| 高 | requestAnimationFrame + DOM diff | 合并同一帧 UI 更新，跳过未变化 DOM | 无额外布局抖动、节点更新数下降 |
| 高 | AbortController | 卸载/切换时终止可取消的读取请求 | 不再有过期读取结果覆盖新状态 |
| 中 | TypedArray | 连续数值窗口的紧凑存储 | 只有内存/CPU profile 证明确有优势才启用 |
| 中 | MutationObserver + 低频兜底 | 由状态变化触发采集，避免高频轮询 | 不漏状态变化，兜底不会重复触发昂贵工作 |
| 中 | Worker | 把足够大的纯计算移出主线程 | 序列化/复制开销低于节省的计算时间 |

不要仅因某项技术“更高级”就引入它。当前 Kurumi 只有 6 组固定配对候选；这部分计算不是明显的 Worker 瓶颈。应先完成单次扫描和缓存，再用真实页面长任务数据决定是否启用 Worker。TypedArray 同理。

## 当前代码基线与边界

- FX Quant 的 bridge.call() 是同步接口。它明确拒绝 Promise 型 tool.execute()；这项保护不能删除。正确迁移必须让只读状态采集、订单写入、写后回读都进入有序异步链。
- 订单写入必须串行。AbortController 只表示调用方不再等待或读取可以被取消；不能据此推断一个已经发出的下单/平仓工具调用已被撤销。写操作完成后必须重新读取游戏状态核验。
- 只有工具不存在（MISSING）时才考虑 DOM 降级。工具明确失败或拒绝时，不应再点击 DOM 按钮重试，否则可能造成重复操作。
- Kurumi 目前通过 React Fiber 内部结构寻找订阅回调和行情对象。Fiber / Hook 属性不是稳定公开 API；没有公开 store 证据前，必须保留现有兼容路径。
- React 对外部 store 的标准订阅形态是 subscribe(listener) 返回 unsubscribe，并由 getSnapshot() 读取稳定快照。只有游戏页面自己公开了符合此契约的 store，才可切换到该路径；React 文档并不意味着任意 Fiber Hook 都是公开 API。
- Kurumi 面板已使用 requestAnimationFrame 合帧，并对持仓区域做 markup diff；这两项属于现有能力，不需要再叠一层重复调度器。
- A-Share 已通过 fetch / WebSocket 获取后端数据，并有请求间隔、限频冷却与超时控制。后续重点是以请求统计验证缓存命中和更新频率，不应重复封装同一层网络客户端。

## Kurumi 公共 Store / WebSocket 探测流程

先在 Edge DevTools Console 中只读检查页面是否主动暴露 store。不要遍历或调用 React 私有 Hook：

\`\`\`js
const candidates = [
  '__REDUX_STORE__', '__ZUSTAND_STORE__',
  'fxKurumiStore', 'gameStore', 'marketStore', 'store'
];

candidates.map((name) => {
  const descriptor = Object.getOwnPropertyDescriptor(window, name);
  const store = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
  return {
    name,
    subscribe: typeof store?.subscribe === 'function',
    getSnapshot: typeof store?.getSnapshot === 'function',
    getState: typeof store?.getState === 'function'
  };
});
\`\`\`

候选对象还必须通过只读快照形状检查（至少确认 cash 与 positions，行情还需有稳定的报价字段），之后才可订阅。不要把 Bilibili Toy 平台的 window.toy 云存储 SDK 误认为小游戏内部交易 store。

WebSocket 探测在 DevTools 的 Network → WS 中先做：确认 socket URL、消息类型、心跳、快照/增量语义、重连行为，以及行情字段是否稳定。未完成消息契约审计前不要包装页面的全局 WebSocket 构造器，也不要直接把未经验证的帧数据用于交易状态。

若没有页面公开的 store 或 WebSocket 契约，Fiber 保持为兼容实现，并把“未发现公开 API”作为结果记录，而不是臆造 API 名称。

仓库内的只读探测脚本：tools/kurumi-public-api-probe.user.js。安装后在游戏页 Console 执行：

\`\`\`js
__FXKQ_API_PROBE__.inspect();              // 只枚举页面主动暴露的数据属性与方法类型
__FXKQ_API_PROBE__.read('gameStore');       // 仅对选定候选调用 getState/getSnapshot 并返回结构摘要
\`\`\`

该探测器不会调用 subscribe、不会改写 WebSocket、不会读取 React Fiber，也不会输出账户/持仓的具体数值。若没有命中候选，代表“这些约定名称未暴露”，并不能证明应用内部不存在私有 store。


## 统一基准测试

仓库增加了一个可独立安装的低侵入监测脚本：

tools/toy-performance-monitor.user.js

在 Edge + Tampermonkey 中安装后，在 Toy 游戏页 Console 执行：

\`\`\`js
__TOY_PERF__.start('baseline');   // 开始采样
// 使用固定游戏模式、固定行情负载运行同样的操作
__TOY_PERF__.stop();              // 返回 JSON 报告
\`\`\`

报告包含：
- 帧间隔均值、P95 和最大值（用于观察卡顿；不是精确 FPS 证明）。
- Long Task 数量、总耗时和最大耗时（浏览器支持时）。
- Resource Timing 记录数、API 类请求数和可见的传输字节数。
- Chromium 暴露 performance.memory 时的堆使用量。
- 当前页是否检测到 FX Quant、FX Kurumi 和 A-Share 调试入口。

该脚本不包装 fetch / WebSocket、不改游戏状态、不触发订单。它不代替 Edge DevTools Performance 的 CPU 火焰图；网络缓存命中率、真实游戏业务指标和 DOM 布局成本仍需在 DevTools 中单独观察。

纯数据结构微基准：

\`\`\`sh
node tests/benchmark-primitives.mjs
\`\`\`

微基准只比较固定容量 Ring Buffer 与 Array.push + shift 的结构成本；它不是游戏页面端到端性能结果。测试：

\`\`\`sh
node --test tests/*.test.mjs
\`\`\`

## Edge 兼容性验收

每轮发版都要记录 Edge 完整版本号、Tampermonkey 版本、Allow User Scripts 开关状态、游戏模式、是否登录、行情来源和测试时长。使用相同条件跑改动前后各至少三次，记录中位数，避免一次采样受后台标签、网络和游戏状态影响。

最低验收项：
1. Edge Stable 当前版 + Tampermonkey 当前版：三个脚本均按预期匹配、启动和卸载。
2. Tampermonkey 扩展详情中的 Allow User Scripts 状态正确；Edge 138+ 的脚本注入权限要求见官方 Q209。
3. API 可用、API 缺失、API Promise 拒绝、DOM fallback 四种路径分别验证。
4. 多次重复刷新、后台/前台切换、网络断开/恢复、页面卸载，不出现重复下单、重复请求或过期快照覆盖。
5. 比较 CPU 主线程、Long Tasks、堆内存、请求数、帧间隔和操作延迟。语法检查通过不等于真实浏览器回归通过。

## 官方参考

- React 外部 Store 订阅契约：https://react.dev/reference/react/useSyncExternalStore
- WebMCP 规范：https://github.com/webmachinelearning/webmcp/blob/main/index.bs
- WebMCP 浏览器支持状态：https://github.com/webmachinelearning/webmcp/blob/main/implementation-status.md
- Microsoft Edge Origin Trials：https://developer.microsoft.com/en-us/microsoft-edge/origin-trials/
- Edge DevTools Performance：https://learn.microsoft.com/en-us/microsoft-edge/devtools/performance/

截至本次记录，WebMCP 在 Edge 的实现状态仍属于 Origin Trial 级别；不要假设任意 Edge Stable 环境都能调用 document.modelContext。


## 本分支实现状态说明

当前分支已加入 Ring Buffer 原语、其 FIFO/回绕/清空边界测试和微基准，并提供页面级监测器与 Kurumi 公共 store 只读探测器。Ring Buffer 原语尚未接入 Kurumi 的行情序列热路径；在生产序列替换、异步订单链迁移和等价回归完成前，不计为已经获得的运行时性能收益。
