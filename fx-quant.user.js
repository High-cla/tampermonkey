// ==UserScript==
// @name         FX 简单! · 量化辅助台
// @namespace    https://www.bilibilitoy.com/toy/fx-simple
// @version      2.5.0
// @description  B站「FX 简单!」量化辅助：八模块事件驱动架构、漂移/前瞻/指标三引擎、移动端适配
// @author       fxq
// @match        https://www.bilibilitoy.com/toy/fx-simple/*
// @run-at       document-start
// @sandbox      raw
// ==/UserScript==

/* ============================================================================
 * FX 简单! 量化辅助台 v2.1.0
 *
 * 架构：一个总线实例 + 八个互不引用的模块（按单一职责切分）。
 *   - 模块之间零直接调用，只经 bus.emit / bus.on 通信，事件名即契约（EV 常量）。
 *   - 每个模块只暴露一个入口 init(bus)，返回 { dispose, debug }。
 *   - 模块内部不出现其他模块的标识符；纯函数库无状态，可被任意模块使用。
 *
 * 模块职责：
 *   bridge  双通道注入 + 工具句柄 + 存档读取
 *   store   配置持久化 + 调试环
 *   data    快照采集 + tick 计数 + 新闻识别 + 触发源（MutationObserver + 兜底定时）
 *   series  序列获取（存档/采样/frankfurter）+ 指标缓存 + ctx 构建
 *   engine  漂移/指标决策 + 风控退出 + 定量与敞口
 *   exec    下单/平仓/推进日/弹窗白名单清扫/全平队列
 *   input   Pointer 拖拽 + 断点检测 + 位置持久化 + 折叠状态
 *   ui      面板 DOM + diff 渲染
 *
 * 事件链：bridge → data → series → engine → exec
 *          input ──ui:state──→ ui；任一处失败经 log:add 汇到 ui。
 *
 * 静默降级策略（本文件所有空 catch 都属于以下预期情况，非预期错误走 log:add）：
 *   - pageWorldPolyfill 内部：该函数被 toString 序列化注入页面主世界，不能引用外部标识符，
 *     任何 try/catch 只能就地吞掉；失败由 bridge:blocked 事件上报。
 *   - 存储不可用（隐私模式 / 配额满 / iframe 沙箱）：配置与位置不持久化，功能降级但不影响交易。
 *   - 脏存档（手工改过 localStorage）：readSave 返回 null，调用方回落 DOM 通道。
 *   - Pointer capture 失败（合成事件 / 旧内核）：拖拽退化为不跟手。
 * ==========================================================================*/

(() => {
  'use strict';

  // MAIN_WORLD（Chromium 上的 @sandbox MAIN_WORLD）下 window 就是页面 window，无需任何桥接；
  // 沙盒模式（Firefox / 旧版 TM）才退回 unsafeWindow + <script> 注入兜底。
  const IS_SANDBOX = typeof unsafeWindow !== 'undefined' && unsafeWindow !== window;
  const PAGE = IS_SANDBOX ? unsafeWindow : window;
  if (PAGE.__FXQ_BOOTED__) return;
  PAGE.__FXQ_BOOTED__ = true;

  /* ================================================================ 常量 */

  const PAIRS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'EUR/CHF', 'AUD/USD', 'USD/CAD'];
  const DIGITS = { 'EUR/USD': 5, 'GBP/USD': 5, 'USD/JPY': 3, 'USD/CHF': 5, 'EUR/CHF': 5, 'AUD/USD': 5, 'USD/CAD': 5 };
  const FX_SYMBOLS = 'USD,GBP,JPY,CHF,AUD,CAD';
  const SAVE_KEY = 'fx-heartbeat-save-v3';
  const CFG_KEY = 'fxq-config-v1';
  const POS_KEY = 'fxq-panel-pos';
  const FOLD_KEY = 'fxq-fold';

  const TICK_MS = 1500;
  const DRIFT_DIV = 13000;
  const DRIFT_AMP = 0.00036;
  const MARKET_PHASE = { sim: 0, challenge: 0.7 };

  const FALLBACK_MS = 500;
  const BACKGROUND_MS = 2000;
  const SWEEP_MS = 1500;
  const SAMPLE_INTERVAL_MS = 1200;
  const SAMPLE_MAX = 400;
  const SAMPLE_MIN = 12;
  const SERIES_TTL_MS = 60000;
  const DAY_ADVANCE_MS = 800;
  const ACTION_COOLDOWN_MS = 2500;
  const ENTRY_COOLDOWN_MS = 15000;      // sim/challenge：1.5s/tick，15 秒约 10 个 tick
  const ENTRY_COOLDOWN_FAST_MS = 1000;  // real/battle：800ms/天，15 秒会错过 18 天
  const SUPPRESS_MS = 8000;
  const NEWS_WINDOW_MS = 8000;
  const MAX_LOG = 40;
  const REATTACH_MS = 3000;

  const MIN_MARGIN = 10;
  // 全参数回测（真实汇率 800 天 × 5 窗口）：0.2 的平均净利是 0.4 的 5 倍，
  // 且 5/5 窗口都更优；止损更紧 → 周转更快 → 复利更多。0.2 = 30x 下价格反向 0.67%。
  const STOP_RATIO = 0.20;
  const STOP_MIN = 0.25;
  const STOP_MAX = 0.50;
  const MAX_CCY_NOTIONAL_MULT = 5;
  const MIN_POSITION_RATIO = 0.02;
  const KELLY_FRACTION = 0.5;
  const KELLY_MIN_SAMPLE = 10;
  const KELLY_DEFAULT = 0.12;
  const RISK_WARN = 0.60;
  const SIGNAL_THRESHOLD = 30;
  const SIGNAL_STRONG = 55;
  const DRIFT_MIN_BARS = 8;
  // 统一回测（20000 tick × 6 种子）：20 比 30 平均 +7.4% 净利、最差仍 +5.8%，
  // 胜率 78.8%→81.2%、单笔 14.24%→15.28%。
  const DRIFT_MAX_BARS = 20;
  const DRIFT_MIN_SUM = 0.0015;
  // 扫参结论：真实游戏 26 天对照 H=3 +41.2% / H=4 +37.7% / H=10 +39.9% / H=6 +36.7% / H=5 +31.1% / H=8 +20.5% / H=2 +19.2%。
  // H=3 最优，但 H=5~10 的排序非单调（H=8 最差、H=10 又回升）= 路径噪声，不是真实 edge。保持 3。
  // 全参数回测（STOP=0.2，5 个窗口）：H=5 在 3/5 窗口最优、中位数最高（$233K vs H=1 的 $21K）。
  // 注意：最优 H 在窗口间会在 1/3/5 之间跳变（路径依赖），H=5 是稳健性最好的选择而非唯一最优。
  const LOOKAHEAD_HORIZON = 5;
  const LOOKAHEAD_SCALE = 0.004;
  const LOOKAHEAD_BOOST = 0.3;     // 前瞻与指标同向时最多放大 30%
  const LOOKAHEAD_CONFLICT = 0.4;  // 反向时把指标分数打到 40%，不反转方向
  const LOOKAHEAD_SPAN_DAYS = 180; // 以游戏当前日期为中心前后各拉 180 天，cursor 必然能匹配
  // 扫参结论（1170 组 Node + 17 组真实游戏）：0.0015~0.005 结果完全相同（3 天波动总远超门槛，参数是死的）；
  // 0.01 开始掉收益，0.02 以上完全停止交易。保持 0.0015 即可，调大没有收益只有风险。
  const LOOKAHEAD_MIN_NET = 0.0005; // 回测：阈值 0.05% 年化 1425%，0.15% 只有 1162%
  const MIN_BARS_FOR_SIGNAL = 30;
  const MOBILE_BREAKPOINT = 720;
  const RSI_OVERSOLD = 30;
  const RSI_OVERBOUGHT = 70;
  const IND = Object.freeze({
    EMA_FAST: 12, EMA_SLOW: 26, MACD_SIGNAL: 9, MACD_WINDOW: 40,
    RSI: 14, ATR: 14, BOLL: 20, BOLL_MULT: 2, ROC: 10
  });
  const SCORE_WEIGHTS = Object.freeze({ TREND: 30, MACD: 20, RSI: 20, BOLL: 15, ROC: 15 });

  // 事件契约常量：唯一定义处，改这里等于改契约
  const EV = Object.freeze({
    LOG: 'log:add',
    BRIDGE_READY: 'bridge:ready',
    BRIDGE_BLOCKED: 'bridge:blocked',
    CONFIG_SAVE: 'config:save',
    CONFIG_CHANGED: 'config:changed',
    DATA_REQUEST: 'data:request',
    DATA_BAR: 'data:bar',
    DATA_SNAPSHOT: 'data:snapshot',
    NEWS_CHANGED: 'news:changed',
    SERIES_READY: 'series:ready',
    ENGINE_PLAN: 'engine:plan',
    ENGINE_EXITS: 'engine:exits',
    EXEC_OPENED: 'exec:opened',
    EXEC_CLOSED: 'exec:closed',
    UI_COMMAND: 'ui:command',
    UI_SWEEP: 'ui:sweep',
    UI_MOUNTED: 'ui:mounted',
    UI_STATE: 'ui:state'
  });
  const STATUS = Object.freeze({ OK: 'ok', MISSING: 'missing', FAILED: 'failed' });
  const MODE = Object.freeze({ OFF: 'off', CONFIRM: 'confirm', AUTO: 'auto' });
  const SIZE_MODE = Object.freeze({ KELLY: 'kelly', FIXED: 'fixed' });

  const DEFAULTS = Object.freeze({
    automation: MODE.OFF,
    leverage: 30,
    riskPct: KELLY_DEFAULT,
    takeProfitRatio: 0.9,
    reverseExitScore: 30,
    timeStopBars: 20,
    allowLookahead: false,
    maxPositions: 4,
    sizeMode: SIZE_MODE.KELLY
  });

  const NEWS_BIAS = [
    { tag: '通胀数据', title: '核心通胀高于预期', bias: { 'EUR/USD': -0.00045, 'GBP/USD': -0.00035, 'USD/JPY': 0.00038, 'USD/CHF': 0.0003, 'AUD/USD': -0.00042, 'USD/CAD': 0.00025 } },
    { tag: '就业数据', title: '新增就业明显降温', bias: { 'EUR/USD': 0.00035, 'GBP/USD': 0.0003, 'USD/JPY': -0.00035, 'USD/CHF': -0.00025, 'AUD/USD': 0.00028, 'USD/CAD': -0.0002 } },
    { tag: '风险事件', title: '避险情绪突然升温', bias: { 'EUR/USD': -0.00025, 'GBP/USD': -0.00032, 'USD/JPY': -0.00022, 'USD/CHF': -0.00018, 'AUD/USD': -0.0005, 'USD/CAD': 0.0003 } },
    { tag: '央行讲话', title: '官员强调政策取决于数据', bias: {} },
    { tag: '能源市场', title: '能源价格快速反弹', bias: { 'EUR/USD': -0.00028, 'GBP/USD': -0.00016, 'AUD/USD': 0.0002, 'USD/CAD': -0.00034 } },
    { tag: '市场传闻', title: '大型资金调整月底仓位', bias: {} }
  ];

  /* ============================================================ 纯函数库 */

  const $ = id => PAGE.document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const feeRate = lev => lev * (0.00005 + lev * 0.000005);
  const MONEY_FMT = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const TIME_FMT = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const money = n => (n < 0 ? '-$' : '$') + MONEY_FMT.format(Math.abs(n));
  const signedMoney = n => (n >= 0 ? '+$' : '-$') + MONEY_FMT.format(Math.abs(n));
  const priceText = (pair, v) => finite(v) ? v.toFixed(DIGITS[pair] || 5) : '—';
  const isDriftMode = mode => mode === 'sim' || mode === 'challenge';

  const DRIFT_STEP = TICK_MS / DRIFT_DIV;
  const DRIFT_TABLES = (() => {
    const half = Math.sin(DRIFT_STEP / 2);
    const amp = [0], cosPhi = [0], sinPhi = [0], root = [0];
    for (let h = 1; h <= DRIFT_MAX_BARS; h++) {
      amp[h] = DRIFT_AMP * Math.sin(h * DRIFT_STEP / 2) / half;
      const phi = (h - 1) * DRIFT_STEP / 2;
      cosPhi[h] = Math.cos(phi);
      sinPhi[h] = Math.sin(phi);
      root[h] = Math.sqrt(h);
    }
    return { amp, cosPhi, sinPhi, root };
  })();

  function driftSum(t0, index, horizon, marketPhase) {
    if (horizon < 1 || horizon > DRIFT_MAX_BARS) return 0;
    const theta0 = t0 / DRIFT_DIV + index * 2 + marketPhase;
    return DRIFT_TABLES.amp[horizon] * Math.sin(theta0 + (horizon - 1) * DRIFT_STEP / 2);
  }

  function bestDrift(t0, index, marketPhase) {
    const theta0 = t0 / DRIFT_DIV + index * 2 + marketPhase;
    const s = Math.sin(theta0), c = Math.cos(theta0);
    let best = { horizon: 0, sum: 0, ratio: 0 };
    for (let h = DRIFT_MIN_BARS; h <= DRIFT_MAX_BARS; h++) {
      const sum = DRIFT_TABLES.amp[h] * (s * DRIFT_TABLES.cosPhi[h] + c * DRIFT_TABLES.sinPhi[h]);
      const ratio = Math.abs(sum) / DRIFT_TABLES.root[h];
      if (ratio > best.ratio) best = { horizon: h, sum, ratio };
    }
    return best;
  }

  function driftSignalsFor(mode, t0) {
    const marketPhase = MARKET_PHASE[mode] ?? 0;
    const out = [];
    PAIRS.forEach((pair, index) => {
      const best = bestDrift(t0, index, marketPhase);
      if (Math.abs(best.sum) < DRIFT_MIN_SUM) return;
      out.push({ pair, index, value: best.sum, horizon: best.horizon, side: best.sum > 0 ? 1 : -1, ratio: best.ratio });
    });
    return out.sort((a, b) => b.ratio - a.ratio);
  }

  function emaSeries(values, period) {
    const k = 2 / (period + 1);
    const out = [];
    let prev = values[0];
    for (let i = 0; i < values.length; i++) {
      prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  }

  function rsiLast(values, period) {
    if (values.length < period + 1) return null;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = values[i] - values[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    gain /= period; loss /= period;
    for (let i = period + 1; i < values.length; i++) {
      const d = values[i] - values[i - 1];
      gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
      loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
    }
    if (loss === 0) return 100;
    return 100 - 100 / (1 + gain / loss);
  }

  function atrOf(candles, period) {
    if (candles.length < period + 1) return null;
    let sum = 0;
    for (let i = candles.length - period; i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1];
      sum += Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
    }
    return sum / period;
  }

  function bollinger(values, period, mult) {
    if (values.length < period) return null;
    const slice = values.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mean) * (b - mean), 0) / period);
    return { mid: mean, upper: mean + mult * sd, lower: mean - mult * sd };
  }

  // 回放序列同时带历史与未来：指标只允许读 cursor 及之前，future 仅供前瞻引擎
  function historyView(series) {
    if (!series || !Array.isArray(series.prices)) return null;
    const end = series.cursor >= 0 ? Math.min(series.cursor + 1, series.prices.length) : series.prices.length;
    return { prices: series.prices.slice(0, end), candles: (series.candles || []).slice(0, end) };
  }

  function computeIndicators(series, pair) {
    const view = historyView(series);
    if (!view || view.prices.length < MIN_BARS_FOR_SIGNAL) return null;
    const prices = view.prices;
    const last = prices.at(-1);
    const ema12 = emaSeries(prices, IND.EMA_FAST);
    const ema26 = emaSeries(prices, IND.EMA_SLOW);
    const e12 = ema12.at(-1);
    const e26 = ema26.at(-1);
    const macdLine = ema12.map((v, i) => v - ema26[i]);
    const macdSignal = emaSeries(macdLine.slice(-IND.MACD_WINDOW), IND.MACD_SIGNAL);
    const macdHist = macdLine.at(-1) - macdSignal.at(-1);
    const rsi14 = rsiLast(prices, IND.RSI);
    const atr14 = atrOf(view.candles, IND.ATR);
    const boll = bollinger(prices, IND.BOLL, IND.BOLL_MULT);
    const roc10 = prices.length > IND.ROC ? (last / prices[prices.length - (IND.ROC + 1)] - 1) : 0;
    const atrPct = atr14 && last ? atr14 / last : 0;
    const bollPos = boll && boll.upper > boll.lower ? (last - boll.lower) / (boll.upper - boll.lower) : 0.5;

    const trend = atr14 ? clamp((e12 - e26) / (atr14 * 0.6), -1, 1) : 0;
    const macdNorm = atr14 ? clamp(macdHist / (atr14 * 0.5), -1, 1) : 0;
    const rsiScore = rsi14 === null ? 0
      : rsi14 < RSI_OVERSOLD ? clamp((RSI_OVERSOLD - rsi14) / RSI_OVERSOLD, 0, 1)
        : rsi14 > RSI_OVERBOUGHT ? -clamp((rsi14 - RSI_OVERBOUGHT) / (100 - RSI_OVERBOUGHT), 0, 1)
          : (50 - rsi14) / 50 * 0.35;
    const bollScore = clamp((bollPos - 0.5) * 2, -1, 1);
    const rocNorm = atrPct > 0 ? clamp(roc10 / (atrPct * 3), -1, 1) : 0;
    const w = SCORE_WEIGHTS;
    const score = clamp(trend * w.TREND + macdNorm * w.MACD + rsiScore * w.RSI + bollScore * w.BOLL + rocNorm * w.ROC, -100, 100);
    return {
      pair, price: last, score,
      ema12: e12, ema26: e26, macdHist, rsi14, atr14, atrPct, boll, bollPos, roc10,
      source: series.source
    };
  }

  function parseFrankfurter(data) {
    return Object.entries(data.rates || {}).sort(([a], [b]) => a.localeCompare(b)).map(([date, r]) => {
      if (!['USD', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD'].every(k => Number.isFinite(r[k]) && r[k] > 0)) return null;
      return {
        date,
        prices: {
          'EUR/USD': r.USD, 'GBP/USD': r.USD / r.GBP, 'USD/JPY': r.JPY / r.USD,
          'USD/CHF': r.CHF / r.USD, 'EUR/CHF': r.CHF, 'AUD/USD': r.USD / r.AUD, 'USD/CAD': r.CAD / r.USD
        }
      };
    }).filter(Boolean);
  }

  function candlesFromPrices(prices) {
    return prices.map((c, i) => {
      const prev = i ? prices[i - 1] : c;
      return { o: prev, h: Math.max(prev, c), l: Math.min(prev, c), c };
    });
  }

  function lookaheadBias(series) {
    if (!series || !series.future || !series.future.length || series.cursor < 0) return null;
    const span = Math.min(LOOKAHEAD_HORIZON, series.future.length);
    const now = series.prices[series.cursor];
    const then = series.future[span - 1];
    if (!finite(now) || !finite(then) || now === 0) return null;
    return then / now - 1;
  }

  function currencyNotional(positions) {
    const map = new Map();
    for (const pos of positions) {
      const [base, quote] = String(pos.pair).split('/');
      if (!base || !quote) continue;
      const notional = finite(pos.margin) && finite(pos.leverage) ? pos.margin * pos.leverage : 0;
      const signed = notional * pos.side;
      map.set(base, (map.get(base) || 0) + signed);
      map.set(quote, (map.get(quote) || 0) - signed);
    }
    return map;
  }

  // 纯函数：给定 history 与 cfg 求半凯利比例（调用方负责按引用记忆化）
  function kellyFraction(history, cfg) {
    if (cfg.sizeMode !== SIZE_MODE.KELLY) return cfg.riskPct;
    const settled = Array.isArray(history) ? history.filter(h => !h.liquidated) : [];
    if (settled.length < KELLY_MIN_SAMPLE) return KELLY_DEFAULT;
    const wins = settled.filter(h => h.pnl > 0);
    const losses = settled.filter(h => h.pnl <= 0);
    const p = wins.length / settled.length;
    const avgWin = wins.length ? wins.reduce((a, h) => a + h.pnl, 0) / wins.length : 1;
    const avgLoss = losses.length ? Math.abs(losses.reduce((a, h) => a + h.pnl, 0) / losses.length) : 1;
    const b = avgLoss > 0 ? avgWin / avgLoss : 1;
    return clamp((p - (1 - p) / b) * KELLY_FRACTION, 0.08, 0.25);
  }

  /* ================================================================ 总线 */

  function createBus() {
    const handlers = new Map();
    let depth = 0;
    let dropped = 0;

    const on = (name, fn) => {
      let set = handlers.get(name);
      if (!set) { set = new Set(); handlers.set(name, set); }
      set.add(fn);
      return () => set.delete(fn);
    };

    const off = (name, fn) => {
      const set = handlers.get(name);
      if (set) set.delete(fn);
    };

    const emit = (name, payload) => {
      if (depth > 8) { dropped++; return; }
      const set = handlers.get(name);
      if (!set || !set.size) return;
      depth++;
      try {
        for (const fn of [...set]) {
          try { fn(payload); }
          catch (err) {
            if (name !== EV.LOG) emit(EV.LOG, { msg: '[' + name + '] ' + (err?.message ? err.message : String(err)) });
          }
        }
      } finally { depth--; }
    };

    return { on, off, emit, stats: () => ({ names: handlers.size, dropped }) };
  }

  /* ======================================================= 模块 1：bridge */

  function createBridge(bus) {
    const tools = Object.create(null);
    let lastSave = '';
    let via = 'none';
    let hooked = false;

    function pageWorldPolyfill(W) {
      var SAVE = 'fx-heartbeat-save-v3';
      var P = W.__FXQ_PAGE__ = W.__FXQ_PAGE__ || { tools: {}, lastSave: '' };
      var d = W.document;
      var prevReg = null;
      try {
        var prev = d.modelContext;
        if (prev && typeof prev.registerTool === 'function') prevReg = prev.registerTool.bind(prev);
      } catch {}
      var fake = {
        registerTool: function (tool) {
          try { if (tool?.name) P.tools[tool.name] = tool; } catch {}
          return prevReg ? prevReg(tool) : Promise.resolve(true);
        }
      };
      try { Object.defineProperty(d, 'modelContext', { configurable: true, get: function () { return fake; } }); } catch {}
      try {
        var proto = W.Storage && W.Storage.prototype;
        if (proto && typeof proto.setItem === 'function' && !proto.__fxqHooked) {
          var orig = proto.setItem;
          proto.setItem = function (k, v) { if (k === SAVE) P.lastSave = String(v); return orig.apply(this, arguments); };
          proto.__fxqHooked = true;
        }
      } catch {}
    }

    function installScriptBridge() {
      const doc = PAGE.document;
      const inject = () => {
        const host = doc.head || doc.documentElement;
        if (!host) { setTimeout(inject, 20); return; }
        try {
          const node = doc.createElement('script');
          node.textContent = '(' + pageWorldPolyfill.toString() + ')(window);';
          host.appendChild(node);
          node.remove();
        } catch (err) {
          bus.emit(EV.BRIDGE_BLOCKED, { reason: err?.message ? err.message : String(err) });
        }
      };
      inject();
    }

    function installDirectBridge() {
      const doc = PAGE.document;
      const capture = mc => {
        hooked = true;
        try {
          const orig = mc.registerTool;
          mc.registerTool = function (tool) {
            try { if (tool?.name) tools[tool.name] = tool; } catch {}
            return typeof orig === 'function' ? orig.apply(mc, arguments) : Promise.resolve(true);
          };
        } catch {}
      };

      try {
        const native = doc.modelContext;
        if (native && typeof native.registerTool === 'function') capture(native);
      } catch {}

      if (!hooked) {
        const fake = {
          registerTool(tool) {
            try { if (tool?.name) tools[tool.name] = tool; } catch {}
            hooked = true;
            return Promise.resolve(true);
          }
        };
        let ok = false;
        try {
          Object.defineProperty(doc, 'modelContext', { configurable: true, get: () => fake });
          ok = doc.modelContext === fake;
        } catch {}
        if (!ok) { try { doc.modelContext = fake; ok = doc.modelContext === fake; } catch {} }
      }

      try {
        const proto = PAGE.Storage && PAGE.Storage.prototype;
        if (proto && typeof proto.setItem === 'function') {
          const origSet = proto.setItem;
          proto.setItem = function (key, value) {
            if (key === SAVE_KEY) lastSave = String(value);
            return origSet.apply(this, arguments);
          };
        }
      } catch {}

      try { lastSave = PAGE.localStorage.getItem(SAVE_KEY) || ''; } catch {}
    }

    const pageTools = () => PAGE.__FXQ_PAGE__?.tools || null;

    function toolFor(name) {
      const local = tools[name];
      if (local && typeof local.execute === 'function') return local;
      const other = pageTools()?.[name];
      return other && typeof other.execute === 'function' ? other : null;
    }

    const has = name => !!toolFor(name);

    const call = (name, args) => {
      const tool = toolFor(name);
      if (!tool) return { status: STATUS.MISSING };
      try {
        const value = tool.execute(args || {});
        // 原生 WebMCP 的 execute 返回 Promise：同步链路等不到结果，必须明确失败而不是把 Promise 当数据
        if (value && typeof value.then === 'function') {
          return { status: STATUS.FAILED, error: new Error('工具 ' + name + ' 返回 Promise，同步通道不支持') };
        }
        return { status: STATUS.OK, value };
      } catch (err) {
        return { status: STATUS.FAILED, error: err };
      }
    };

    const readSave = (() => {
      let cachedRaw = null, cachedData = null;
      return () => {
        let raw = lastSave || PAGE.__FXQ_PAGE__?.lastSave || '';
        if (!raw) { try { raw = PAGE.localStorage.getItem(SAVE_KEY) || ''; } catch {} }
        if (raw === cachedRaw) return cachedData;
        try { cachedData = raw ? JSON.parse(raw) : null; } catch { cachedData = null; }
        cachedRaw = raw;
        return cachedData;
      };
    })();

    function init() {
      installDirectBridge();
      if (IS_SANDBOX) installScriptBridge();   // 同 world 时不需要注入
      const announce = () => {
        via = Object.keys(tools).length || Object.keys(pageTools() || {}).length ? 'api' : 'dom';
        bus.emit(EV.BRIDGE_READY, { via, call, has, readSave });
      };
      const timers = [];
      if (PAGE.document.readyState === 'complete') timers.push(setTimeout(announce, 0));
      else PAGE.addEventListener('load', announce, { once: true });
      timers.push(setTimeout(announce, REATTACH_MS));
      return {
        dispose() {
          for (const t of timers) clearTimeout(t);
          PAGE.removeEventListener('load', announce);
        },
        debug: {
          get tools() { return tools; },
          setTools(next) { for (const k of Object.keys(tools)) delete tools[k]; if (next) Object.assign(tools, next); },
          call, has, readSave,
          get via() { return via; }
        }
      };
    }

    return { init };
  }

  /* ======================================================== 模块 2：store */

  function createStore(bus) {
    let cfg = Object.assign({}, DEFAULTS);
    const debugLog = [];

    function init() {
      try {
        const raw = PAGE.localStorage.getItem(CFG_KEY);
        if (raw) cfg = Object.assign({}, DEFAULTS, JSON.parse(raw));
      } catch {}
      bus.on(EV.CONFIG_SAVE, ({ patch }) => {
        cfg = Object.assign({}, cfg, patch || {});
        try { PAGE.localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch {}
        bus.emit(EV.CONFIG_CHANGED, { cfg });
      });
      bus.on(EV.LOG, ({ msg }) => {
        if (debugLog.length >= 20) debugLog.shift();
        debugLog.push(msg);
      });
      // 初始广播交给引导层：此处 emit 时 data/engine/exec/ui 尚未订阅，事件会丢
      return { dispose() {}, debug: { get cfg() { return cfg; }, debugLog } };
    }

    return { init };
  }

  /* ========================================================= 模块 3：data */

  function createData(bus) {
    const state = {
      bridge: null,
      cfg: Object.assign({}, DEFAULTS),
      snap: { mode: 'sim', positions: [], prices: {}, cash: 0, equity: 0 },
      lastPrice: null,
      tickAt: Date.now(),
      barCount: 0,
      news: null,
      newsCache: { text: null, hit: null }
    };

    const readDomMoney = id => {
      const node = $(id);
      if (!node) return NaN;
      const n = Number(String(node.textContent).replace(/[^0-9.\-]/g, ''));
      return Number.isFinite(n) ? n : NaN;
    };

    function currentPairFromDom() {
      const title = $('pairTitle') ? String($('pairTitle').textContent).replace(/\s+/g, '') : '';
      return PAIRS.includes(title) ? title : PAIRS[0];
    }

    function domSnapshot() {
      const activeMode = ['simMode', 'realMode', 'battleMode', 'challengeMode']
        .map(id => $(id)).find(btn => btn?.classList.contains('active'));
      const mode = activeMode ? activeMode.id.replace('Mode', '') : 'sim';
      const pair = currentPairFromDom();
      const price = Number(String($('currentPrice')?.textContent || '').replace(/[^0-9.]/g, ''));
      const positions = [];
      PAGE.document.querySelectorAll('#positions .position-row').forEach((row, index) => {
        const headText = row.querySelector('.pos-name strong') ? String(row.querySelector('.pos-name strong').textContent) : '';
        const pairHit = PAIRS.find(p => headText.indexOf(p) === 0);
        const cells = row.querySelectorAll('.pos-cell strong');
        const pnlText = cells[2] ? String(cells[2].textContent).trim() : '';
        positions.push({
          id: 'dom-' + index,
          pair: pairHit || pair,
          side: headText.indexOf('做多') >= 0 ? 1 : -1,
          margin: NaN,
          leverage: state.cfg.leverage,
          entry: cells[0] ? Number(String(cells[0].textContent).replace(/[^0-9.]/g, '')) : NaN,
          pnl: Number(pnlText.replace(/[^0-9.]/g, '')) * (pnlText.charAt(0) === '-' ? -1 : 1)
        });
      });
      return {
        mode, battleId: null, challenge: null, date: null,
        cash: readDomMoney('cash'), debt: readDomMoney('debt'), equity: readDomMoney('equity'),
        prices: finite(price) ? { [pair]: price } : {},
        positions, via: 'dom'
      };
    }

    function snapshot() {
      const res = state.bridge ? state.bridge.call('read_fx_game_state') : null;
      if (res?.status === STATUS.OK && res.value?.prices) {
        const api = res.value;
        return {
          mode: api.mode, battleId: api.battleId, challenge: api.challenge, date: api.date,
          cash: api.cash, debt: api.debt, equity: api.equity, prices: api.prices,
          positions: (api.positions || []).map(p => ({
            id: p.id, pair: p.pair, side: p.side === 'long' ? 1 : -1,
            margin: p.margin, leverage: p.leverage, entry: p.entry, pnl: p.pnl
          })),
          via: 'api'
        };
      }
      return domSnapshot();
    }

    // 文本未变则不重新匹配（跑马灯整条文本 60~120 字，6 次 indexOf）
    function readNewsBias() {
      const node = $('tickerTrack');
      if (!node) return null;
      const text = String(node.textContent);
      if (text === state.newsCache.text) return state.newsCache.hit;
      const hit = NEWS_BIAS.find(item => text.indexOf('【' + item.tag + '】' + item.title) >= 0) || null;
      state.newsCache = { text, hit };
      return hit;
    }

    function collect() {
      const snap = snapshot();
      state.snap = snap;

      const priceNow = snap.prices[PAIRS[0]];
      if (finite(priceNow) && priceNow !== state.lastPrice) {
        state.lastPrice = priceNow;
        state.tickAt = Date.now();
        state.barCount++;
        bus.emit(EV.DATA_BAR, { at: state.tickAt, count: state.barCount });
      }

      const newsNow = readNewsBias();
      if (newsNow && state.news?.title !== newsNow.title) {
        state.news = { tag: newsNow.tag, title: newsNow.title, bias: newsNow.bias, at: Date.now() };
        bus.emit(EV.NEWS_CHANGED, { news: state.news });
      }

      bus.emit(EV.DATA_SNAPSHOT, { snap });
    }

    // 触发源：MutationObserver 对齐游戏 render；递归 setTimeout 兜底，间隔随页面可见性调整
    function watch() {
      const targets = ['#pairTitle', '#currentPrice', '#positions', '#equity', '#cash'];
      const seen = new Set();
      const mo = new MutationObserver(() => { collect(); });
      const attach = () => {
        for (const sel of targets) {
          const node = PAGE.document.querySelector(sel);
          if (!node || seen.has(node)) continue;
          seen.add(node);
          mo.observe(node, { childList: true, subtree: true, characterData: true });
        }
      };
      attach();
      const reattach = setInterval(attach, REATTACH_MS);
      const sweep = setInterval(() => bus.emit(EV.UI_SWEEP), SWEEP_MS);
      let stopped = false;
      let fallbackTimer = null;
      const schedule = () => {
        if (stopped) return;
        fallbackTimer = setTimeout(() => { collect(); schedule(); }, PAGE.document.hidden ? BACKGROUND_MS : FALLBACK_MS);
      };
      schedule();
      const onVisibility = () => { if (!PAGE.document.hidden) collect(); };
      PAGE.document.addEventListener('visibilitychange', onVisibility);
      return () => {
        stopped = true;
        mo.disconnect();
        clearInterval(reattach);
        clearInterval(sweep);
        clearTimeout(fallbackTimer);
        PAGE.document.removeEventListener('visibilitychange', onVisibility);
      };
    }

    function init() {
      let stopWatch = null;
      bus.on(EV.BRIDGE_READY, bridge => {
        state.bridge = bridge;
        if (!stopWatch) stopWatch = watch();
        collect();
      });
      bus.on(EV.CONFIG_CHANGED, ({ cfg }) => { state.cfg = cfg; });
      bus.on(EV.DATA_REQUEST, collect);
      return {
        dispose() { if (stopWatch) stopWatch(); },
        debug: { snapshot, collect, state }
      };
    }

    return { init };
  }

  /* ======================================================= 模块 4：series */

  function createSeries(bus) {
    const state = {
      bridge: null,
      cfg: Object.assign({}, DEFAULTS),
      sampled: new Map(),
      lastSampleAt: 0,
      historyCache: new Map(),
      seriesCache: new Map(),
      indCache: new Map(),
      tickAt: Date.now(),
      abort: new AbortController()
    };

    const log = msg => bus.emit(EV.LOG, { msg });

    function historyFor(mode) {
      const save = state.bridge?.readSave();
      const node = save?.accounts?.[mode];
      return node && Array.isArray(node.history) ? node.history : [];
    }

    function simSeries(pair) {
      const node = state.bridge?.readSave()?.sim?.[pair];
      if (!node || !Array.isArray(node.candles) || node.candles.length < 10) return null;
      const candles = node.candles.map(k => ({ o: k.open, h: k.high, l: k.low, c: k.close }));
      return { candles, prices: candles.map(k => k.c), source: '游戏存档K线 ' + candles.length + ' 根', future: null, cursor: -1 };
    }

    function sampledSeries(pair) {
      const buf = state.sampled.get(pair);
      if (!buf || buf.length < SAMPLE_MIN) return null;
      const prices = buf.map(p => p.c);
      return { candles: candlesFromPrices(prices), prices, source: '实时采样 ' + prices.length + ' 点', future: null, cursor: -1 };
    }

    function recordSample(snap) {
      const now = Date.now();
      if (now - state.lastSampleAt < SAMPLE_INTERVAL_MS) return;
      state.lastSampleAt = now;
      for (const pair of PAIRS) {
        const price = snap.prices[pair];
        if (!finite(price) || price <= 0) continue;
        let buf = state.sampled.get(pair);
        if (!buf) { buf = []; state.sampled.set(pair, buf); }
        const last = buf.at(-1);
        if (last && Math.abs(last.c - price) < 1e-12) continue;
        buf.push({ t: now, c: price });
        if (buf.length > SAMPLE_MAX) buf.shift();
      }
    }

    function rangeAround(dateStr, days) {
      const d = new Date(dateStr + 'T00:00:00Z');
      const start = new Date(d);
      const end = new Date(d);
      start.setUTCDate(start.getUTCDate() - days);
      end.setUTCDate(end.getUTCDate() + days);
      return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
    }

    async function fetchHistory(start, end) {
      const key = start + '~' + end;
      if (state.historyCache.has(key)) return state.historyCache.get(key);
      const url = 'https://api.frankfurter.dev/v1/' + start + '..' + end + '?base=EUR&symbols=' + FX_SYMBOLS;
      const res = await fetch(url, { signal: AbortSignal.any([AbortSignal.timeout(20000), state.abort.signal]) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const items = parseFrankfurter(await res.json());
      if (items.length < 5) throw new Error('历史数据不足');
      state.historyCache.set(key, items);
      return items;
    }

    async function fetchPlaybackSeries(snap, pair) {
      if (!snap.date) return null;
      const range = rangeAround(snap.date, LOOKAHEAD_SPAN_DAYS);
      let items;
      try { items = await fetchHistory(range.start, range.end); }
      catch (err) { log('历史序列拉取失败：' + (err?.message ? err.message : err)); return null; }
      const prices = items.map(row => row.prices[pair]);
      if (prices.length < 10) return null;
      const dates = items.map(row => row.date);
      const cursor = dates.indexOf(snap.date);
      return {
        candles: candlesFromPrices(prices), prices, dates, cursor,
        source: 'frankfurter ±' + LOOKAHEAD_SPAN_DAYS + 'd',
        future: cursor >= 0 ? prices.slice(cursor + 1) : null
      };
    }

    // 日期前进时只换 cursor，不重拉（±180 天内复用同一份 items）
    function reindex(series, date) {
      if (!date) return series;
      if (series.cursor >= 0 && series.dates[series.cursor] === date) return series;
      const cursor = series.dates.indexOf(date);
      return { ...series, cursor, future: cursor >= 0 ? series.prices.slice(cursor + 1) : null };
    }

    function getSeries(snap, pair) {
      if (snap.mode === 'sim') return simSeries(pair);
      if (snap.mode === 'challenge') return sampledSeries(pair);
      const key = snap.mode + '|' + (snap.battleId || '') + '|' + pair;
      const entry = state.seriesCache.get(key);
      if (entry && entry.data && Date.now() - entry.at < SERIES_TTL_MS) return reindex(entry.data, snap.date);
      if (!entry || !entry.busy) {
        const record = { busy: true, data: entry ? entry.data : null, at: entry ? entry.at : 0 };
        state.seriesCache.set(key, record);
        fetchPlaybackSeries(snap, pair)
          .then(data => { record.data = data; record.at = Date.now(); })
          .catch(() => { record.data = null; })
          .finally(() => { record.busy = false; });
      }
      return entry && entry.data ? reindex(entry.data, snap.date) : null;
    }

    // 三元组比较替代字符串键，省掉每轮 7 次字符串拼接
    function cachedIndicators(series, pair, mode) {
      if (!series) return null;
      const view = historyView(series);
      if (!view || !view.prices.length) return null;
      const n = view.prices.length;
      const last = view.prices[n - 1];
      const cursor = series.cursor ?? -1;
      const key = mode + '|' + pair;
      const hit = state.indCache.get(key);
      if (hit && hit.n === n && hit.last === last && hit.cursor === cursor) return hit.ind;
      const ind = computeIndicators(series, pair);
      state.indCache.set(key, { n, last, cursor, ind });
      return ind;
    }

    function candidatesFor(snap) {
      if (isDriftMode(snap.mode)) return PAIRS;
      const set = new Set([currentPairFromDom()]);
      snap.positions.forEach(p => set.add(p.pair));
      return [...set];
    }

    function currentPairFromDom() {
      const title = $('pairTitle') ? String($('pairTitle').textContent).replace(/\s+/g, '') : '';
      return PAIRS.includes(title) ? title : PAIRS[0];
    }

    // drift 模式下技术指标既不下单也不显示，整段跳过
    function buildContext(snap) {
      const ctx = { drift: [], driftByPair: new Map(), ranked: [], indMap: new Map(), best: null, history: [], getSeries: null };
      ctx.getSeries = pair => getSeries(snap, pair);
      if (isDriftMode(snap.mode)) {
        ctx.drift = driftSignalsFor(snap.mode, state.tickAt);
        for (const sig of ctx.drift) ctx.driftByPair.set(sig.pair, sig);
        ctx.history = historyFor(snap.mode);
        return ctx;
      }
      for (const pair of candidatesFor(snap)) {
        const ind = cachedIndicators(getSeries(snap, pair), pair, snap.mode);
        if (!ind) continue;
        ctx.indMap.set(pair, ind);
        ctx.ranked.push(ind);
      }
      ctx.best = ctx.ranked.reduce((best, ind) => !best || Math.abs(ind.score) > Math.abs(best.score) ? ind : best, null);
      ctx.history = historyFor(snap.mode);
      return ctx;
    }

    function onSnapshot({ snap }) {
      recordSample(snap);
      bus.emit(EV.SERIES_READY, { snap, ctx: buildContext(snap) });
    }

    function init() {
      bus.on(EV.BRIDGE_READY, bridge => { state.bridge = bridge; });
      bus.on(EV.CONFIG_CHANGED, ({ cfg }) => { state.cfg = cfg; });
      bus.on(EV.DATA_BAR, ({ at }) => { state.tickAt = at; });
      bus.on(EV.DATA_SNAPSHOT, onSnapshot);
      return {
        dispose() { state.abort.abort(); },
        debug: { getSeries, buildContext, state, historyFor }
      };
    }

    return { init };
  }

  /* ========================================================= 模块 5：engine */

  // ───────── 引擎纯函数：不捕获闭包，入参显式，可独立测试 ─────────

  function maxAffordable(cash, leverage) {
    return Math.max(0, Math.floor((cash / (1 + feeRate(leverage))) * 100) / 100);
  }

  function pairCooling(book, pair, side, now, mode) {
    const cooled = book.pairCooldown.get(pair);
    if (!cooled) return false;
    const cooldownMs = isDriftMode(mode) ? ENTRY_COOLDOWN_MS : ENTRY_COOLDOWN_FAST_MS;
    return now - cooled.at < cooldownMs && cooled.side === side;
  }

  function guardNewPosition(snap, pair, side, cfg, book, now) {
    if (snap.positions.some(p => p.pair === pair)) return false;
    if (snap.positions.length >= cfg.maxPositions) return false;
    if (snap.mode === 'challenge' && snap.challenge && !snap.challenge.active) return false;
    if (snap.mode === 'challenge' && snap.positions.length >= 5) return false;
    return !pairCooling(book, pair, side, now, snap.mode);
  }

  function sizePosition(snap, kelly, cfg, strength, weight) {
    const equity = finite(snap.equity) ? snap.equity : snap.cash;
    const margin = Math.min(
      Math.max(MIN_MARGIN, Math.round(equity * kelly * strength * weight)),
      maxAffordable(snap.cash, cfg.leverage)
    );
    return margin >= MIN_MARGIN ? margin : 0;
  }

  function exposureScale(snap, pair, side, margin, leverage) {
    const [base, quote] = String(pair).split('/');
    if (!base || !quote) return 1;
    const map = currencyNotional(snap.positions);
    const cap = (finite(snap.equity) ? snap.equity : snap.cash) * MAX_CCY_NOTIONAL_MULT;
    const notional = margin * leverage;
    let scale = 1;
    for (const [ccy, delta] of [[base, notional * side], [quote, -notional * side]]) {
      const cur = map.get(ccy) || 0;
      if (Math.abs(cur + delta) <= cap) continue;
      // 反向持仓降低敞口，放行；同向（含从零起步）按剩余额度等比缩减
      if (cur !== 0 && Math.sign(cur) !== Math.sign(delta)) continue;
      const allowed = Math.max(0, cap - Math.abs(cur));
      if (Math.abs(delta) > 0) scale = Math.min(scale, allowed / Math.abs(delta));
    }
    return clamp(scale, 0, 1);
  }

  // 所有引擎共用一道敞口闸：首仓、同向加仓、反向对冲都走这里
  function applyExposure(snap, plan) {
    const scale = exposureScale(snap, plan.pair, plan.side, plan.margin, plan.leverage);
    if (scale >= 1) return plan;
    const margin = Math.floor(plan.margin * scale);
    const floor = Math.max(MIN_MARGIN, Math.round((finite(snap.equity) ? snap.equity : snap.cash) * MIN_POSITION_RATIO));
    if (margin < floor) return null;
    return { ...plan, margin, note: plan.note + ' · 敞口' + Math.round(scale * 100) + '%' };
  }

  function activeNewsBias(news, now) {
    if (!news) return null;
    return now - news.at > NEWS_WINDOW_MS ? null : news;
  }

  // 前瞻只做方向确认：同向放大、反向削弱，不替换指标方向。
  // 关键：开仓与平仓必须用同一个分数，否则「前瞻开多、指标喊跌」会立刻触发反转平仓，反复摩擦。
  function fusedMap(ctx, cfg) {
    const out = new Map();
    if (!cfg.allowLookahead) return out;
    for (const ind of ctx.ranked) {
      const bias = lookaheadBias(ctx.getSeries(ind.pair));
      if (bias === null) continue;
      const dir = clamp(bias / LOOKAHEAD_SCALE, -1, 1);
      const same = dir * ind.score >= 0;
      const factor = same ? 1 + LOOKAHEAD_BOOST * Math.abs(dir) : LOOKAHEAD_CONFLICT;
      out.set(ind.pair, { score: clamp(ind.score * factor, -100, 100), bias, dir, same });
    }
    return out;
  }

  function planDrift(snap, ctx, cfg, book, kelly, news, now) {
    const active = activeNewsBias(news, now);
    for (const sig of ctx.drift) {
      if (!guardNewPosition(snap, sig.pair, sig.side, cfg, book, now)) continue;
      let weight = 1;
      let note = ' · 漂移' + (sig.value * 100).toFixed(2) + '%/' + sig.horizon + 't';
      if (active?.bias[sig.pair]) {
        const aligned = Math.sign(active.bias[sig.pair]) === sig.side;
        weight = aligned ? 1.3 : 0.6;
        note += aligned ? ' · 新闻顺风' : ' · 新闻逆风';
      }
      const strength = clamp(Math.abs(sig.value) / (DRIFT_MIN_SUM * 3), 0.5, 1);
      const margin = sizePosition(snap, kelly, cfg, strength, weight);
      if (!margin) continue;
      const capped = applyExposure(snap, { pair: sig.pair, side: sig.side, margin, leverage: cfg.leverage, note });
      if (!capped) continue;
      const stopRatio = clamp(0.25 + Math.abs(sig.value) / DRIFT_MIN_SUM * 0.05, STOP_MIN, STOP_MAX);
      return { ...capped, horizon: sig.horizon, score: sig.value * 10000, stopRatio };
    }
    return null;
  }

  // 前瞻引擎：real/battle 的价格就是 frankfurter 历史，future 是真实未来价（实测 ratio 1.000000）。
  // 扣掉手续费后仍有净空间才开仓，持有 LOOKAHEAD_HORIZON 个交易日后无条件平。
  function planLookahead(snap, ctx, cfg, book, kelly, now) {
    if (!cfg.allowLookahead) return null;
    const pairs = snap.mode === 'battle' && snap.pair ? [snap.pair] : PAIRS;
    let best = null;
    for (const pair of pairs) {
      const series = ctx.getSeries(pair);
      if (!series || series.cursor < 0 || !series.future || series.future.length < LOOKAHEAD_HORIZON) continue;
      const at = series.prices[series.cursor];
      const then = series.future[LOOKAHEAD_HORIZON - 1];
      if (!finite(at) || !finite(then) || at <= 0) continue;
      const bias = then / at - 1;
      const fee = 0.00005 + cfg.leverage * 0.000005;
      const net = Math.abs(bias) - fee;
      if (net < LOOKAHEAD_MIN_NET) continue;
      if (!best || net > best.net) best = { pair, bias, net };
    }
    if (!best) return null;
    const side = best.bias > 0 ? 1 : -1;
    if (!guardNewPosition(snap, best.pair, side, cfg, book, now)) return null;
    const margin = sizePosition(snap, kelly, cfg, clamp(best.net / LOOKAHEAD_SCALE, 0.4, 1), 1);
    if (!margin) return null;
    return applyExposure(snap, {
      pair: best.pair, side, margin, leverage: cfg.leverage,
      score: best.bias * 10000, stopRatio: STOP_RATIO,
      note: ' · 前瞻' + (best.bias >= 0 ? '+' : '') + (best.bias * 100).toFixed(2) + '% · 净' + (best.net * 100).toFixed(2) + '%',
      horizon: LOOKAHEAD_HORIZON
    });
  }

  function planIndicator(snap, ctx, cfg, book, kelly, now) {
    const order = ctx.ranked.toSorted((a, b) => Math.abs(b.score) - Math.abs(a.score));
    for (const ind of order) {
      const fused = ctx.fused?.get(ind.pair) || null;
      const score = fused ? fused.score : ind.score;
      const note = fused ? ' · 前瞻' + (fused.bias >= 0 ? '+' : '') + (fused.bias * 100).toFixed(2) + '%' : '';
      if (Math.abs(score) < SIGNAL_THRESHOLD) continue;
      const side = score > 0 ? 1 : -1;
      if (!guardNewPosition(snap, ind.pair, side, cfg, book, now)) continue;
      const margin = sizePosition(snap, kelly, cfg, clamp(Math.abs(score) / 100, 0.4, 1), 1);
      if (!margin) continue;
      const capped = applyExposure(snap, { pair: ind.pair, side, margin, leverage: cfg.leverage, score, stopRatio: STOP_RATIO, note, horizon: fused ? LOOKAHEAD_HORIZON : undefined });
      if (capped) return capped;
    }
    return null;
  }

  // 返回 { exits, warnings }；entryBars 的新登记与清理显式写在传入的 book 上
  function computeExits(snap, ctx, cfg, book, barCount) {
    const exits = [];
    const warnings = [];
    const driftMode = isDriftMode(snap.mode);
    for (const pos of snap.positions) {
      if (!book.managed.has(pos.id)) continue;   // 手动仓位不自动处置，需显式接管
      if (!book.entryBars.has(pos.id)) book.entryBars.set(pos.id, barCount);
      if (!finite(pos.margin) || pos.margin <= 0) {
        if (!book.warnedIds.has(pos.id)) {
          book.warnedIds.add(pos.id);
          warnings.push(pos.pair + ' 缺少保证金数据，自动风控跳过（DOM 通道限制）');
        }
        continue;
      }
      const lossRatio = -pos.pnl / pos.margin;
      const stop = book.stopRatio.get(pos.id) ?? STOP_RATIO;
      if (lossRatio >= stop) { exits.push({ position: pos, reason: '止损' }); continue; }
      // 到期平仓对两种引擎都生效：前瞻只看 LOOKAHEAD_HORIZON 天，到期必须走，否则利润回吐
      const exitAt = book.exitBars.get(pos.id);
      if (exitAt != null && barCount >= exitAt) { exits.push({ position: pos, reason: '到期' }); continue; }
      if (driftMode) {
        const sig = ctx.driftByPair.get(pos.pair);
        if (sig && sig.side !== pos.side) { exits.push({ position: pos, reason: '反手' }); continue; }
        continue;
      }
      if (pos.pnl > 0 && pos.pnl / pos.margin >= cfg.takeProfitRatio) { exits.push({ position: pos, reason: '止盈' }); continue; }
      const ind = ctx.indMap.get(pos.pair);
      if (ind && exitAt == null) {   // 前瞻仓到期前不看指标，否则真先知会被滞后指标砍掉
        const ref = (ctx.fused?.get(pos.pair) || ind).score;
        const against = pos.side === 1 ? ref <= -cfg.reverseExitScore : ref >= cfg.reverseExitScore;
        if (against) { exits.push({ position: pos, reason: '反转' }); continue; }
      }
      if (barCount - book.entryBars.get(pos.id) >= cfg.timeStopBars && pos.pnl <= 0) {
        exits.push({ position: pos, reason: '时间止损' });
      }
    }
    const alive = new Set(snap.positions.map(p => p.id));
    for (const id of book.entryBars.keys()) {
      if (!alive.has(id)) { book.entryBars.delete(id); book.exitBars.delete(id); book.stopRatio.delete(id); }
    }
    for (const id of book.managed) if (!alive.has(id)) book.managed.delete(id);
    for (const id of book.warnedIds) if (!alive.has(id)) book.warnedIds.delete(id);
    return { exits, warnings };
  }

  // ───────── 引擎装配：只保留状态与编排 ─────────

  function createEngine(bus) {
    let cfg = Object.assign({}, DEFAULTS);

    // 计时类
    const timing = { tickAt: Date.now(), barCount: 0, lastActionAt: 0, suppressUntil: 0 };
    // 持仓记账
    const book = {
      managed: new Set(),      // 受管持仓 id：只有脚本开出的仓位才自动退出
      warnedIds: new Set(),    // 缺少保证金数据的持仓只告警一次
      entryBars: new Map(),
      exitBars: new Map(),
      stopRatio: new Map(),
      pairCooldown: new Map()
    };
    // 信号快照
    const signal = { snap: null, news: null, pending: null };

    // history 引用未变则不重算（每轮 sizePosition 会调 1~7 次）
    let kellyCache = { history: null, sizeMode: null, riskPct: null, value: KELLY_DEFAULT };
    function kelly(history) {
      const c = kellyCache;
      if (c.history === history && c.sizeMode === cfg.sizeMode && c.riskPct === cfg.riskPct) return c.value;
      const value = kellyFraction(history, cfg);
      kellyCache = { history, sizeMode: cfg.sizeMode, riskPct: cfg.riskPct, value };
      return value;
    }

    function onSeries({ snap, ctx }) {
      signal.snap = snap;
      ctx.fused = fusedMap(ctx, cfg);
      const now = Date.now();
      const { exits, warnings } = computeExits(snap, ctx, cfg, book, timing.barCount);
      for (const msg of warnings) bus.emit(EV.LOG, { msg });
      if (exits.length) bus.emit(EV.ENGINE_EXITS, { exits });
      const k = kelly(ctx.history);
      const plan = isDriftMode(snap.mode)
        ? planDrift(snap, ctx, cfg, book, k, signal.news, now)
        : (planLookahead(snap, ctx, cfg, book, k, now) || planIndicator(snap, ctx, cfg, book, k, now));
      signal.pending = plan;
      bus.emit(EV.ENGINE_PLAN, { plan });
    }

    // 显式接管：把当前所有持仓纳入自动风控（手动仓位默认不受管）
    function adoptAll() {
      let added = 0;
      for (const pos of signal.snap?.positions || []) {
        if (book.managed.has(pos.id)) continue;
        book.managed.add(pos.id);
        added++;
      }
      bus.emit(EV.LOG, { msg: '接管 ' + added + ' 笔持仓，纳入自动风控' });
      return added;
    }

    // debug.state 保持「活对象」语义：读拿当前值，写直接落到内部状态
    const debugState = {};
    const link = (name, get, set) => Object.defineProperty(debugState, name, { get, set, enumerable: true, configurable: true });
    link('cfg', () => cfg, v => { cfg = v; });
    link('tickAt', () => timing.tickAt, v => { timing.tickAt = v; });
    link('barCount', () => timing.barCount, v => { timing.barCount = v; });
    link('lastActionAt', () => timing.lastActionAt, v => { timing.lastActionAt = v; });
    link('suppressUntil', () => timing.suppressUntil, v => { timing.suppressUntil = v; });
    link('snap', () => signal.snap, v => { signal.snap = v; });
    link('news', () => signal.news, v => { signal.news = v; });
    link('pending', () => signal.pending, v => { signal.pending = v; });
    link('managed', () => book.managed, v => { book.managed = v; });
    link('warnedIds', () => book.warnedIds, v => { book.warnedIds = v; });
    link('entryBars', () => book.entryBars, v => { book.entryBars = v; });
    link('exitBars', () => book.exitBars, v => { book.exitBars = v; });
    link('stopRatio', () => book.stopRatio, v => { book.stopRatio = v; });
    link('pairCooldown', () => book.pairCooldown, v => { book.pairCooldown = v; });
    link('kellyCache', () => kellyCache, v => { kellyCache = v; });

    function init() {
      bus.on(EV.CONFIG_CHANGED, ({ cfg: next }) => { cfg = next; });
      bus.on(EV.DATA_BAR, ({ at, count }) => { timing.tickAt = at; timing.barCount = count; });
      bus.on(EV.NEWS_CHANGED, ({ news }) => { signal.news = news; });
      bus.on(EV.SERIES_READY, onSeries);
      bus.on(EV.EXEC_OPENED, ({ position, plan }) => {
        if (!position) return;
        book.managed.add(position.id);
        if (plan.horizon != null) book.exitBars.set(position.id, timing.barCount + plan.horizon);
        book.stopRatio.set(position.id, plan.stopRatio || STOP_RATIO);
        timing.lastActionAt = Date.now();
      });
      bus.on(EV.EXEC_CLOSED, ({ position }) => {
        if (!position) return;
        book.pairCooldown.set(position.pair, { at: Date.now(), side: position.side });
      });
      bus.on(EV.UI_COMMAND, ({ cmd, value }) => {
        if (cmd === 'suppress') timing.suppressUntil = Date.now() + (value || SUPPRESS_MS);
        if (cmd === 'action') timing.lastActionAt = Date.now();
        if (cmd === 'adopt') adoptAll();
      });
      return {
        dispose() {},
        debug: {
          // 对外签名保持 (snap, ctx)，backtest / test-contract 无需改动
          state: debugState,
          computeExits: (snap, ctx) => computeExits(snap, ctx, cfg, book, timing.barCount).exits,
          planDrift: (snap, ctx) => planDrift(snap, ctx, cfg, book, kelly(ctx.history), signal.news, Date.now()),
          planLookahead: (snap, ctx) => planLookahead(snap, ctx, cfg, book, kelly(ctx.history), Date.now()),
          planIndicator: (snap, ctx) => planIndicator(snap, ctx, cfg, book, kelly(ctx.history), Date.now()),
          adoptAll,
          get pending() { return signal.pending; }
        }
      };
    }

    return { init };
  }

  /* ========================================================= 模块 6：exec */

  function createExec(bus) {
    const state = {
      cfg: Object.assign({}, DEFAULTS),
      bridge: null,
      lastActionAt: 0,
      lastAdvanceAt: 0,
      suppressUntil: 0,
      pending: null,
      fastForward: { active: false, remaining: 0 }
    };
    const closeQueue = { active: false, remaining: 0, lastCount: Infinity };
    const log = msg => bus.emit(EV.LOG, { msg });

    function setField(id, value) {
      const node = $(id);
      if (!node) return false;
      node.value = String(value);
      node.dispatchEvent(new PAGE.Event('input', { bubbles: true }));
      node.dispatchEvent(new PAGE.Event('change', { bubbles: true }));
      return true;
    }

    const call = (name, args) => state.bridge ? state.bridge.call(name, args) : { status: STATUS.MISSING };

    function openTrade(plan) {
      const res = call('place_fx_trade', { pair: plan.pair, side: plan.side === 1 ? 'long' : 'short', margin: plan.margin, leverage: plan.leverage });
      if (res.status === STATUS.OK) {
        log('开仓 ' + plan.pair + (plan.side === 1 ? ' 做多' : ' 做空') + ' 保证金 ' + money(plan.margin) + ' @' + plan.leverage + 'x');
        return true;
      }
      if (res.status === STATUS.FAILED) {
        log('开仓被拒：' + (res.error?.message ? res.error.message : String(res.error)));
        return false;
      }
      setField('leverageRange', plan.leverage);
      setField('marginInput', plan.margin);
      for (const row of PAGE.document.querySelectorAll('#pairList .pair-row')) {
        if (String(row.textContent).indexOf(plan.pair) === 0) { row.click(); break; }
      }
      const btn = $(plan.side === 1 ? 'longBtn' : 'shortBtn');
      if (!btn) { log('找不到下单按钮'); return false; }
      btn.click();
      log('开仓(DOM) ' + plan.pair + (plan.side === 1 ? ' 做多' : ' 做空') + ' 保证金 ' + money(plan.margin));
      return true;
    }

    function domCloseRow(position) {
      const rows = Array.from(PAGE.document.querySelectorAll('#positions .position-row'));
      if (!rows.length) return null;
      const sideText = position.side === 1 ? '做多' : '做空';
      return rows.find(row => {
        const text = String(row.textContent);
        return text.indexOf(position.pair) >= 0 && text.indexOf(sideText) >= 0;
      }) || null;
    }

    function closeTrade(position, reason) {
      if (!position) return false;
      const res = call('close_fx_trade', { id: position.id });
      if (res.status === STATUS.OK) {
        log('平仓 ' + position.pair + (reason ? '(' + reason + ')' : '') + ' 盈亏 ' + signedMoney(position.pnl || 0));
        bus.emit(EV.EXEC_CLOSED, { position, reason });
        return true;
      }
      if (res.status === STATUS.FAILED) {
        log('平仓被拒：' + (res.error?.message ? res.error.message : String(res.error)));
        return false;
      }
      const btn = domCloseRow(position)?.querySelector('button');
      if (!btn) return false;
      btn.click();
      log('平仓(DOM) ' + position.pair + (reason ? '(' + reason + ')' : ''));
      bus.emit(EV.EXEC_CLOSED, { position, reason });
      return true;
    }

    function advanceDay() {
      if (call('advance_real_fx_day').status === STATUS.OK) return true;
      const btn = $('nextDayBtn');
      if (btn && !btn.classList.contains('hidden')) { btn.click(); return true; }
      return false;
    }

    // 弹窗节点是静态 HTML，缓存引用省掉每 1.5s 三次 getElementById
    let modalRefs = null;
    const refs = () => (modalRefs || (modalRefs = { modal: $('modal'), cancel: $('modalCancel'), confirm: $('modalConfirm') }));

    // 只清理「无 modalAction」的弹窗：modalCancel 的显隐是 openModal 里 action 有无的镜像
    function sweepModals() {
      const r = refs();
      if (!r.modal || r.modal.classList.contains('hidden')) return false;
      if (r.cancel && !r.cancel.classList.contains('hidden')) return false;
      if (!r.confirm) return false;
      r.confirm.click();
      return true;
    }

    function startCloseAll() {
      bus.emit(EV.UI_COMMAND, { cmd: 'suppress', value: SUPPRESS_MS });
      closeQueue.active = true;
      closeQueue.remaining = 20;
      closeQueue.lastCount = Infinity;
      bus.emit(EV.DATA_REQUEST);
    }

    // 判据是「持仓数必须严格递减」：DOM 通道的 id 是下标，平仓后会重编号
    function pumpCloseAll(snap) {
      if (!closeQueue.active) return;
      const count = snap.positions.length;
      if (!count) { closeQueue.active = false; return; }
      if (count >= closeQueue.lastCount) {
        closeQueue.active = false;
        log('全平中止：' + snap.positions[0].pair + ' 未能平仓');
        return;
      }
      if (--closeQueue.remaining < 0) { closeQueue.active = false; return; }
      closeQueue.lastCount = count;
      closeTrade(snap.positions[0], '全平');
    }

    // 开仓后必须回读真实持仓：DOM 通道点击成功不等于成交，未核验就登记风控会静默失效
    function verifyPosition(plan) {
      const res = call('read_fx_game_state');
      if (res.status !== STATUS.OK) return null;
      const raw = (res.value.positions || []).find(p => p.pair === plan.pair && (p.side === 'long' ? 1 : -1) === plan.side);
      return raw ? { id: raw.id, pair: raw.pair, side: raw.side === 'long' ? 1 : -1, margin: raw.margin, leverage: raw.leverage, entry: raw.entry, pnl: raw.pnl } : null;
    }

    function commit(plan) {
      if (!openTrade(plan)) return false;
      const position = verifyPosition(plan);
      if (!position) { log('开仓未核验到持仓，风控未登记：' + plan.pair); return false; }
      bus.emit(EV.EXEC_OPENED, { position, plan });
      return true;
    }

    function execute(plan) {
      if (!plan || state.cfg.automation !== MODE.AUTO) return;
      const now = Date.now();
      if (now <= state.suppressUntil || now - state.lastActionAt <= ACTION_COOLDOWN_MS) return;
      state.lastActionAt = now;
      bus.emit(EV.UI_COMMAND, { cmd: 'action' });
      commit(plan);
    }

    function init() {
      bus.on(EV.BRIDGE_READY, bridge => { state.bridge = bridge; });
      bus.on(EV.CONFIG_CHANGED, ({ cfg }) => { state.cfg = cfg; });
      bus.on(EV.ENGINE_PLAN, ({ plan }) => { state.pending = plan; execute(plan); });
      bus.on(EV.ENGINE_EXITS, ({ exits }) => { for (const exit of exits) closeTrade(exit.position, exit.reason); });
      bus.on(EV.UI_SWEEP, () => { sweepModals(); });
      bus.on(EV.UI_COMMAND, ({ cmd, value }) => {
        if (cmd === 'suppress') state.suppressUntil = Date.now() + (value || SUPPRESS_MS);
        if (cmd === 'closeall') startCloseAll();
        if (cmd === 'exec') {
          if (!state.pending) { log('当前没有待执行信号'); return; }
          commit(state.pending);
        }
        if (cmd === 'fast') {
          state.fastForward.active = true;
          state.fastForward.remaining = value || 30;
          log('快进 ' + state.fastForward.remaining + ' 个交易日（风控全程生效）');
        }
      });
      bus.on(EV.DATA_SNAPSHOT, ({ snap }) => {
        pumpCloseAll(snap);
        if (state.fastForward.active) {
          if (isDriftMode(snap.mode)) { state.fastForward.active = false; log('快进只用于真实回放 / 经典战役'); return; }
          if (state.fastForward.remaining > 0) {
            if (advanceDay()) state.fastForward.remaining--;
            else { state.fastForward.active = false; log('快进中断'); }
          } else {
            state.fastForward.active = false;
            log('快进结束');
          }
          return;
        }
        // 回放模式全自动：按 DAY_ADVANCE_MS 节奏推进交易日
        if (!isDriftMode(snap.mode) && state.cfg.automation === MODE.AUTO) {
          const now = Date.now();
          if (now - state.lastAdvanceAt < DAY_ADVANCE_MS) return;
          state.lastAdvanceAt = now;
          advanceDay();
        }
      });
      return {
        dispose() {},
        debug: { closeAllPositions: startCloseAll, sweepModals, openTrade, closeTrade, advanceDay, commit, verifyPosition, state, get pending() { return state.pending; } }
      };
    }

    return { init };
  }

  /* ======================================================== 模块 7：input */

  function createInput(bus) {
    const state = { root: null, head: null, mobile: false, collapsed: false, query: null, dragging: false };
    let cleanup = [];

    function persist(key, value) {
      try { PAGE.localStorage.setItem(key, value); } catch {}
    }

    function clampToViewport(x, y) {
      const rect = state.root.getBoundingClientRect();
      return {
        x: clamp(x, 0, Math.max(0, PAGE.innerWidth - rect.width)),
        y: clamp(y, 0, Math.max(0, PAGE.innerHeight - rect.height))
      };
    }

    function applyPosition(left, top) {
      const next = clampToViewport(left, top);
      state.root.style.right = 'auto';
      state.root.style.bottom = 'auto';
      state.root.style.left = next.x + 'px';
      state.root.style.top = next.y + 'px';
    }

    function restorePosition() {
      try {
        const raw = PAGE.localStorage.getItem(POS_KEY);
        if (!raw) return;
        const pos = JSON.parse(raw);
        if (!pos?.left || !pos?.top) return;
        applyPosition(parseFloat(pos.left) || 12, parseFloat(pos.top) || 12);
      } catch {}
    }

    function setCollapsed(next) {
      state.collapsed = next;
      state.root.classList.toggle('fxq-collapsed', next);
      const fold = state.root.querySelector('[data-fxq="fold"]');
      if (fold) fold.textContent = next ? '+' : '—';
      persist(FOLD_KEY, next ? '1' : '0');
      bus.emit(EV.UI_STATE, { collapsed: next, mobile: state.mobile });
    }

    function applyBreakpoint() {
      const wasMobile = state.mobile;
      state.mobile = state.query ? state.query.matches : PAGE.innerWidth <= MOBILE_BREAKPOINT;
      state.root.classList.toggle('fxq-mobile', state.mobile);
      // 移动端首次进入默认折叠：展开态 300×500 会盖住下单区
      if (state.mobile && !wasMobile) {
        let saved = null;
        try { saved = PAGE.localStorage.getItem(FOLD_KEY); } catch {}
        if (saved === '1' || saved === null) { setCollapsed(true); return; }
      }
      bus.emit(EV.UI_STATE, { collapsed: state.collapsed, mobile: state.mobile });
    }

    // Pointer Events：鼠标 / 触摸 / 笔同一套；setPointerCapture 保证移出元素也跟手
    function makeDraggable() {
      const head = state.head;
      let sx = 0, sy = 0, ox = 0, oy = 0, pid = null;

      const onDown = e => {
        if (e.target.classList.contains('fxq-btn')) return;
        const rect = state.root.getBoundingClientRect();
        state.dragging = true;
        pid = e.pointerId;
        sx = e.clientX; sy = e.clientY; ox = rect.left; oy = rect.top;
        state.root.style.right = 'auto';
        state.root.style.bottom = 'auto';
        state.root.style.left = ox + 'px';
        state.root.style.top = oy + 'px';
        try { head.setPointerCapture(pid); } catch {}
        e.preventDefault();
      };

      const onMove = e => {
        if (!state.dragging || e.pointerId !== pid) return;
        applyPosition(ox + e.clientX - sx, oy + e.clientY - sy);
      };

      const onUp = e => {
        if (!state.dragging || (pid !== null && e.pointerId !== pid)) return;
        state.dragging = false;
        try { head.releasePointerCapture(pid); } catch {}
        pid = null;
        persist(POS_KEY, JSON.stringify({ left: state.root.style.left, top: state.root.style.top }));
      };

      head.addEventListener('pointerdown', onDown);
      head.addEventListener('pointermove', onMove);
      head.addEventListener('pointerup', onUp);
      head.addEventListener('pointercancel', onUp);
      cleanup.push(() => {
        head.removeEventListener('pointerdown', onDown);
        head.removeEventListener('pointermove', onMove);
        head.removeEventListener('pointerup', onUp);
        head.removeEventListener('pointercancel', onUp);
      });
    }

    function init() {
      bus.on(EV.UI_MOUNTED, ({ root, head }) => {
        state.root = root;
        state.head = head;
        makeDraggable();
        restorePosition();

        const fold = root.querySelector('[data-fxq="fold"]');
        if (fold) fold.addEventListener('click', () => setCollapsed(!state.collapsed));

        if (PAGE.matchMedia) {
          state.query = PAGE.matchMedia('(max-width: ' + MOBILE_BREAKPOINT + 'px)');
          const onChange = () => applyBreakpoint();
          if (state.query.addEventListener) state.query.addEventListener('change', onChange);
          else if (state.query.addListener) state.query.addListener(onChange);
          cleanup.push(() => {
            if (state.query.removeEventListener) state.query.removeEventListener('change', onChange);
            else if (state.query.removeListener) state.query.removeListener(onChange);
          });
        }
        const onViewport = () => applyBreakpoint();
        if (PAGE.visualViewport) {
          PAGE.visualViewport.addEventListener('resize', onViewport);
          cleanup.push(() => PAGE.visualViewport.removeEventListener('resize', onViewport));
        }
        applyBreakpoint();
      });
      return {
        dispose() { for (const fn of cleanup) fn(); cleanup = []; },
        debug: { state, applyBreakpoint, setCollapsed, restorePosition }
      };
    }

    return { init };
  }

  /* =========================================================== 模块 8：ui */

  function createUi(bus) {
    const ui = { ready: false, root: null, collapsed: false, mobile: false };
    const state = { cfg: Object.assign({}, DEFAULTS), snap: null, ctx: null, plan: null };
    const logLines = [];
    const log = msg => bus.emit(EV.LOG, { msg });

    const CSS = [
      '.fxq-panel{position:fixed;left:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));width:302px;z-index:2147483000;',
      'font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;',
      'color:#e8f3ee;background:linear-gradient(160deg,rgba(18,38,40,.97),rgba(10,23,25,.98));',
      'border:1px solid rgba(120,200,170,.28);border-radius:14px;box-shadow:0 18px 44px rgba(0,0,0,.45);',
      'backdrop-filter:blur(10px);overflow:hidden;user-select:none;max-width:calc(100vw - 24px);',
      'max-height:calc(100dvh - 24px);display:flex;flex-direction:column}',
      '.fxq-panel.fxq-collapsed{width:auto}',
      '.fxq-panel.fxq-collapsed .fxq-body{display:none}',
      '.fxq-head{display:flex;align-items:center;gap:8px;padding:9px 11px;cursor:move;',
      'background:rgba(255,255,255,.04);border-bottom:1px solid rgba(120,200,170,.16);',
      'touch-action:none;min-height:34px;flex:0 0 auto}',
      '.fxq-title{font-weight:600;letter-spacing:.4px;flex:1;font-size:12px}',
      '.fxq-dot{width:7px;height:7px;border-radius:50%;background:#57cf9b;box-shadow:0 0 8px #57cf9b;flex:0 0 auto}',
      '.fxq-dot.warn{background:#efb35f;box-shadow:0 0 8px #efb35f}',
      '.fxq-dot.bad{background:#ef8ba0;box-shadow:0 0 8px #ef8ba0}',
      '.fxq-btn{border:1px solid rgba(120,200,170,.35);background:rgba(120,200,170,.1);color:#cdeee0;',
      'border-radius:7px;padding:2px 7px;font-size:11px;cursor:pointer;font-family:inherit;',
      'min-height:26px;touch-action:manipulation}',
      '.fxq-btn:hover{background:rgba(120,200,170,.22)}',
      '.fxq-btn.on{background:#57cf9b;border-color:#57cf9b;color:#08201a;font-weight:600}',
      '.fxq-body{padding:9px 11px 11px;display:flex;flex-direction:column;gap:8px;overflow:auto;overscroll-behavior:contain}',
      '.fxq-row{display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap}',
      '.fxq-kv{display:grid;grid-template-columns:repeat(3,1fr);gap:4px 6px}',
      '.fxq-kv div{background:rgba(255,255,255,.045);border-radius:6px;padding:3px 6px;min-width:0}',
      '.fxq-kv span{display:block;font-size:10px;color:#7fa79a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.fxq-kv b{font-size:11.5px;font-weight:600}',
      '.fxq-bar{height:7px;border-radius:4px;background:rgba(255,255,255,.09);position:relative;overflow:hidden}',
      '.fxq-bar i{position:absolute;top:0;bottom:0;left:50%;width:2px;background:rgba(255,255,255,.35)}',
      '.fxq-bar b{position:absolute;top:0;bottom:0;border-radius:4px;transition:all .2s}',
      '.fxq-sig{font-weight:600;font-size:13px}',
      '.fxq-log{max-height:76px;overflow:auto;font-size:10.5px;line-height:1.45;color:#8fb5a7;',
      'background:rgba(0,0,0,.24);border-radius:7px;padding:5px 7px;white-space:pre-wrap;word-break:break-all}',
      '.fxq-advice{background:rgba(87,207,155,.1);border:1px solid rgba(87,207,155,.3);border-radius:8px;padding:6px 8px}',
      '.fxq-advice.sell{background:rgba(239,139,160,.1);border-color:rgba(239,139,160,.32)}',
      '.fxq-seg{display:flex;gap:4px}',
      '.fxq-seg .fxq-btn{flex:1;text-align:center}',
      '.fxq-hint{font-size:10px;color:#6f9488}',
      '.fxq-hint b{cursor:pointer;border-bottom:1px dashed rgba(120,200,170,.45)}',
      '.fxq-hint b:hover{color:#57cf9b}',
      '.fxq-pos{font-size:10.5px;color:#9dc4b6;word-break:break-all}',
      '.fxq-up{color:#57cf9b}.fxq-down{color:#ef8ba0}',
      '.fxq-panel.fxq-mobile{width:min(302px,calc(100vw - 24px));font-size:11px}',
      '.fxq-panel.fxq-mobile .fxq-head{padding:11px 12px;min-height:44px}',
      '.fxq-panel.fxq-mobile .fxq-btn{min-height:32px;padding:4px 9px;font-size:12px}',
      '.fxq-panel.fxq-mobile .fxq-body{padding:10px 12px 12px;gap:9px}',
      '.fxq-panel.fxq-mobile .fxq-log{max-height:60px}'
    ].join('');

    const PANEL_HTML = [
      '<div class="fxq-head"><span class="fxq-dot" data-fxq="dot"></span>',
      '<span class="fxq-title">FX 量化辅助台</span>',
      '<button class="fxq-btn" data-fxq="fold">—</button></div>',
      '<div class="fxq-body">',
      '  <div class="fxq-row"><span class="fxq-hint" data-fxq="via">通道</span>',
      '    <span class="fxq-hint" data-fxq="mode">模式</span></div>',
      '  <div class="fxq-row"><span class="fxq-sig" data-fxq="sig">—</span>',
      '    <span class="fxq-hint" data-fxq="src"></span></div>',
      '  <div class="fxq-bar"><i></i><b data-fxq="bar" style="left:50%;width:0"></b></div>',
      '  <div class="fxq-kv">',
      '    <div><span data-fxq="k1">EMA12/26</span><b data-fxq="ema">—</b></div>',
      '    <div><span>RSI14</span><b data-fxq="rsi">—</b></div>',
      '    <div><span>ATR</span><b data-fxq="atr">—</b></div>',
      '    <div><span>MACD</span><b data-fxq="macd">—</b></div>',
      '    <div><span>布林位</span><b data-fxq="boll">—</b></div>',
      '    <div><span>动量</span><b data-fxq="roc">—</b></div>',
      '  </div>',
      '  <div class="fxq-advice" data-fxq="advice">等待信号…</div>',
      '  <div class="fxq-row"><span class="fxq-hint">自动开仓</span>',
      '    <div class="fxq-seg">',
      '      <button class="fxq-btn" data-fxq="auto-off">关</button>',
      '      <button class="fxq-btn" data-fxq="auto-confirm">确认</button>',
      '      <button class="fxq-btn" data-fxq="auto-auto">自动</button>',
      '    </div></div>',
      '  <div class="fxq-row">',
      '    <span class="fxq-hint">止盈 <b data-fxq="tp">90%</b></span>',
      '    <span class="fxq-hint">反转 <b data-fxq="rev">30</b></span>',
      '  </div>',
      '  <div class="fxq-row">',
      '    <span class="fxq-hint">时间止损 <b data-fxq="tstop">20</b></span>',
      '    <span class="fxq-hint">并发 <b data-fxq="maxpos">4</b></span>',
      '  </div>',
      '  <div class="fxq-row">',
      '    <span class="fxq-hint">杠杆 <b data-fxq="lev">30×</b></span>',
      '    <span class="fxq-hint">风险 <b data-fxq="risk">12%</b></span>',
      '    <button class="fxq-btn" data-fxq="look">前瞻</button>',
      '  </div>',
      '  <div class="fxq-row">',
      '    <button class="fxq-btn" data-fxq="exec">执行信号</button>',
      '    <button class="fxq-btn" data-fxq="closeall">全平</button>',
      '    <button class="fxq-btn" data-fxq="fast">快进</button>',
      '    <button class="fxq-btn" data-fxq="adopt">接管</button>',
      '  </div>',
      '  <div class="fxq-kv">',
      '    <div><span>权益</span><b data-fxq="equity">—</b></div>',
      '    <div><span>可用</span><b data-fxq="cash">—</b></div>',
      '    <div><span>浮盈</span><b data-fxq="float">—</b></div>',
      '  </div>',
      '  <div class="fxq-pos" data-fxq="posline">无持仓</div>',
      '  <div class="fxq-log" data-fxq="log"></div>',
      '</div>'
    ].join('');

    const setText = (node, text, cls) => {
      if (!node) return;
      if (node.textContent !== text) node.textContent = text;
      if (cls !== undefined && node.className !== cls) node.className = cls;
    };

    const setStyle = (node, prop, value) => {
      if (!node || node.style[prop] === value) return;
      node.style[prop] = value;
    };

    function bindRefs(root) {
      const q = key => root.querySelector('[data-fxq="' + key + '"]');
      Object.assign(ui, {
        ready: true, root,
        dot: q('dot'), via: q('via'), mode: q('mode'), sig: q('sig'), src: q('src'), k1: q('k1'),
        bar: q('bar'), ema: q('ema'), rsi: q('rsi'), atr: q('atr'), macd: q('macd'),
        boll: q('boll'), roc: q('roc'), advice: q('advice'), lev: q('lev'), risk: q('risk'),
        look: q('look'), equity: q('equity'), cash: q('cash'), float: q('float'),
        posline: q('posline'), log: q('log'),
        autoOff: q('auto-off'), autoConfirm: q('auto-confirm'), autoAuto: q('auto-auto'),
        tp: q('tp'), rev: q('rev'), tstop: q('tstop'), maxpos: q('maxpos'),
        exec: q('exec'), closeall: q('closeall'), fast: q('fast'), adopt: q('adopt'), fold: q('fold')
      });
    }

    function wireEvents() {
      const setAutomation = level => bus.emit(EV.CONFIG_SAVE, { patch: { automation: level } });
      ui.autoOff.addEventListener('click', () => setAutomation(MODE.OFF));
      ui.autoConfirm.addEventListener('click', () => setAutomation(MODE.CONFIRM));
      ui.autoAuto.addEventListener('click', () => setAutomation(MODE.AUTO));
      ui.look.addEventListener('click', () => bus.emit(EV.CONFIG_SAVE, { patch: { allowLookahead: !state.cfg.allowLookahead } }));
      ui.exec.addEventListener('click', () => bus.emit(EV.UI_COMMAND, { cmd: 'exec' }));
      ui.closeall.addEventListener('click', () => bus.emit(EV.UI_COMMAND, { cmd: 'closeall' }));
      ui.fast.addEventListener('click', () => bus.emit(EV.UI_COMMAND, { cmd: 'fast', value: 30 }));
      ui.adopt.addEventListener('click', () => bus.emit(EV.UI_COMMAND, { cmd: 'adopt' }));

      const LEVS = [5, 10, 20, 30, 50, 100];
      const RISKS = [0.05, 0.1, 0.12, 0.15, 0.2, 0.3];
      ui.lev.addEventListener('click', () => {
        bus.emit(EV.CONFIG_SAVE, { patch: { leverage: LEVS[(LEVS.indexOf(state.cfg.leverage) + 1) % LEVS.length] } });
      });
      const TPS = [0.5, 0.7, 0.9, 1.2, 1.5];
      const REVS = [20, 25, 30, 40, 50];
      const TSTOPS = [10, 15, 20, 30, 50];
      const MAXPOS = [2, 3, 4, 5];
      const cycle = (key, list, current) => bus.emit(EV.CONFIG_SAVE, { patch: { [key]: list[(list.indexOf(current) + 1) % list.length] } });
      ui.tp.addEventListener('click', () => cycle('takeProfitRatio', TPS, state.cfg.takeProfitRatio));
      ui.rev.addEventListener('click', () => cycle('reverseExitScore', REVS, state.cfg.reverseExitScore));
      ui.tstop.addEventListener('click', () => cycle('timeStopBars', TSTOPS, state.cfg.timeStopBars));
      ui.maxpos.addEventListener('click', () => cycle('maxPositions', MAXPOS, state.cfg.maxPositions));

      ui.risk.addEventListener('click', () => {
        if (state.cfg.sizeMode === SIZE_MODE.KELLY) bus.emit(EV.CONFIG_SAVE, { patch: { sizeMode: SIZE_MODE.FIXED, riskPct: RISKS[0] } });
        else {
          const next = RISKS.indexOf(state.cfg.riskPct) + 1;
          if (next >= RISKS.length) bus.emit(EV.CONFIG_SAVE, { patch: { sizeMode: SIZE_MODE.KELLY } });
          else bus.emit(EV.CONFIG_SAVE, { patch: { riskPct: RISKS[next] } });
        }
      });
    }

    // 凯利随 history 变化，必须在每轮渲染里刷新，否则面板会一直显示初始 12%
    function renderSizing() {
      if (!ui.ready) return;
      const kelly = kellyFraction(state.ctx ? state.ctx.history : [], state.cfg);
      ui.risk.textContent = state.cfg.sizeMode === SIZE_MODE.KELLY
        ? '凯利 ' + Math.round(kelly * 100) + '%'
        : Math.round(state.cfg.riskPct * 100) + '%';
    }

    function renderAutomation() {
      if (!ui.ready) return;
      ui.autoOff.classList.toggle('on', state.cfg.automation === MODE.OFF);
      ui.autoConfirm.classList.toggle('on', state.cfg.automation === MODE.CONFIRM);
      ui.autoAuto.classList.toggle('on', state.cfg.automation === MODE.AUTO);
      ui.look.classList.toggle('on', !!state.cfg.allowLookahead);
      ui.lev.textContent = state.cfg.leverage + '×';
      renderSizing();
      ui.tp.textContent = Math.round(state.cfg.takeProfitRatio * 100) + '%';
      ui.rev.textContent = state.cfg.reverseExitScore;
      ui.tstop.textContent = state.cfg.timeStopBars;
      ui.maxpos.textContent = state.cfg.maxPositions;
    }

    const MODE_LABEL = { sim: '模拟行情', real: '真实回放', battle: '经典战役', challenge: '每日挑战' };

    function renderIndicators(ind) {
      setText(ui.ema, priceText(ind.pair, Math.abs(ind.ema12 - ind.ema26)), ind.ema12 >= ind.ema26 ? 'fxq-up' : 'fxq-down');
      setText(ui.rsi, ind.rsi14 === null ? '—' : ind.rsi14.toFixed(1));
      setText(ui.atr, (ind.atrPct * 100).toFixed(3) + '%');
      const macdScaled = ind.macdHist * 10000;
      setText(ui.macd, (macdScaled >= 0 ? '+' : '') + macdScaled.toFixed(1), ind.macdHist >= 0 ? 'fxq-up' : 'fxq-down');
      setText(ui.boll, Math.round(ind.bollPos * 100) + '%');
      setText(ui.roc, (ind.roc10 * 100).toFixed(2) + '%', ind.roc10 >= 0 ? 'fxq-up' : 'fxq-down');
      setText(ui.src, ind.source);
    }

    function clearIndicators() {
      setText(ui.src, '');
      setText(ui.ema, '—', '');
      setText(ui.rsi, '—');
      setText(ui.atr, '—');
      setText(ui.macd, '—', '');
      setText(ui.boll, '—');
      setText(ui.roc, '—', '');
    }

    function renderRiskDot(snap) {
      if (!snap.positions.length) { setText(ui.dot, '', 'fxq-dot'); return; }
      const worst = snap.positions.reduce((m, p) => {
        if (!finite(p.margin) || p.margin <= 0) return m;
        return Math.max(m, -p.pnl / p.margin);
      }, 0);
      setText(ui.dot, '', 'fxq-dot' + (worst >= RISK_WARN ? ' bad' : worst >= STOP_RATIO ? ' warn' : ''));
    }

    function renderPanel(snap, ctx, plan) {
      if (!ui.ready || !snap) return;
      if (ui.collapsed) { renderRiskDot(snap); return; }
      setText(ui.via, snap.via === 'api' ? '通道 · 内部 API' : '通道 · DOM 兜底');
      setText(ui.mode, MODE_LABEL[snap.mode] || snap.mode);
      setText(ui.k1, isDriftMode(snap.mode) ? '漂移累积' : 'EMA12/26');
      if (isDriftMode(snap.mode)) renderDriftPanel(snap, ctx, plan);
      else renderIndicatorPanel(snap, ctx, plan);
      renderAccountPanel(snap);
      renderSizing();
    }

    function renderDriftPanel(snap, ctx, plan) {
      const top = ctx.drift[0];
      if (top) {
        const pct = (top.value * 100).toFixed(2);
        setText(ui.sig, top.pair + (top.side === 1 ? ' 多' : ' 空') + ' ' + (top.side === 1 ? '+' : '') + pct + '%',
          'fxq-sig ' + (top.side === 1 ? 'fxq-up' : 'fxq-down'));
        const half = clamp(Math.abs(top.value) / 0.006 * 50, 0, 50);
        setStyle(ui.bar, 'left', top.side === 1 ? '50%' : (50 - half) + '%');
        setStyle(ui.bar, 'width', half + '%');
        setStyle(ui.bar, 'background', top.side === 1 ? '#57cf9b' : '#ef8ba0');
        setText(ui.ema, (top.value * 100).toFixed(2) + '%', top.side === 1 ? 'fxq-up' : 'fxq-down');
        setText(ui.src, '漂移相位 · H=' + top.horizon + 't');
        setText(ui.rsi, '—');
        setText(ui.atr, '—');
        setText(ui.macd, ctx.drift.length + ' 个', '');
        setText(ui.boll, '—');
        setText(ui.roc, '—', '');
      } else {
        setText(ui.sig, '无漂移窗口', 'fxq-sig');
        setStyle(ui.bar, 'width', '0');
        clearIndicators();
      }
      setText(ui.advice, plan
        ? plan.pair + (plan.side === 1 ? ' 做多' : ' 做空') + ' · ' + money(plan.margin) + ' · ' + plan.leverage + '×' + plan.note
        : (snap.positions.length ? '持仓管理中 · ' + snap.positions.length + ' 笔' : '漂移累积不足 ' + (DRIFT_MIN_SUM * 100).toFixed(2) + '%'),
        'fxq-advice' + (plan && plan.side < 0 ? ' sell' : ''));
    }

    function renderIndicatorPanel(snap, ctx, plan) {
      const ind = ctx.best;
      if (!ind) {
        setText(ui.sig, '数据积累中', 'fxq-sig');
        setStyle(ui.bar, 'left', '50%');
        setStyle(ui.bar, 'width', '0');
        clearIndicators();
        setText(ui.advice, '等待 K 线数据…', 'fxq-advice');
        return;
      }
      const score = ind.score;
      const label = score >= SIGNAL_STRONG ? '强多' : score >= SIGNAL_THRESHOLD ? '偏多'
        : score <= -SIGNAL_STRONG ? '强空' : score <= -SIGNAL_THRESHOLD ? '偏空' : '中性';
      setText(ui.sig, label + ' ' + (score >= 0 ? '+' : '') + score.toFixed(0),
        'fxq-sig ' + (score > 0 ? 'fxq-up' : score < 0 ? 'fxq-down' : ''));
      const half = Math.abs(score) / 100 * 50;
      setStyle(ui.bar, 'left', score >= 0 ? '50%' : (50 - half) + '%');
      setStyle(ui.bar, 'width', half + '%');
      setStyle(ui.bar, 'background', score >= 0 ? '#57cf9b' : '#ef8ba0');
      renderIndicators(ind);
      setText(ui.advice, plan
        ? plan.pair + (plan.side === 1 ? ' 做多' : ' 做空') + ' · 保证金 ' + money(plan.margin) + ' · ' + plan.leverage + '×' + plan.note
        : (snap.positions.length ? '持仓管理中 · ' + snap.positions.length + ' 笔' : '无信号（|评分| < ' + SIGNAL_THRESHOLD + '）'),
        'fxq-advice' + (plan && plan.side < 0 ? ' sell' : ''));
    }

    function renderAccountPanel(snap) {
      setText(ui.equity, finite(snap.equity) ? money(snap.equity) : '—');
      setText(ui.cash, finite(snap.cash) ? money(snap.cash) : '—');
      const floating = snap.positions.reduce((s, p) => s + (finite(p.pnl) ? p.pnl : 0), 0);
      setText(ui.float, signedMoney(floating), floating >= 0 ? 'fxq-up' : 'fxq-down');
      renderRiskDot(snap);
      if (!snap.positions.length) {
        setText(ui.posline, '无持仓');
        return;
      }
      setText(ui.posline, snap.positions.map(p => {
        const ratio = finite(p.margin) && p.margin > 0
          ? ' (' + (p.pnl >= 0 ? '+' : '') + Math.round(p.pnl / p.margin * 100) + '%)'
          : '';
        return p.pair + (p.side === 1 ? '多' : '空') + ' ' + signedMoney(p.pnl || 0) + ratio;
      }).join('   '));
    }

    function build() {
      if (ui.ready) return;
      const host = PAGE.document.body;
      if (!host) return;
      const style = PAGE.document.createElement('style');
      style.textContent = CSS;
      PAGE.document.head.appendChild(style);
      const root = PAGE.document.createElement('div');
      root.className = 'fxq-panel';
      root.innerHTML = PANEL_HTML;
      host.appendChild(root);
      bindRefs(root);
      wireEvents();
      renderAutomation();
      // 挂载完成：把 DOM 句柄交给 input 模块接管拖拽 / 断点 / 位置
      bus.emit(EV.UI_MOUNTED, { root, head: root.querySelector('.fxq-head') });
    }

    function init() {
      bus.on(EV.CONFIG_CHANGED, ({ cfg }) => { state.cfg = cfg; renderAutomation(); });
      bus.on(EV.UI_STATE, ({ collapsed, mobile }) => { ui.collapsed = collapsed; ui.mobile = mobile; });
      bus.on(EV.SERIES_READY, ({ snap, ctx }) => {
        state.snap = snap;
        state.ctx = ctx;
        renderPanel(snap, ctx, state.plan);
      });
      bus.on(EV.ENGINE_PLAN, ({ plan }) => { state.plan = plan; });
      bus.on(EV.BRIDGE_BLOCKED, ({ reason }) => log('主世界注入被阻断，改用直挂通道：' + reason));
      bus.on(EV.LOG, ({ msg }) => {
        logLines.unshift(TIME_FMT.format(new Date()) + '  ' + msg);
        if (logLines.length > MAX_LOG) logLines.length = MAX_LOG;
        if (ui.ready) ui.log.textContent = logLines.slice(0, 6).join('\n');
      });

      let waits = 0;
      let bootTimer = null;
      const boot = () => {
        if (!PAGE.document.body) { bootTimer = setTimeout(boot, 60); return; }
        if (!$('longBtn')) { if (++waits < 100) { bootTimer = setTimeout(boot, 150); return; } }
        build();
        log('量化辅助台已就绪 v2.5.0（八模块 · MAIN_WORLD）');
      };
      const stopBoot = () => { if (bootTimer) clearTimeout(bootTimer); bootTimer = null; };
      if (PAGE.document.readyState === 'loading') PAGE.document.addEventListener('DOMContentLoaded', boot, { once: true });
      else boot();

      return { dispose() { stopBoot(); }, debug: { ui, logLines, state, renderPanel } };
    }

    return { init };
  }

  /* ================================================================ 引导 */

  const bus = createBus();
  const store = createStore(bus).init();
  const bridge = createBridge(bus).init();
  const data = createData(bus).init();
  const series = createSeries(bus).init();
  const engine = createEngine(bus).init();
  const exec = createExec(bus).init();
  const input = createInput(bus).init();
  const ui = createUi(bus).init();
  // 全部订阅完成后再广播初始配置：提前发会被 DEFAULTS 覆盖已保存设置
  bus.emit(EV.CONFIG_CHANGED, { cfg: store.debug.cfg });

  // 调试/测试兼容层：保持 v1 的 __FXQ__ 形状
  PAGE.__FXQ__ = {
    BRIDGE: {
      get tools() { return bridge.debug.tools; },
      set tools(v) { bridge.debug.setTools(v); },
      get via() { return bridge.debug.via; },
      call: bridge.debug.call,
      has: bridge.debug.has,
      readSave: bridge.debug.readSave
    },
    cfg: store.debug.cfg,
    engine: {
      get barCount() { return engine.debug.state.barCount; },
      get tickAt() { return engine.debug.state.tickAt; },
      get stopRatio() { return engine.debug.state.stopRatio; },
      get entryBars() { return engine.debug.state.entryBars; },
      get exitBars() { return engine.debug.state.exitBars; },
      get pairCooldown() { return engine.debug.state.pairCooldown; },
      get pending() { return engine.debug.pending; },
      get suppressUntil() { return engine.debug.state.suppressUntil; },
      set suppressUntil(v) { engine.debug.state.suppressUntil = v; },
      get lastActionAt() { return engine.debug.state.lastActionAt; },
      get news() { return engine.debug.state.news; },
      get priceMemory() { return { value: data.debug.state.lastPrice, since: data.debug.state.tickAt }; }
    },
    snapshot: data.debug.snapshot,
    computeIndicators,
    getSeries: series.debug.getSeries,
    driftSum,
    bestDrift,
    driftSignals: (snap, t0) => driftSignalsFor(snap.mode, t0 || engine.debug.state.tickAt),
    hasTool: bridge.debug.has,
    logLines: ui.debug.logLines,
    closeAllPositions: exec.debug.closeAllPositions,
    sweepModals: exec.debug.sweepModals,
    step: data.debug.collect,
    debugLog: store.debug.debugLog,
    bus,
    busStats: bus.stats,
    modules: { bridge, store, data, series, engine, exec, input, ui },
    // 卸载：停掉定时器与在途请求，再放开引导标记，脚本可被重新注入
    dispose() {
      for (const m of [bridge, store, data, series, engine, exec, input, ui]) {
        try { m.dispose?.(); } catch (err) { console.warn('[fxq] dispose 失败', err); }
      }
      delete PAGE.__FXQ_BOOTED__;
      delete PAGE.__FXQ__;
    }
  };
})();
