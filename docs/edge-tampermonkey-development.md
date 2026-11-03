# Edge + Tampermonkey 开发与性能维护指南

> 适用仓库：[High-cla/tampermonkey](https://github.com/High-cla/tampermonkey)  
> 文档核对日期：2026-11-03。浏览器扩展 API 以 Microsoft Edge 官方文档为准；用户脚本 API 以 Tampermonkey 官方文档为准。

## 1. 先区分两种运行环境

本仓库交付的是 **Tampermonkey userscript**，不是独立的 Edge 扩展。当前仓库没有 manifest.json，三个脚本也没有直接调用 chrome.* 扩展 API。

| 能力 | Tampermonkey 用户脚本 | Edge 扩展 |
|---|---|---|
| 注入网页 | 由 @match、@run-at、@sandbox 决定 | Manifest 与 content scripts / scripting API 决定 |
| 存储 | 页面 localStorage，或显式授权的 GM.getValue/setValue | storage permission 下的 chrome.storage |
| 跨域网络 | 页面 fetch 受 CORS 约束；GM 请求需要 @grant 和窄范围 @connect | 通过 host_permissions 与扩展网络 API |
| 标签页、扩展后台 | 不可直接使用扩展专属 API | 通过 Manifest 权限使用 tabs、MV3 service worker 等 |

**结论：** 只在 Edge 中运行 Tampermonkey，不会自动获得 chrome.scripting、chrome.storage 或 chrome.tabs。除非准备把脚本正式迁移成扩展，否则不要为了“使用 Edge API”而引入扩展 API。

若未来迁移 MV3，需建立单独扩展工程：通过 manifest.json 声明 manifest_version: 3、permissions、host_permissions 和必要的 service worker；不要把 userscript 元数据直接当作 Manifest。

## 2. 权威开发文档

### Microsoft Edge

| 主题 | 官方文档 | 用途 |
|---|---|---|
| 扩展开发入口 | [Microsoft Edge Extensions](https://learn.microsoft.com/en-us/microsoft-edge/extensions/landing/) | Edge 扩展开发总入口 |
| API 支持矩阵 | [Supported APIs](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support) | 确认某个扩展 API 是否支持 MV3 / Edge |
| Manifest 格式 | [Manifest format](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/manifest-format) | 扩展入口、权限、脚本声明 |
| 权限声明 | [Declare permissions](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/declare-permissions) | 区分 permissions 与 host_permissions |
| MV2 迁移 MV3 | [Migrate to Manifest V3](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/migrate-your-extension-from-manifest-v2-to-v3) | service worker、权限和扩展架构迁移 |
| 性能分析 | [DevTools Performance tool](https://learn.microsoft.com/en-us/microsoft-edge/devtools/performance/overview) | 录制 CPU 主线程、渲染和性能轨迹 |

### Tampermonkey

| 主题 | 官方文档 | 项目中应如何使用 |
|---|---|---|
| API 总目录 | [Tampermonkey Documentation](https://www.tampermonkey.net/documentation.php) | 先确认 API 是否存在及版本要求 |
| 匹配网址 | [@match](https://www.tampermonkey.net/documentation.php?q=include) | 只匹配实际运行的 Toy 页面 |
| 执行时机 | [@run-at](https://www.tampermonkey.net/documentation.php?q=run_at) | 需要早期 hook 才使用 document-start |
| 权限模型 | [@grant](https://www.tampermonkey.net/documentation.php?q=grant) | 仅声明真正使用的 GM API |
| 执行沙盒 | [@sandbox](https://www.tampermonkey.net/documentation.php?q=sandbox) | 选择页面主世界、隔离世界或用户脚本世界 |
| 网络白名单 | [@connect](https://www.tampermonkey.net/documentation.php?q=connect) | 给 GM 网络请求配置精确域名 |
| 跨域请求 | [GM.xmlHttpRequest](https://www.tampermonkey.net/documentation.php?q=GM_xmlhttpRequest) | 仅在页面 fetch 因 CORS 不可用时考虑 |
| 存储 | [GM_getValue / GM_setValue](https://www.tampermonkey.net/documentation.php?q=GM_values) | 需要脚本隔离存储或跨页面持久化时使用 |

关键差异：

- @grant none 表示不使用 GM API，并影响脚本沙盒行为；不能在保留它的同时假设 GM.xmlHttpRequest 可用。
- @sandbox raw 请求页面主世界访问；它适用于必须 hook 页面对象或调用页面自身 API 的场景。主世界也意味着会与页面共享运行环境，必须谨慎避免全局污染。
- 使用 GM.xmlHttpRequest 时，显式声明对应的 @grant 和具体 @connect 域名。不要无理由配置 @connect *。
- Tampermonkey 的 GM 请求和页面原生 fetch 是不同权限路径；不要为了“优先 API”将已可用的同源页面 API 全部改成 GM 请求。

### JavaScript / Web 平台规范参考

- [Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API)
- [WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)
- [MutationObserver](https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver)
- [AbortController](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)
- [requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)
- [Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)
- [Performance.now()](https://developer.mozilla.org/en-US/docs/Web/API/Performance/now)
- [TypedArray](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/TypedArray)

## 3. 项目对应的网站与 API 资料边界

| 项目 | 页面入口 / URL 匹配范围 | 当前代码路径 |
|---|---|---|
| FX 简单! | [Toy FX Simple](https://www.bilibili.com/toy/fx-simple/index.html)；脚本匹配 https://www.bilibilitoy.com/toy/fx-simple/* | 页面工具 API + 本地存档 + DOM 降级；历史行情由 Frankfurter API 获取 |
| FX Kurumi | https://www.bilibilitoy.com/toy/fx-kurumi/* | 订阅 React Fiber 中发现的 store，并采集行情快照 |
| 大A 简单! | https://www.bilibili.com/toy/suoha/* 与 https://www.bilibilitoy.com/toy/suoha/* | 后端 HTTP API + WebSocket；页面 socket / 云存储用于会话信息衔接 |

可复用的官方平台资料：

- [Bilibili Toy 平台介绍](https://www.bilibili.com/toy/intro)：说明 Toy 是可直接在网页中打开的互动内容平台。
- [bilibili/toy GitHub 仓库](https://github.com/bilibili/toy)：这是 Toy Creator CLI、Agent Skill 和 DSH 插件项目，不是本仓库三个小游戏的前端源码，也不是其内部交易 API 的完整规范。
- [Toy Skill 内容检查清单](https://github.com/bilibili/toy/blob/main/skills/toy/references/content-checklist.md)：可参考平台云存储/共享配额的注意事项；不能据此推导本仓库游戏内交易 API 的签名。

**API 文档缺口：** 目前未找到这三个小游戏内部交易接口的独立公开 API 参考。下面列出的 read_fx_game_state、place_fx_trade、游戏 store / WebSocket 等是从本仓库当前代码识别出的集成点，不应误称为公开、稳定的官方接口。游戏页面的动态资源也无法仅凭公开静态文档完整验证；升级前需要在实际 Edge 页面重新检查。

## 4. 当前脚本的 API 优先级审计

### FX Quant（fx-quant.user.js）

当前已经采用 API 优先：

1. 从页面 document.modelContext.registerTool 注册流程发现游戏工具。
2. 用 read_fx_game_state 读取账户/行情，用 place_fx_trade、close_fx_trade、advance_real_fx_day 操作。
3. 工具缺失时才回退 DOM 快照和按钮交互。
4. 历史行情通过页面 fetch 访问 Frankfurter，并缓存区间结果。

需要关注的下一步：当前 bridge.call() 是同步接口；若页面工具的 execute() 返回 Promise，代码会明确报告失败，而不会把 Promise 当成数据。不要简单删除这个保护。若需支持异步工具，应将“采集 → 计算 → 执行”改造成可取消的异步命令流，并为每轮快照设置序号，丢弃过期结果；保留 DOM fallback 和下单后的回读核验。

### FX Kurumi（fx-kurumi.user.js）

当前通过 React Fiber 的内部字段查找订阅函数和行情对象。这种方式依赖 React 内部实现和游戏打包结构，**不是稳定公开 API**。推荐升级顺序：

1. 优先寻找游戏明确暴露的 window.* SDK、store 的公开 getState/subscribe、正式事件接口或文档化 WebSocket。
2. 若只能依赖 store，优先使用游戏公开的订阅/快照方法，而不是每轮递归遍历 Fiber。
3. 保留 Fiber 探测作为兼容 adapter，并限制最大节点数、扫描频率和异常后的退避。
4. 对每次行情快照只计算一次风险和配对结果；UI 使用 RAF 合帧并只更新变化节点。

### 大A（a-share.user.js）

当前已直接使用页面 fetch 调后端 API，并通过 WebSocket 获取快照；对 429 实施冷却和最小请求间隔。会话令牌从页面 WebSocket / Toy 云存储 / 本地缓存衔接。交易路径已经 API 优先，不建议为了统一写法而换成 GM 请求。

## 5. API 优先的实施原则

按以下顺序选择数据和操作通道：

1. **游戏公开 API / 文档化工具接口**：首选；验证字段、版本、权限和同步/异步语义。
2. **游戏公开 store / 事件 / WebSocket**：可用于高频快照；必须处理重连、过期数据、版本变更和卸载。
3. **平台官方 SDK**：如云存储等，按官方配额和错误码使用；缓存、批量访问、指数退避。
4. **Tampermonkey GM API**：只解决确实存在的跨域或脚本权限问题。最小化 @grant 和 @connect。
5. **DOM 读取 / click**：作为页面 API 缺失时的兼容层，不作为主数据源；交易后应回读实际状态，不能把 click 成功当成交易成功。

无论走哪种接口，都应做到：输入校验、超时、取消、错误分类、请求去重、结果缓存、版本探测、最小权限和安全降级。不要猜 API URL、抓取未授权令牌或绕过服务端权限。

## 6. 高收益 JavaScript 优化清单

“高性能语法”不是关键；收益来自减少热点路径上的算法复杂度、内存分配、DOM 工作和网络往返。以下优先级按本仓库代码形态排序。

| 优先级 | 做法 | 对应场景 | 注意事项 |
|---|---|---|---|
| 高 | 单次遍历累积多个统计量 | EMA / ATR / RSI / 风险 / 价差统计 | 保持数值等价测试；不要为了合并循环破坏公式 |
| 高 | 缓存解析/映射/格式化结果 | 快照映射、Intl formatter、稳定 API URL | 需要完整失效条件，不能只按数组长度判断 |
| 高 | 固定容量环形缓冲区 | 高频 tick / 采样序列 | 替代热点路径的 shift()；注意时间顺序与尾窗语义 |
| 高 | 事件驱动 + 低频兜底 | MutationObserver / WebSocket | 页面可见时响应事件，后台降低轮询频率 |
| 高 | RAF 合帧 + DOM diff | 高频行情 UI | 不要每个 tick 重建整块 innerHTML |
| 中 | 避免重复中间数组 | Object.entries/keys、map/filter/slice/spread | 只有热点循环中才值得改；可读性和副作用优先 |
| 中 | TypedArray / 预分配数值数组 | 固定长度、纯数字的指标窗口 | 对对象型快照/稀疏结构通常无益，须基准测试 |
| 中 | Promise 去重 / AbortController | 历史行情请求、异步工具调用 | 需要区分超时、主动取消、HTTP 失败 |
| 中 | Map / Set 复用 | 稳定键查询、成员关系检查 | 不要在每秒大规模扫描中无必要地重复构造 |
| 低 | for、for...of、可选链、空值合并等语法选择 | 普通业务代码 | 现代语法不等于天然更快；选择最清楚的写法 |

避免把以下写法当成性能优化的目标本身：

- 用位运算替代普通算术、压缩变量名、过度内联函数。
- 把所有数组改成 TypedArray。
- 为少量数据手写复杂对象池。
- 在没有基准测试的情况下，将 map 改成 for 并声称更快。

### 本次落地的微优化

Kurumi 的行情采集每秒调用 harvestQuoteMap → walkFibers。原 walkFibers 每次创建一个 Set，并对遍历到的 Fiber 节点做重复成员判断；遍历边只有 child 和 sibling，是树遍历，不沿 return 或 alternate 回走。已移除每次扫描的 Set，保留原有 DFS 入栈顺序、提前终止行为和 maxFibers 上限。该改动不触碰信号、仓位、交易阈值。

**尚未声称具体性能百分比：** 此次提交没有在实际 Edge 目标页面运行性能录制。需要使用同一游戏模式、同一行情负载录制前后 CPU 主线程和堆内存，并确认行情扫描结果一致后，才能报告改进幅度。

## 7. Edge 上的验证流程

1. 打开目标 Toy 页面和 Tampermonkey Dashboard，确认脚本版本、匹配 URL、启用状态及执行环境。
2. 在 Edge DevTools → Performance 中，使用相同游戏模式和行情负载录制至少 60 秒；重点观察 Scripting、Rendering、Long Tasks 和主线程占用。
3. 对高频路径可临时加 performance.mark/measure；测完删除或放进显式 debug 开关，避免长期测量噪声。
4. 比较优化前后 CPU time、长任务数量、JS heap 和 DOM 节点变化。不要只比较单次总耗时。
5. 运行数值等价测试和策略回归；本次只改 Fiber 遍历，不应改变候选行情、仓位或订单行为。
6. 在桌面 Edge、页面后台/恢复、网络断开重连、登录态过期和移动 Chromium 环境中检查生命周期与降级路径。

仓库当前主分支可见的 CI 工作流只运行三个脚本的 node --check 语法检查；README 记载的部分回测/等价性测试源文件并未出现在当前主分支文件树中。因此，静态语法 CI 不能替代浏览器性能或策略回归验证。
