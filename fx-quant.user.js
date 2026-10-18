// ==UserScript==
// @name         FX 简单! · 量化辅助台
// @namespace    https://www.bilibilitoy.com/toy/fx-simple
// @version      1.2.0
// @description  B站「FX 简单!」量化辅助：漂移相位引擎（白盒）+ 技术指标引擎（黑盒）+ 新闻偏置加权 + 三级自动化
// @author       fxq
// @match        https://www.bilibilitoy.com/toy/fx-simple/*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

/* ============================================================================
 * FX 简单! 量化辅助台
 *
 * 通道优先级（游戏 API > 框架 API > mod 实现）：
 *   1. 游戏 API —— 4 个 WebMCP 工具，execute 闭包直接持有内部 state
 *   2. 框架 API —— 游戏自己写入的 localStorage['fx-heartbeat-save-v3'].sim K 线
 *   3. mod 实现 —— DOM 读文本 / 点按钮；自拉 frankfurter；自采样价格
 *
 * 双引擎（按模式分流）：
 *   漂移引擎（sim / challenge）—— tickSim 的漂移项可解析：
 *       drift = sin(Date.now()/13000 + index*2 + marketIndex*0.7) * 0.00036
 *     它是周期 ≈81.7s 的正弦波，单 tick 被噪声(σ=0.121%)盖住，但累积 10~27 tick
 *     后达 0.3~0.6%，而噪声只按 √n 长到 0.42% —— 实测方向命中率 74~80%。
 *     持有期动态取 argmax |driftSum|/√H（H∈[8,30]），到时无条件平仓。
 *   指标引擎（real / battle）—— 那两个模式没有 tickSim，用 EMA/MACD/RSI/布林 评分，
 *     并可选前瞻（真实历史序列已知，属作弊，默认关）。
 *
 * 游戏规则（由 app.js 反推，非猜测）：
 *   手续费   fee = margin * L * (0.00005 + L * 0.000005)，仅开仓收取
 *   爆仓线   riskRatio = -pnl/margin；>=0.6 弹窗并置 riskPaused=true（行情冻结），>=0.8 强平
 *   开仓约束 margin >= 10 且 margin + fee <= cash；挑战模式最多 5 仓且需 challenge.active
 *   弹窗语义 openModal() 里 modalCancel 的显隐 = 是否带 modalAction（会改账户状态）
 * ==========================================================================*/

(() => {
  'use strict';

  const PAGE = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
  if (PAGE.__FXQ_BOOTED__) return;
  PAGE.__FXQ_BOOTED__ = true;

  /* ------------------------------------------------------------------ 常量 */

  const PAIRS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'EUR/CHF', 'AUD/USD', 'USD/CAD'];
  const DIGITS = { 'EUR/USD': 5, 'GBP/USD': 5, 'USD/JPY': 3, 'USD/CHF': 5, 'EUR/CHF': 5, 'AUD/USD': 5, 'USD/CAD': 5 };
  const BATTLES = {
    'franc-2015': { start: '2014-12-01', end: '2015-02-20' },
    'brexit-2016': { start: '2016-05-16', end: '2016-07-22' },
    'parity-2022': { start: '2022-06-01', end: '2022-08-12' },
    'yen-2022': { start: '2022-08-15', end: '2022-10-28' }
  };
  const FX_SYMBOLS = 'USD,GBP,JPY,CHF,AUD,CAD';
  const SAVE_KEY = 'fx-heartbeat-save-v3';
  const CFG_KEY = 'fxq-config-v1';

  // tickSim 的确定性结构（源码常量）
  const TICK_MS = 1500;
  const DRIFT_DIV = 13000;
  const DRIFT_AMP = 0.00036;
  const MARKET_PHASE = { sim: 0, challenge: 0.7 };

  const LOOP_MS = 400;
  const SWEEP_MS = 1500;
  const SAMPLE_INTERVAL_MS = 1200;
  const SAMPLE_MAX = 400;
  const SAMPLE_MIN = 12;
  const SERIES_TTL_MS = 60000;
  const FREEZE_DETECT_MS = 5000;
  const DAY_ADVANCE_MS = 800;
  const ACTION_COOLDOWN_MS = 2500;
  const ENTRY_COOLDOWN_MS = 15000;
  const SUPPRESS_MS = 8000;
  const NEWS_WINDOW_MS = 8000;
  const MAX_LOG = 40;

  const MIN_MARGIN = 10;
  const STOP_RATIO = 0.40;
  const STOP_MIN = 0.25;      // 弱漂移仓的止损
  const STOP_MAX = 0.50;      // 强漂移仓的止损（游戏 0.6 会弹窗冻结行情，必须留边际）
  const MAX_CCY_NOTIONAL_MULT = 5;  // 单一货币名义敞口上限 = 权益 × 该倍数
  const MIN_POSITION_RATIO = 0.02;  // 缩仓后低于权益 2% 就不值得开（占位 + 手续费）
  const KELLY_FRACTION = 0.5;       // 半凯利
  const KELLY_MIN_SAMPLE = 10;
  const RISK_WARN = 0.60;
  const SIGNAL_THRESHOLD = 30;
  const DRIFT_MIN_BARS = 8;
  const DRIFT_MAX_BARS = 30;
  const DRIFT_MIN_SUM = 0.0015;
  const LOOKAHEAD_HORIZON = 3;
  const LOOKAHEAD_SCALE = 0.004;
  const MIN_BARS_FOR_SIGNAL = 30;

  // 新闻模板的方向性偏置（源码 SIM_NEWS 表；生效 5~8 tick，76% 概率与 bias 同向）
  const NEWS_BIAS = [
    { tag: '通胀数据', title: '核心通胀高于预期', bias: { 'EUR/USD': -0.00045, 'GBP/USD': -0.00035, 'USD/JPY': 0.00038, 'USD/CHF': 0.0003, 'AUD/USD': -0.00042, 'USD/CAD': 0.00025 } },
    { tag: '就业数据', title: '新增就业明显降温', bias: { 'EUR/USD': 0.00035, 'GBP/USD': 0.0003, 'USD/JPY': -0.00035, 'USD/CHF': -0.00025, 'AUD/USD': 0.00028, 'USD/CAD': -0.0002 } },
    { tag: '风险事件', title: '避险情绪突然升温', bias: { 'EUR/USD': -0.00025, 'GBP/USD': -0.00032, 'USD/JPY': -0.00022, 'USD/CHF': -0.00018, 'AUD/USD': -0.0005, 'USD/CAD': 0.0003 } },
    { tag: '央行讲话', title: '官员强调政策取决于数据', bias: {} },
    { tag: '能源市场', title: '能源价格快速反弹', bias: { 'EUR/USD': -0.00028, 'GBP/USD': -0.00016, 'AUD/USD': 0.0002, 'USD/CAD': -0.00034 } },
    { tag: '市场传闻', title: '大型资金调整月底仓位', bias: {} }
  ];

  const DEFAULTS = Object.freeze({
    automation: 'off',
    leverage: 30,
    riskPct: 0.12,
    takeProfitRatio: 0.9,
    reverseExitScore: 30,
    timeStopBars: 20,
    allowLookahead: false,
    maxPositions: 4,
    sizeMode: 'kelly'
  });

  /* -------------------------------------------------------------- 小工具 */

  const $ = id => PAGE.document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const feeRate = lev => lev * (0.00005 + lev * 0.000005);
  const money = n => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const signedMoney = n => (n >= 0 ? '+$' : '-$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const priceText = (pair, v) => finite(v) ? v.toFixed(DIGITS[pair] || 5) : '—';

  function setText(node, text, cls) {
    if (!node) return;
    if (node.textContent !== text) node.textContent = text;
    if (cls !== undefined && node.className !== cls) node.className = cls;
  }

  function setStyle(node, prop, value) {
    if (!node) return;
    if (node.style[prop] !== value) node.style[prop] = value;
  }

  function loadConfig() {
    try {
      const raw = PAGE.localStorage.getItem(CFG_KEY);
      return raw ? Object.assign({}, DEFAULTS, JSON.parse(raw)) : Object.assign({}, DEFAULTS);
    } catch (_) { return Object.assign({}, DEFAULTS); }
  }
  const cfg = loadConfig();
  const saveConfig = () => {
    try { PAGE.localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (_) {}
  };

  const logLines = [];
  let lastLogAt = 0, lastLogMsg = '';
  function log(msg) {
    const now = Date.now();
    if (msg === lastLogMsg && now - lastLogAt < 4000) return;
    lastLogAt = now; lastLogMsg = msg;
    logLines.unshift(new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '  ' + msg);
    if (logLines.length > MAX_LOG) logLines.length = MAX_LOG;
    if (ui.ready) ui.log.textContent = logLines.slice(0, 6).join(String.fromCharCode(10));
  }

  /* ---------------------------------------------- 桥：页面内部 API 通道 */

  const BRIDGE = { tools: Object.create(null), lastSave: '', via: 'none', hooked: false };

  function pageWorldPolyfill(W) {
    var SAVE = 'fx-heartbeat-save-v3';
    var P = W.__FXQ_PAGE__ = W.__FXQ_PAGE__ || { tools: {}, lastSave: '' };
    var d = W.document;
    var prevReg = null;
    try {
      var prev = d.modelContext;
      if (prev && typeof prev.registerTool === 'function') prevReg = prev.registerTool.bind(prev);
    } catch (e) {}
    var fake = {
      registerTool: function (tool) {
        try { if (tool && tool.name) P.tools[tool.name] = tool; } catch (e) {}
        return prevReg ? prevReg(tool) : Promise.resolve(true);
      }
    };
    try { Object.defineProperty(d, 'modelContext', { configurable: true, get: function () { return fake; } }); } catch (e) {}
    try {
      var proto = W.Storage && W.Storage.prototype;
      if (proto && typeof proto.setItem === 'function' && !proto.__fxqHooked) {
        var orig = proto.setItem;
        proto.setItem = function (k, v) { if (k === SAVE) P.lastSave = String(v); return orig.apply(this, arguments); };
        proto.__fxqHooked = true;
      }
    } catch (e) {}
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
      } catch (_) {}
    };
    inject();
  }

  function installDirectBridge() {
    const doc = PAGE.document;
    const capture = mc => {
      BRIDGE.hooked = true;
      try {
        const orig = mc.registerTool;
        mc.registerTool = function (tool) {
          try { if (tool && tool.name) BRIDGE.tools[tool.name] = tool; } catch (_) {}
          return typeof orig === 'function' ? orig.apply(mc, arguments) : Promise.resolve(true);
        };
      } catch (_) {}
    };

    try {
      const native = doc.modelContext;
      if (native && typeof native.registerTool === 'function') capture(native);
    } catch (_) {}

    if (!BRIDGE.hooked) {
      const fake = {
        registerTool(tool) {
          try { if (tool && tool.name) BRIDGE.tools[tool.name] = tool; } catch (_) {}
          BRIDGE.hooked = true;
          return Promise.resolve(true);
        }
      };
      let ok = false;
      try {
        Object.defineProperty(doc, 'modelContext', { configurable: true, get: () => fake });
        ok = doc.modelContext === fake;
      } catch (_) {}
      if (!ok) { try { doc.modelContext = fake; ok = doc.modelContext === fake; } catch (_) {} }
    }

    try {
      const proto = PAGE.Storage && PAGE.Storage.prototype;
      if (proto && typeof proto.setItem === 'function') {
        const origSet = proto.setItem;
        proto.setItem = function (key, value) {
          if (key === SAVE_KEY) BRIDGE.lastSave = String(value);
          return origSet.apply(this, arguments);
        };
      }
    } catch (_) {}

    try { BRIDGE.lastSave = PAGE.localStorage.getItem(SAVE_KEY) || ''; } catch (_) {}
  }

  const TOOL_OK = 0, TOOL_MISSING = 1, TOOL_FAILED = 2;

  function pageTools() {
    try { return (PAGE.__FXQ_PAGE__ && PAGE.__FXQ_PAGE__.tools) || null; } catch (_) { return null; }
  }

  function toolFor(name) {
    const local = BRIDGE.tools[name];
    if (local && typeof local.execute === 'function') return local;
    const remote = pageTools();
    const other = remote && remote[name];
    return other && typeof other.execute === 'function' ? other : null;
  }

  function callTool(name, args) {
    const tool = toolFor(name);
    if (!tool) return { status: TOOL_MISSING };
    try {
      return { status: TOOL_OK, value: tool.execute(args || {}) };
    } catch (err) {
      return { status: TOOL_FAILED, error: err };
    }
  }

  const hasTool = name => !!toolFor(name);

  /* --------------------------------------------------------- 快照：账户态 */

  const sampled = new Map();
  let lastSampleAt = 0;

  function readSave() {
    try {
      let raw = BRIDGE.lastSave;
      if (!raw) { try { raw = (PAGE.__FXQ_PAGE__ && PAGE.__FXQ_PAGE__.lastSave) || ''; } catch (_) {} }
      if (!raw) raw = PAGE.localStorage.getItem(SAVE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  function readDomMoney(id) {
    const node = $(id);
    if (!node) return NaN;
    const n = Number(String(node.textContent).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : NaN;
  }

  function currentPairFromDom() {
    const node = $('pairTitle');
    const title = node ? String(node.textContent).replace(/\s+/g, '') : '';
    return PAIRS.includes(title) ? title : 'EUR/USD';
  }

  function domSnapshot() {
    const activeMode = ['simMode', 'realMode', 'battleMode', 'challengeMode']
      .map(id => $(id)).find(btn => btn && btn.classList.contains('active'));
    const mode = activeMode ? activeMode.id.replace('Mode', '') : 'sim';
    const pair = currentPairFromDom();
    const price = Number(String(($('currentPrice') || {}).textContent || '').replace(/[^0-9.]/g, ''));

    const positions = [];
    PAGE.document.querySelectorAll('#positions .position-row').forEach((row, index) => {
      const head = row.querySelector('.pos-name strong');
      const headText = head ? String(head.textContent) : '';
      const pairHit = PAIRS.find(p => headText.indexOf(p) === 0);
      const cells = row.querySelectorAll('.pos-cell strong');
      const pnlText = cells[2] ? String(cells[2].textContent).trim() : '';
      positions.push({
        id: 'dom-' + index,
        pair: pairHit || pair,
        side: headText.indexOf('做多') >= 0 ? 1 : -1,
        margin: NaN,
        leverage: cfg.leverage,
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
    const res = callTool('read_fx_game_state');
    if (res.status === TOOL_OK && res.value && res.value.prices) {
      const api = res.value;
      BRIDGE.via = 'api';
      return {
        mode: api.mode,
        battleId: api.battleId,
        challenge: api.challenge,
        date: api.date,
        cash: api.cash,
        debt: api.debt,
        equity: api.equity,
        prices: api.prices,
        positions: (api.positions || []).map(p => ({
          id: p.id, pair: p.pair, side: p.side === 'long' ? 1 : -1,
          margin: p.margin, leverage: p.leverage, entry: p.entry, pnl: p.pnl
        })),
        via: 'api'
      };
    }
    BRIDGE.via = 'dom';
    return domSnapshot();
  }

  /* ------------------------------------------------- 序列：K 线与价格路径 */

  function parseFrankfurter(data) {
    return Object.entries(data.rates || {}).sort(([a], [b]) => a.localeCompare(b)).map(([date, r]) => {
      if (!['USD', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD'].every(k => Number.isFinite(r[k]) && r[k] > 0)) return null;
      return {
        date,
        prices: {
          'EUR/USD': r.USD,
          'GBP/USD': r.USD / r.GBP,
          'USD/JPY': r.JPY / r.USD,
          'USD/CHF': r.CHF / r.USD,
          'EUR/CHF': r.CHF,
          'AUD/USD': r.USD / r.AUD,
          'USD/CAD': r.CAD / r.USD
        }
      };
    }).filter(Boolean);
  }

  const historyCache = new Map();

  async function fetchHistory(start, end) {
    const key = start + '~' + end;
    if (historyCache.has(key)) return historyCache.get(key);
    const url = 'https://api.frankfurter.dev/v1/' + start + '..' + end + '?base=EUR&symbols=' + FX_SYMBOLS;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const items = parseFrankfurter(await res.json());
    if (items.length < 5) throw new Error('历史数据不足');
    historyCache.set(key, items);
    return items;
  }

  function domRange() {
    const s = $('rangeStart') ? $('rangeStart').value : '';
    const e = $('rangeEnd') ? $('rangeEnd').value : '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s) && /^\d{4}-\d{2}-\d{2}$/.test(e)) return { start: s, end: e };
    const end = new Date();
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - 364);
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }

  function candlesFromPrices(prices) {
    return prices.map((c, i) => {
      const prev = i ? prices[i - 1] : c;
      return { o: prev, h: Math.max(prev, c), l: Math.min(prev, c), c };
    });
  }

  function simSeries(pair) {
    const save = readSave();
    const node = save && save.sim && save.sim[pair];
    if (!node || !Array.isArray(node.candles) || node.candles.length < 10) return null;
    const candles = node.candles.map(k => ({ o: k.open, h: k.high, l: k.low, c: k.close }));
    return { candles, prices: candles.map(k => k.c), source: '游戏存档K线 ' + candles.length + ' 根', future: null, cursor: -1 };
  }

  function sampledSeries(pair) {
    const buf = sampled.get(pair);
    if (!buf || buf.length < SAMPLE_MIN) return null;
    const prices = buf.map(p => p.c);
    return { candles: candlesFromPrices(prices), prices, source: '实时采样 ' + prices.length + ' 点', future: null, cursor: -1 };
  }

  function recordSample(snap) {
    const now = Date.now();
    if (now - lastSampleAt < SAMPLE_INTERVAL_MS) return;
    lastSampleAt = now;
    for (const pair of PAIRS) {
      const price = snap.prices[pair];
      if (!finite(price) || price <= 0) continue;
      let buf = sampled.get(pair);
      if (!buf) { buf = []; sampled.set(pair, buf); }
      const last = buf.at(-1);
      if (last && Math.abs(last.c - price) < 1e-12) continue;
      buf.push({ t: now, c: price });
      if (buf.length > SAMPLE_MAX) buf.shift();
    }
  }

  async function fetchPlaybackSeries(snap, pair) {
    let range = null;
    if (snap.mode === 'battle') range = BATTLES[snap.battleId] || null;
    else if (snap.mode === 'real') range = domRange();
    if (!range) return null;

    let items;
    try { items = await fetchHistory(range.start, range.end); }
    catch (err) { log('历史序列拉取失败：' + (err && err.message ? err.message : err)); return null; }

    // parseFrankfurter 已保证每行 6 币种齐全；这里不做 filter，否则会与 dates 下标错位
    const prices = items.map(row => row.prices[pair]);
    if (prices.length < 10) return null;
    const cursor = snap.date ? items.findIndex(row => row.date === snap.date) : -1;
    return {
      candles: candlesFromPrices(prices),
      prices,
      dates: items.map(row => row.date),
      cursor,
      source: 'frankfurter ' + range.start + '→' + range.end,
      future: cursor >= 0 ? prices.slice(cursor + 1) : null
    };
  }

  const seriesCache = new Map();

  function getSeries(snap, pair) {
    if (snap.mode === 'sim') return simSeries(pair);
    // 挑战模式行情由 challengeSim 驱动且不存档，只能用游戏 API 的价格采样；
    // 采样不足宁可不发信号，也不拿模拟市场 K 线顶替（无关序列）
    if (snap.mode === 'challenge') return sampledSeries(pair);

    const key = snap.mode + '|' + (snap.battleId || '') + '|' + pair;
    const entry = seriesCache.get(key);
    if (entry && Date.now() - entry.at < SERIES_TTL_MS) return entry.data;
    if (!entry || !entry.busy) {
      const record = { busy: true, data: entry ? entry.data : null, at: entry ? entry.at : 0 };
      seriesCache.set(key, record);
      fetchPlaybackSeries(snap, pair)
        .then(data => { record.data = data; record.at = Date.now(); })
        .catch(() => { record.data = null; })
        .finally(() => { record.busy = false; });
    }
    return entry ? entry.data : null;
  }

  /* ------------------------------------------- 漂移引擎：解析 tickSim 的确定性项 */

  // Σ_{k=0..H-1} sin((t0 + k*TICK)/DIV + idx*2 + phase) * AMP
  function driftSum(t0, index, horizon, marketPhase) {
    let sum = 0;
    for (let k = 0; k < horizon; k++) {
      sum += Math.sin((t0 + k * TICK_MS) / DRIFT_DIV + index * 2 + marketPhase) * DRIFT_AMP;
    }
    return sum;
  }

  // 最优持有期：最大化 漂移累积 / 噪声(∝√H)，即信噪比
  function bestDrift(t0, index, marketPhase) {
    let best = { horizon: 0, sum: 0, ratio: 0 };
    for (let h = DRIFT_MIN_BARS; h <= DRIFT_MAX_BARS; h++) {
      const sum = driftSum(t0, index, h, marketPhase);
      const ratio = Math.abs(sum) / Math.sqrt(h);
      if (ratio > best.ratio) best = { horizon: h, sum, ratio };
    }
    return best;
  }

  function driftSignals(snap, t0) {
    const marketPhase = MARKET_PHASE[snap.mode] ?? 0;
    const out = [];
    PAIRS.forEach((pair, index) => {
      const best = bestDrift(t0, index, marketPhase);
      if (Math.abs(best.sum) < DRIFT_MIN_SUM) return;
      out.push({ pair, index, value: best.sum, horizon: best.horizon, side: best.sum > 0 ? 1 : -1, ratio: best.ratio });
    });
    return out.sort((a, b) => b.ratio - a.ratio);
  }

  function readNewsBias() {
    const node = $('tickerTrack');
    if (!node) return null;
    const text = String(node.textContent);
    const hit = NEWS_BIAS.find(item => text.indexOf('【' + item.tag + '】' + item.title) >= 0);
    return hit || null;
  }

  function activeNewsBias() {
    const news = engine.news;
    if (!news) return null;
    if (Date.now() - news.at > NEWS_WINDOW_MS) return null;
    return news;
  }

  /* ------------------------------------------------------------ 指标计算 */

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

  function computeIndicators(series, pair) {
    if (!series || !series.prices || series.prices.length < MIN_BARS_FOR_SIGNAL) return null;
    const prices = series.prices;
    const last = prices.at(-1);
    const ema12 = emaSeries(prices, 12);
    const ema26 = emaSeries(prices, 26);
    const e12 = ema12.at(-1);
    const e26 = ema26.at(-1);
    const macdLine = ema12.map((v, i) => v - ema26[i]);
    const macdSignal = emaSeries(macdLine.slice(-40), 9);
    const macdHist = macdLine.at(-1) - macdSignal.at(-1);
    const rsi14 = rsiLast(prices, 14);
    const atr14 = atrOf(series.candles, 14);
    const boll = bollinger(prices, 20, 2);
    const roc10 = prices.length > 10 ? (last / prices[prices.length - 11] - 1) : 0;
    const atrPct = atr14 && last ? atr14 / last : 0;
    const bollPos = boll && boll.upper > boll.lower ? (last - boll.lower) / (boll.upper - boll.lower) : 0.5;

    const trend = atr14 ? clamp((e12 - e26) / (atr14 * 0.6), -1, 1) : 0;
    const macdNorm = atr14 ? clamp(macdHist / (atr14 * 0.5), -1, 1) : 0;
    const rsiScore = rsi14 === null ? 0
      : rsi14 < 30 ? clamp((30 - rsi14) / 30, 0, 1)
        : rsi14 > 70 ? -clamp((rsi14 - 70) / 30, 0, 1)
          : (50 - rsi14) / 50 * 0.35;
    const bollScore = clamp((bollPos - 0.5) * 2, -1, 1);
    const rocNorm = atrPct > 0 ? clamp(roc10 / (atrPct * 3), -1, 1) : 0;

    const score = clamp(trend * 30 + macdNorm * 20 + rsiScore * 20 + bollScore * 15 + rocNorm * 15, -100, 100);
    return {
      pair, price: last, score,
      ema12: e12, ema26: e26, macdHist, rsi14, atr14, atrPct, boll, bollPos, roc10,
      source: series.source
    };
  }

  const indCache = new Map();

  function fingerprint(series) {
    const n = series.prices.length;
    return n + '|' + series.prices[n - 1] + '|' + (series.cursor ?? -1);
  }

  function cachedIndicators(series, pair, mode) {
    if (!series) return null;
    const key = mode + '|' + pair;
    const fp = fingerprint(series);
    const hit = indCache.get(key);
    if (hit && hit.fp === fp) return hit.ind;
    const ind = computeIndicators(series, pair);
    indCache.set(key, { fp, ind });
    return ind;
  }

  function lookaheadBias(series) {
    if (!series || !series.future || !series.future.length || series.cursor < 0) return null;
    const span = Math.min(LOOKAHEAD_HORIZON, series.future.length);
    const now = series.prices[series.cursor];
    const then = series.future[span - 1];
    if (!finite(now) || !finite(then) || now === 0) return null;
    return then / now - 1;
  }

  /* ---------------------------------------------------------------- 执行层 */

  function setField(id, value) {
    const node = $(id);
    if (!node) return false;
    node.value = String(value);
    node.dispatchEvent(new PAGE.Event('input', { bubbles: true }));
    node.dispatchEvent(new PAGE.Event('change', { bubbles: true }));
    return true;
  }

  function openTrade(pair, side, margin, leverage) {
    const res = callTool('place_fx_trade', { pair, side: side === 1 ? 'long' : 'short', margin, leverage });
    if (res.status === TOOL_OK) {
      log('开仓 ' + pair + (side === 1 ? ' 做多' : ' 做空') + ' 保证金 ' + money(margin) + ' @' + leverage + 'x');
      return true;
    }
    if (res.status === TOOL_FAILED) {
      log('开仓被拒：' + (res.error && res.error.message ? res.error.message : String(res.error)));
      return false;
    }
    setField('leverageRange', leverage);
    setField('marginInput', margin);
    for (const row of PAGE.document.querySelectorAll('#pairList .pair-row')) {
      if (String(row.textContent).indexOf(pair) === 0) { row.click(); break; }
    }
    const btn = $(side === 1 ? 'longBtn' : 'shortBtn');
    if (!btn) { log('找不到下单按钮'); return false; }
    btn.click();
    log('开仓(DOM) ' + pair + (side === 1 ? ' 做多' : ' 做空') + ' 保证金 ' + money(margin));
    return true;
  }

  function domCloseRow(position) {
    const rows = Array.from(PAGE.document.querySelectorAll('#positions .position-row'));
    if (!rows.length) return null;
    const pair = position.pair || '';
    const sideText = position.side === 1 ? '做多' : '做空';
    return rows.find(row => {
      const text = String(row.textContent);
      return text.indexOf(pair) >= 0 && text.indexOf(sideText) >= 0;
    }) || null;
  }

  function closeTrade(position, reason) {
    if (!position) return false;
    const res = callTool('close_fx_trade', { id: position.id });
    if (res.status === TOOL_OK) {
      log('平仓 ' + position.pair + (reason ? '(' + reason + ')' : '') + ' 盈亏 ' + signedMoney(position.pnl || 0));
      engine.pairCooldown.set(position.pair, { at: Date.now(), side: position.side });
      return true;
    }
    if (res.status === TOOL_FAILED) {
      log('平仓被拒：' + (res.error && res.error.message ? res.error.message : String(res.error)));
      return false;
    }
    const row = domCloseRow(position);
    const btn = row && row.querySelector('button');
    if (!btn) return false;
    btn.click();
    log('平仓(DOM) ' + position.pair + (reason ? '(' + reason + ')' : ''));
    engine.pairCooldown.set(position.pair, { at: Date.now(), side: position.side });
    return true;
  }

  // 逐笔平仓并重新取快照：平掉一笔后其余持仓下标会位移
  function closeAllPositions() {
    engine.suppressUntil = Date.now() + SUPPRESS_MS;
    let closed = 0;
    for (let guard = 0; guard < 20; guard++) {
      const snap = snapshot();
      if (!snap.positions.length) break;
      const before = snap.positions.length;
      if (!closeTrade(snap.positions[0], '全平')) break;
      closed++;
      if (snapshot().positions.length >= before) break;
    }
    return closed;
  }

  function advanceDay() {
    const res = callTool('advance_real_fx_day');
    if (res.status === TOOL_OK) return true;
    const btn = $('nextDayBtn');
    if (btn && !btn.classList.contains('hidden')) { btn.click(); return true; }
    return false;
  }

  function modalVisible() {
    const modal = $('modal');
    return !!modal && !modal.classList.contains('hidden');
  }

  // 只清理「无 modalAction」的弹窗：modalCancel 的显隐是 openModal 里 action 有无的镜像
  function sweepModals() {
    if (!modalVisible()) return false;
    const cancel = $('modalCancel');
    if (cancel && !cancel.classList.contains('hidden')) return false;
    const confirm = $('modalConfirm');
    if (!confirm) return false;
    confirm.click();
    return true;
  }

  /* ---------------------------------------------------------------- 决策层 */

  const engine = {
    lastActionAt: 0,
    pending: null,
    barCount: 0,
    entryBars: new Map(),
    exitBars: new Map(),
    stopRatio: new Map(),
    pairCooldown: new Map(),
    suppressUntil: 0,
    news: null,
    tickAt: Date.now(),
    priceMemory: { value: null, since: Date.now() }
  };

  const maxAffordable = (cash, leverage) => Math.max(0, Math.floor((cash / (1 + feeRate(leverage))) * 100) / 100);
  const isDriftMode = mode => mode === 'sim' || mode === 'challenge';

  function candidatesFor(snap) {
    if (isDriftMode(snap.mode)) return PAIRS;
    const set = new Set([currentPairFromDom()]);
    snap.positions.forEach(p => set.add(p.pair));
    return [...set];
  }

  function guardNewPosition(snap, pair, side) {
    if (snap.positions.some(p => p.pair === pair)) return false;
    if (snap.positions.length >= cfg.maxPositions) return false;
    if (snap.mode === 'challenge' && snap.challenge && !snap.challenge.active) return false;
    if (snap.mode === 'challenge' && snap.positions.length >= 5) return false;
    const cooled = engine.pairCooldown.get(pair);
    // 同向重进要等冷却；反向（反手）放行，否则反手会被自己的冷却挡住
    return !(cooled && Date.now() - cooled.at < ENTRY_COOLDOWN_MS && cooled.side === side);
  }

  // 半凯利：用游戏自己的平仓记录在线估计 p 与赔率 b，样本不足时回落到保守默认
  function kellyFraction(mode) {
    if (cfg.sizeMode !== 'kelly') return cfg.riskPct;
    const save = readSave();
    const hist = save && save.accounts && save.accounts[mode] && save.accounts[mode].history;
    const settled = Array.isArray(hist) ? hist.filter(h => !h.liquidated) : [];
    if (settled.length < KELLY_MIN_SAMPLE) return 0.12;
    const wins = settled.filter(h => h.pnl > 0);
    const losses = settled.filter(h => h.pnl <= 0);
    const p = wins.length / settled.length;
    const avgWin = wins.length ? wins.reduce((a, h) => a + h.pnl, 0) / wins.length : 1;
    const avgLoss = losses.length ? Math.abs(losses.reduce((a, h) => a + h.pnl, 0) / losses.length) : 1;
    const b = avgLoss > 0 ? avgWin / avgLoss : 1;
    const f = p - (1 - p) / b;
    return clamp(f * KELLY_FRACTION, 0.08, 0.25);
  }

  // 单一货币名义敞口（EUR/USD 做多 = +EUR −USD）
  function currencyNotional(snap) {
    const map = new Map();
    for (const pos of snap.positions) {
      const [base, quote] = String(pos.pair).split('/');
      if (!base || !quote) continue;
      const notional = finite(pos.margin) && finite(pos.leverage) ? pos.margin * pos.leverage : 0;
      const signed = notional * pos.side;
      map.set(base, (map.get(base) || 0) + signed);
      map.set(quote, (map.get(quote) || 0) - signed);
    }
    return map;
  }

  // 相关性去重：新仓若把某个货币的净敞口推过上限，就按比例缩仓
  function exposureScale(snap, pair, side, margin, leverage) {
    const [base, quote] = String(pair).split('/');
    if (!base || !quote) return 1;
    const map = currencyNotional(snap);
    const cap = (finite(snap.equity) ? snap.equity : snap.cash) * MAX_CCY_NOTIONAL_MULT;
    const notional = margin * leverage;
    let scale = 1;
    for (const [ccy, delta] of [[base, notional * side], [quote, -notional * side]]) {
      const cur = map.get(ccy) || 0;
      const next = cur + delta;
      if (Math.abs(next) <= cap) continue;
      // 只有同向叠加才会超限；异号是抵消，不用缩
      if (cur === 0 || Math.sign(cur) !== Math.sign(delta)) continue;
      const allowed = Math.max(0, cap - Math.abs(cur));
      if (Math.abs(delta) > 0) scale = Math.min(scale, allowed / Math.abs(delta));
    }
    return clamp(scale, 0, 1);
  }

  function sizePosition(snap, strength, weight) {
    const equity = finite(snap.equity) ? snap.equity : snap.cash;
    const margin = Math.min(
      Math.max(MIN_MARGIN, Math.round(equity * kellyFraction(snap.mode) * strength * weight)),
      maxAffordable(snap.cash, cfg.leverage)
    );
    return margin >= MIN_MARGIN ? margin : 0;
  }

  // 漂移引擎：按信噪比排序，取第一个可开仓的品种；新闻偏置做方向加权
  function planDrift(snap, signals) {
    const news = activeNewsBias();
    for (const sig of signals) {
      if (!guardNewPosition(snap, sig.pair, sig.side)) continue;
      let weight = 1;
      let note = ' · 漂移' + (sig.value * 100).toFixed(2) + '%/' + sig.horizon + 't';
      if (news && news.bias[sig.pair]) {
        const aligned = Math.sign(news.bias[sig.pair]) === sig.side;
        weight = aligned ? 1.3 : 0.6;
        note += aligned ? ' · 新闻顺风' : ' · 新闻逆风';
      }
      const strength = clamp(Math.abs(sig.value) / (DRIFT_MIN_SUM * 3), 0.5, 1);
      let margin = sizePosition(snap, strength, weight);
      if (!margin) continue;
      const scale = exposureScale(snap, sig.pair, sig.side, margin, cfg.leverage);
      if (scale < 1) {
        margin = Math.floor(margin * scale);
        const floor = Math.max(MIN_MARGIN, Math.round((finite(snap.equity) ? snap.equity : snap.cash) * MIN_POSITION_RATIO));
        if (margin < floor) continue;   // 敞口压缩后仓位过小，静默放弃（属常态，不刷日志）
        note += ' · 敞口' + Math.round(scale * 100) + '%';
      }
      // 漂移越强，可容忍的回撤越大（上限 50%，游戏 60% 会弹窗冻结行情）
      const stopRatio = clamp(0.25 + Math.abs(sig.value) / DRIFT_MIN_SUM * 0.05, STOP_MIN, STOP_MAX);
      return { pair: sig.pair, side: sig.side, margin, leverage: cfg.leverage, horizon: sig.horizon, score: sig.value * 10000, stopRatio, note };
    }
    return null;
  }

  // 指标引擎（real / battle）
  function planIndicator(snap, ranked) {
    const order = ranked.slice().sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
    for (const ind of order) {
      let score = ind.score;
      let note = '';
      if (cfg.allowLookahead) {
        const bias = lookaheadBias(getSeries(snap, ind.pair));
        if (bias !== null) {
          score = clamp(score * 0.25 + clamp(bias / LOOKAHEAD_SCALE, -1, 1) * 75, -100, 100);
          note = ' · 前瞻' + (bias >= 0 ? '+' : '') + (bias * 100).toFixed(2) + '%';
        }
      }
      if (Math.abs(score) < SIGNAL_THRESHOLD) continue;
      const side = score > 0 ? 1 : -1;
      if (!guardNewPosition(snap, ind.pair, side)) continue;
      const margin = sizePosition(snap, clamp(Math.abs(score) / 100, 0.4, 1), 1);
      if (!margin) continue;
      return { pair: ind.pair, side, margin, leverage: cfg.leverage, score, stopRatio: STOP_RATIO, note };
    }
    return null;
  }

  function decide(snap, ctx) {
    return isDriftMode(snap.mode) ? planDrift(snap, ctx.drift) : planIndicator(snap, ctx.ranked);
  }

  function manageRisk(snap, ctx) {
    const driftMode = isDriftMode(snap.mode);
    for (const pos of snap.positions) {
      if (!engine.entryBars.has(pos.id)) engine.entryBars.set(pos.id, engine.barCount);
      if (!finite(pos.margin) || pos.margin <= 0) continue;

      const lossRatio = -pos.pnl / pos.margin;
      const stop = engine.stopRatio.get(pos.id) ?? STOP_RATIO;
      if (lossRatio >= stop) { closeTrade(pos, '止损'); continue; }

      if (driftMode) {
        // 漂移引擎：持有到期即平 —— 累积漂移已经兑现
        const exitAt = engine.exitBars.get(pos.id);
        if (exitAt != null && engine.barCount >= exitAt) { closeTrade(pos, '到期'); continue; }
        // 零交叉反手：从现在起的最优漂移窗口已经指向反面，剩余持有期是负期望 → 提前离场换向
        const sig = ctx.driftByPair.get(pos.pair);
        if (sig && sig.side !== pos.side) { closeTrade(pos, '反手'); continue; }
        continue;
      }

      if (pos.pnl > 0 && pos.pnl / pos.margin >= cfg.takeProfitRatio) { closeTrade(pos, '止盈'); continue; }

      const ind = ctx.indMap.get(pos.pair);
      if (ind) {
        const against = pos.side === 1 ? ind.score <= -cfg.reverseExitScore : ind.score >= cfg.reverseExitScore;
        if (against) { closeTrade(pos, '反转'); continue; }
      }

      const bars = engine.barCount - engine.entryBars.get(pos.id);
      if (bars >= cfg.timeStopBars && pos.pnl <= 0) closeTrade(pos, '时间止损');
    }
    for (const id of engine.entryBars.keys()) {
      if (!snap.positions.some(p => p.id === id)) { engine.entryBars.delete(id); engine.exitBars.delete(id); }
    }
  }

  function registerExit(position, plan) {
    if (!position) return;
    const id = position.id || (position.value && position.value.id);
    if (!id) return;
    engine.exitBars.set(id, engine.barCount + (plan.horizon || DRIFT_MAX_BARS));
    engine.stopRatio.set(id, plan.stopRatio || STOP_RATIO);
  }

  /* ------------------------------------------------------------------ UI */

  const ui = { ready: false, collapsed: false };

  const CSS = [
    '.fxq-panel{position:fixed;left:12px;bottom:12px;width:302px;z-index:2147483000;',
    'font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;',
    'color:#e8f3ee;background:linear-gradient(160deg,rgba(18,38,40,.97),rgba(10,23,25,.98));',
    'border:1px solid rgba(120,200,170,.28);border-radius:14px;box-shadow:0 18px 44px rgba(0,0,0,.45);',
    'backdrop-filter:blur(10px);overflow:hidden;user-select:none}',
    '.fxq-panel.fxq-collapsed{width:auto}',
    '.fxq-panel.fxq-collapsed .fxq-body{display:none}',
    '.fxq-head{display:flex;align-items:center;gap:8px;padding:9px 11px;cursor:move;',
    'background:rgba(255,255,255,.04);border-bottom:1px solid rgba(120,200,170,.16)}',
    '.fxq-title{font-weight:600;letter-spacing:.4px;flex:1;font-size:12px}',
    '.fxq-dot{width:7px;height:7px;border-radius:50%;background:#57cf9b;box-shadow:0 0 8px #57cf9b}',
    '.fxq-dot.warn{background:#efb35f;box-shadow:0 0 8px #efb35f}',
    '.fxq-dot.bad{background:#ef8ba0;box-shadow:0 0 8px #ef8ba0}',
    '.fxq-btn{border:1px solid rgba(120,200,170,.35);background:rgba(120,200,170,.1);color:#cdeee0;',
    'border-radius:7px;padding:2px 7px;font-size:11px;cursor:pointer;font-family:inherit}',
    '.fxq-btn:hover{background:rgba(120,200,170,.22)}',
    '.fxq-btn.on{background:#57cf9b;border-color:#57cf9b;color:#08201a;font-weight:600}',
    '.fxq-body{padding:9px 11px 11px;display:flex;flex-direction:column;gap:8px}',
    '.fxq-row{display:flex;align-items:center;justify-content:space-between;gap:6px}',
    '.fxq-kv{display:grid;grid-template-columns:repeat(3,1fr);gap:4px 6px}',
    '.fxq-kv div{background:rgba(255,255,255,.045);border-radius:6px;padding:3px 6px}',
    '.fxq-kv span{display:block;font-size:10px;color:#7fa79a}',
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
    '.fxq-up{color:#57cf9b}.fxq-down{color:#ef8ba0}'
  ].join('');

  function make(tag, cls, text) {
    const node = PAGE.document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function buildUI() {
    if (ui.ready) return;
    const host = PAGE.document.body;
    if (!host) return;

    const style = make('style');
    style.textContent = CSS;
    PAGE.document.head.appendChild(style);

    const root = make('div', 'fxq-panel');
    root.innerHTML = [
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
      '  <div class="fxq-row"><span class="fxq-hint">自动化</span>',
      '    <div class="fxq-seg">',
      '      <button class="fxq-btn" data-fxq="auto-off">关</button>',
      '      <button class="fxq-btn" data-fxq="auto-confirm">确认</button>',
      '      <button class="fxq-btn" data-fxq="auto-auto">自动</button>',
      '    </div></div>',
      '  <div class="fxq-row">',
      '    <span class="fxq-hint">杠杆 <b data-fxq="lev">30×</b></span>',
      '    <span class="fxq-hint">风险 <b data-fxq="risk">12%</b></span>',
      '    <button class="fxq-btn" data-fxq="look">前瞻</button>',
      '  </div>',
      '  <div class="fxq-row">',
      '    <button class="fxq-btn" data-fxq="exec">执行信号</button>',
      '    <button class="fxq-btn" data-fxq="closeall">全平</button>',
      '    <button class="fxq-btn" data-fxq="fast">快进</button>',
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
    host.appendChild(root);

    const q = key => root.querySelector('[data-fxq="' + key + '"]');
    Object.assign(ui, {
      ready: true, root,
      dot: q('dot'), via: q('via'), mode: q('mode'), sig: q('sig'), src: q('src'), k1: q('k1'),
      bar: q('bar'), ema: q('ema'), rsi: q('rsi'), atr: q('atr'), macd: q('macd'),
      boll: q('boll'), roc: q('roc'), advice: q('advice'), lev: q('lev'), risk: q('risk'),
      look: q('look'), equity: q('equity'), cash: q('cash'), float: q('float'),
      posline: q('posline'), log: q('log'),
      autoOff: q('auto-off'), autoConfirm: q('auto-confirm'), autoAuto: q('auto-auto'),
      exec: q('exec'), closeall: q('closeall'), fast: q('fast'), fold: q('fold')
    });

    ui.fold.addEventListener('click', () => {
      ui.collapsed = !ui.collapsed;
      root.classList.toggle('fxq-collapsed', ui.collapsed);
      ui.fold.textContent = ui.collapsed ? '+' : '—';
    });

    const setAutomation = level => {
      cfg.automation = level;
      saveConfig();
      renderAutomation();
      log('自动化切换为「' + ({ off: '关闭', confirm: '确认', auto: '全自动' })[level] + '」');
    };
    ui.autoOff.addEventListener('click', () => setAutomation('off'));
    ui.autoConfirm.addEventListener('click', () => setAutomation('confirm'));
    ui.autoAuto.addEventListener('click', () => setAutomation('auto'));

    ui.look.addEventListener('click', () => {
      cfg.allowLookahead = !cfg.allowLookahead;
      saveConfig();
      renderAutomation();
      log(cfg.allowLookahead ? '已开启前瞻（real/battle 使用未来数据，属作弊）' : '已关闭前瞻');
    });

    ui.exec.addEventListener('click', () => {
      const plan = engine.pending;
      if (!plan) { log('当前没有待执行信号'); return; }
      if (openTrade(plan.pair, plan.side, plan.margin, plan.leverage)) engine.pending = null;
    });

    ui.closeall.addEventListener('click', () => {
      if (!closeAllPositions()) log('当前没有持仓');
    });

    ui.fast.addEventListener('click', () => runFastForward(30));

    const LEVS = [5, 10, 20, 30, 50, 100];
    const RISKS = [0.05, 0.1, 0.12, 0.15, 0.2, 0.3];
    ui.lev.addEventListener('click', () => {
      cfg.leverage = LEVS[(LEVS.indexOf(cfg.leverage) + 1) % LEVS.length];
      saveConfig(); renderAutomation();
      log('杠杆 → ' + cfg.leverage + '×');
    });
    ui.risk.addEventListener('click', () => {
      if (cfg.sizeMode === 'kelly') {
        cfg.sizeMode = 'fixed';
        cfg.riskPct = RISKS[0];
      } else {
        const next = RISKS.indexOf(cfg.riskPct) + 1;
        if (next >= RISKS.length) cfg.sizeMode = 'kelly';
        else cfg.riskPct = RISKS[next];
      }
      saveConfig(); renderAutomation();
      log(cfg.sizeMode === 'kelly' ? '定量 → 半凯利' : '定量 → 固定 ' + Math.round(cfg.riskPct * 100) + '%');
    });

    makeDraggable(root, root.querySelector('.fxq-head'));
    renderAutomation();
  }

  function makeDraggable(node, handle) {
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    handle.addEventListener('mousedown', e => {
      if (e.target.classList.contains('fxq-btn')) return;
      const rect = node.getBoundingClientRect();
      dragging = true; sx = e.clientX; sy = e.clientY; ox = rect.left; oy = rect.top;
      node.style.right = 'auto'; node.style.bottom = 'auto';
      node.style.left = ox + 'px'; node.style.top = oy + 'px';
      e.preventDefault();
    });
    PAGE.addEventListener('mousemove', e => {
      if (!dragging) return;
      node.style.left = (ox + e.clientX - sx) + 'px';
      node.style.top = (oy + e.clientY - sy) + 'px';
    });
    PAGE.addEventListener('mouseup', () => { dragging = false; });
  }

  function renderAutomation() {
    if (!ui.ready) return;
    ui.autoOff.classList.toggle('on', cfg.automation === 'off');
    ui.autoConfirm.classList.toggle('on', cfg.automation === 'confirm');
    ui.autoAuto.classList.toggle('on', cfg.automation === 'auto');
    ui.look.classList.toggle('on', !!cfg.allowLookahead);
    ui.lev.textContent = cfg.leverage + '×';
    ui.risk.textContent = cfg.sizeMode === 'kelly' ? '凯利 ' + Math.round(kellyFraction(currentSnap.mode) * 100) + '%' : Math.round(cfg.riskPct * 100) + '%';
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

  function renderPanel(snap, ctx, plan) {
    if (!ui.ready) return;
    setText(ui.via, BRIDGE.via === 'api' ? '通道 · 内部 API' : '通道 · DOM 兜底');
    setText(ui.mode, MODE_LABEL[snap.mode] || snap.mode);
    setText(ui.k1, isDriftMode(snap.mode) ? '漂移累积' : 'EMA12/26');

    const top = ctx.drift[0];
    if (isDriftMode(snap.mode)) {
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
        setText(ui.macd, String(ctx.drift.length) + ' 个', '');
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
    } else {
      const ind = ctx.best;
      if (!ind) {
        setText(ui.sig, '数据积累中', 'fxq-sig');
        setStyle(ui.bar, 'left', '50%');
        setStyle(ui.bar, 'width', '0');
        clearIndicators();
        setText(ui.advice, '等待 K 线数据…', 'fxq-advice');
      } else {
        const score = ind.score;
        const label = score >= 55 ? '强多' : score >= SIGNAL_THRESHOLD ? '偏多'
          : score <= -55 ? '强空' : score <= -SIGNAL_THRESHOLD ? '偏空' : '中性';
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
    }

    setText(ui.equity, finite(snap.equity) ? money(snap.equity) : '—');
    setText(ui.cash, finite(snap.cash) ? money(snap.cash) : '—');
    const floating = snap.positions.reduce((s, p) => s + (finite(p.pnl) ? p.pnl : 0), 0);
    setText(ui.float, signedMoney(floating), floating >= 0 ? 'fxq-up' : 'fxq-down');

    if (snap.positions.length) {
      const worst = snap.positions.reduce((m, p) => {
        if (!finite(p.margin) || p.margin <= 0) return m;
        return Math.max(m, -p.pnl / p.margin);
      }, 0);
      setText(ui.dot, '', 'fxq-dot' + (worst >= RISK_WARN ? ' bad' : worst >= STOP_RATIO ? ' warn' : ''));
      setText(ui.posline, snap.positions.map(p => {
        const ratio = finite(p.margin) && p.margin > 0
          ? ' (' + (p.pnl >= 0 ? '+' : '') + Math.round(p.pnl / p.margin * 100) + '%)'
          : '';
        return p.pair + (p.side === 1 ? '多' : '空') + ' ' + signedMoney(p.pnl || 0) + ratio;
      }).join('   '));
    } else {
      setText(ui.dot, '', 'fxq-dot');
      setText(ui.posline, '无持仓');
    }
  }

  /* -------------------------------------------------------------- 主循环 */

  const fastForward = { active: false, remaining: 0 };
  let currentSnap = { mode: 'sim', positions: [], prices: {}, cash: 0, equity: 0 };

  function runFastForward(days) {
    if (isDriftMode(currentSnap.mode)) { log('快进只用于真实回放 / 经典战役'); return; }
    fastForward.active = true;
    fastForward.remaining = days;
    log('快进 ' + days + ' 个交易日（风控全程生效）');
  }

  function step() {
    const snap = snapshot();
    currentSnap = snap;
    recordSample(snap);

    // 价格变化即视为一根新 bar；同时用于识别 riskPaused 造成的行情冻结
    const priceNow = snap.prices['EUR/USD'];
    if (finite(priceNow) && priceNow !== engine.priceMemory.value) {
      engine.priceMemory.value = priceNow;
      engine.priceMemory.since = Date.now();
      engine.tickAt = Date.now();
      engine.barCount++;
    }
    if (modalVisible() && Date.now() - engine.priceMemory.since > FREEZE_DETECT_MS) sweepModals();

    const newsNow = readNewsBias();
    if (newsNow && (!engine.news || engine.news.title !== newsNow.title)) {
      engine.news = { tag: newsNow.tag, title: newsNow.title, bias: newsNow.bias, at: Date.now() };
      log('新闻「' + newsNow.tag + '」' + newsNow.title);
    }

    const ctx = { drift: [], driftByPair: new Map(), ranked: [], indMap: new Map(), best: null };
    for (const pair of candidatesFor(snap)) {
      const ind = cachedIndicators(getSeries(snap, pair), pair, snap.mode);
      if (!ind) continue;
      ctx.indMap.set(pair, ind);
      ctx.ranked.push(ind);
    }
    ctx.best = ctx.ranked.reduce((best, ind) => !best || Math.abs(ind.score) > Math.abs(best.score) ? ind : best, null);
    if (isDriftMode(snap.mode)) {
      ctx.drift = driftSignals(snap, engine.tickAt);
      for (const sig of ctx.drift) ctx.driftByPair.set(sig.pair, sig);
    }

    manageRisk(snap, ctx);

    const plan = decide(snap, ctx);
    engine.pending = plan;

    if (plan && cfg.automation === 'auto' && Date.now() > engine.suppressUntil && Date.now() - engine.lastActionAt > ACTION_COOLDOWN_MS) {
      engine.lastActionAt = Date.now();
      if (openTrade(plan.pair, plan.side, plan.margin, plan.leverage)) {
        engine.pending = null;
        const after = snapshot();
        const opened = after.positions.find(p => p.pair === plan.pair);
        if (opened) registerExit(opened, plan);
      }
    }

    const playback = snap.mode === 'real' || snap.mode === 'battle';
    if (fastForward.active) {
      if (fastForward.remaining > 0) {
        if (advanceDay()) fastForward.remaining--;
        else { fastForward.active = false; log('快进中断'); }
      } else {
        fastForward.active = false;
        log('快进结束');
      }
    } else if (playback && cfg.automation === 'auto' && Date.now() - engine.lastActionAt > DAY_ADVANCE_MS) {
      engine.lastActionAt = Date.now();
      advanceDay();
    }

    if (modalVisible()) sweepModals();
    renderPanel(snap, ctx, engine.pending);
  }

  /* ------------------------------------------------------------------ 启动 */

  installDirectBridge();
  installScriptBridge();
  PAGE.__FXQ__ = {
    BRIDGE, cfg, engine, snapshot, computeIndicators, getSeries, hasTool, logLines,
    closeAllPositions, sweepModals, step, driftSum, bestDrift, driftSignals
  };

  let bootWaits = 0;
  function boot() {
    if (!PAGE.document.body) { setTimeout(boot, 60); return; }
    if (!$('longBtn')) { if (++bootWaits < 100) setTimeout(boot, 150); return; }
    buildUI();
    log('量化辅助台已就绪 v1.2.0（漂移引擎 + 指标引擎）');
    setInterval(() => {
      try { step(); } catch (err) { log('循环异常：' + (err && err.message ? err.message : err)); }
    }, LOOP_MS);
    setInterval(() => { sweepModals(); }, SWEEP_MS);
  }

  if (PAGE.document.readyState === 'loading') {
    PAGE.document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
