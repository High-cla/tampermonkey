// ==UserScript==
// @name         大A 简单! · 做市量化台
// @namespace    fx-quant/a-share
// @version      3.5.0
// @description  限价做市引擎：bid0+1tick 买入 / ask0-1tick 卖出；凯利定仓 + 限价止损；主世界直跑，自建 WS 不依赖页面 socket；云存储退避 + 移动端适配 + 遮挡补偿 + WS 退避重连 + token 落盘
// @match        https://www.bilibili.com/toy/suoha/*
// @match        https://www.bilibilitoy.com/toy/suoha/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
  if (window.__ASHARE_QUANT__) return;
  if (!location.hostname.endsWith('bilibilitoy.com')) return;
  window.__ASHARE_QUANT__ = true;

  /* ================= 常量 ================= */
  const WAIT_MS = 25000;          // 挂单存活期
  const GRACE_MS = 4000;          // 挂单后快照未回显的宽限
  const WATCHDOG_MS = 25000;      // 单次 step 的硬上限（AbortController）
  const STOP_FALLBACK_MS = 3000;  // 止损限价转市价的等待
  const DEPTH_REF = 1000;         // pickPair 的深度基准（股）
  const KELLY_WINDOW = 40;
  const KELLY_MIN_SAMPLES = 10;
  const HISTORY_MAX = 200;
  const LOG_MAX = 60;
  const LOG_SHOW = 14;
  const MIN_MARGIN = 20;
  const STOP_RISK = 0.35;
  const KELLY_MIN = 0.03, KELLY_MAX = 0.20;
  const BASE_FRAC = 0.08;
  const TICK_FALLBACK = 0.01;
  const REQ_TIMEOUT_MS = 20000;
  const CFG_KEY = 'ashare-mm-config-v1';
  const FOLD_KEY = 'ashare-mm-fold';
  const BACKEND = 'https://8.134.122.85/a-share/';
  const CLOUD_KEY = 'a_share_online_session_v1';
  const LOCAL_KEY = 'a-share-local-session-v1';

  // 官方限流：云存储/排行榜由全 Toy 玩家共享额度，超限 SDK 抛 { type:'http_error', code:307044 }
  // https://github.com/bilibili/toy → skills/toy/references/content-checklist.md §7
  const CLOUD_BACKOFF_BASE = 1000;   // 首次退避
  const CLOUD_BACKOFF_MAX = 60000;   // 退避上限
  const CLOUD_FAIL_LIMIT = 5;        // 连续失败到此数后放弃云通道
  const MOBILE_BREAKPOINT = 720;
  // 服务端硬约束：限价必须在现价 ±20% 内（实测 400「限价需在现价上下 20%（至少一个价格档位）范围内。」）
  const LIMIT_BAND = 0.2;
  const OCCLUSION_MIN_GAP = 5000;  // 遮挡补偿阈值：更短的切换不改状态
  const WS_RETRY_BASE = 1000;      // WS 重连退避起点
  const WS_RETRY_MAX = 30000;      // WS 重连退避上限
  const WS_RETRY_JITTER = 0.2;     // 重连抖动 ±20%，避免多客户端同步重连风暴

  const PHASE = Object.freeze({ idle: '空闲', bidding: '挂买中', asking: '挂卖中', closing: '平仓中' });
  const DEFAULTS = Object.freeze({ lev: 5, margin: 500 });

  /* ================= 格式化（Intl 实例缓存） ================= */
  const NF2 = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
  const NF0 = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
  const TF = new Intl.DateTimeFormat('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const round2 = x => Math.round(x * 100) / 100;
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  /* ================= 事件总线（可解绑） ================= */
  const bus = (() => {
    const m = new Map();
    return {
      on(k, fn) {
        let a = m.get(k);
        if (!a) { a = []; m.set(k, a); }
        a.push(fn);
        return () => { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); };
      },
      emit(k, p) {
        const a = m.get(k);
        if (!a) return;
        for (let i = 0; i < a.length; i++) {
          try { a[i](p); } catch (e) { console.error('[aq]', k, e); }
        }
      },
      dispose() { m.clear(); },
    };
  })();

  /* ================= 状态：连接 / 做市 / UI / 统计 ================= */
  const conn = {
    snap: null,
    token: '',
    stocks: new Map(),
    tickOf: () => TICK_FALLBACK,
    nameOf: id => (conn.stocks.get(id) || {}).name || id,
  };

  // token 落盘：云通道限流时 localStorage 是唯一兜底。三个入口（hook 拦截 / 云读取 / 匿名建号）都走这里。
  function cacheToken(t) {
    if (!t || t === conn.token) return;
    conn.token = t;
    try { localStorage.setItem(LOCAL_KEY, t); } catch {}
  }

  const mm = {
    phase: 'idle',
    pair: null,
    orderId: null,
    posId: null,
    deadline: 0,
    grace: 0,
    stopAt: 0,
    seq: 0,
  };

  // 遮挡补偿：Windows 上 Edge 默认 CalculateNativeWinOcclusion，标签页被完全遮挡时
  // 渲染进程挂起（定时器/WS/fetch 全停），但 Date.now() 照走 → 恢复后所有 deadline 瞬间过期。
  // 做法是把仍在进行中的计时器顺延遮挡时长，而不是重置（重置会让 Date.now() > 0 恒真）。
  let hiddenSince = 0;

  function shiftTimers(gap) {
    if (gap < OCCLUSION_MIN_GAP) return false;
    for (const k of ['deadline', 'grace', 'stopAt']) if (mm[k]) mm[k] += gap;
    return true;
  }

  function onVisibilityChange() {
    if (document.hidden) { hiddenSince = Date.now(); return; }
    if (!hiddenSince) return;
    const gap = Date.now() - hiddenSince;
    hiddenSince = 0;
    if (shiftTimers(gap)) pushLog('遮挡 ' + Math.round(gap / 1000) + 's，计时器顺延');
  }

  const stats = { history: [], lastTradeAt: 0, lastServerTime: 0 };

  const ui = { auto: false, logs: [], refs: null };

  const cfg = (() => {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(CFG_KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
  })();

  /* ================= 数学 ================= */
  function kelly() {
    const h = stats.history;
    const start = Math.max(0, h.length - KELLY_WINDOW);
    const n = h.length - start;
    if (n < KELLY_MIN_SAMPLES) return BASE_FRAC;
    let winSum = 0, winN = 0, lossSum = 0, lossN = 0;
    for (let i = start; i < h.length; i++) {
      const x = h[i];
      if (x > 0) { winSum += x; winN++; } else { lossSum += x; lossN++; }
    }
    if (!winN || !lossN) return KELLY_MIN;
    const aw = winSum / winN;
    const al = Math.abs(lossSum / lossN);
    if (aw <= 0 || al <= 0) return KELLY_MIN;
    const p = winN / n;
    return clamp(p - (1 - p) / (aw / al), KELLY_MIN, KELLY_MAX);
  }

  /* ================= 桥接 ================= */
  const PAGE = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;

  function initBridge() {
    const Orig = PAGE.WebSocket;
    if (!Orig) return;
    function Patched(url, protocols) {
      const ws = protocols === undefined ? new Orig(url) : new Orig(url, protocols);
      try {
        const send = ws.send.bind(ws);
        ws.send = data => {
          if (!conn.token) {
            try {
              const m = JSON.parse(data);
              if (m && typeof m.sessionToken === 'string' && m.sessionToken) cacheToken(m.sessionToken);
            } catch {}
          }
          return send(data);
        };
        ws.addEventListener('message', ev => {
          // 自建 WS 已接管行情后，游戏 socket 的每帧 JSON.parse 是纯浪费
          if (conn.token && conn.snap) return;
          let d;
          try { d = JSON.parse(ev.data); } catch { return; }
          if (d && d.type === 'snapshot') bus.emit('data:snapshot', d);
        });
      } catch {}
      return ws;
    }
    Patched.prototype = Orig.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Patched[k] = Orig[k];
    PAGE.WebSocket = Patched;
  }

  // 云通道状态：指数退避 + 放弃标记。成功后 token 在会话期内不变，永不再调。
  const cloud = { fails: 0, rateFails: 0, until: 0, dead: false };

  async function readCloudToken() {
    if (cloud.dead || Date.now() < cloud.until) return '';
    const toy = PAGE.toy;
    if (!toy) return '';
    let ok = false;
    try {
      ok = typeof toy.isSupport === 'function'
        ? await toy.isSupport('getCloudStorage')
        : typeof toy.getCloudStorage === 'function';
    } catch { ok = false; }
    if (!ok) { cloud.dead = true; return ''; }
    try {
      const d = await toy.getCloudStorage([CLOUD_KEY]);
      const t = d && d[CLOUD_KEY];
      if (t) { cloud.fails = 0; cloud.rateFails = 0; cloud.until = 0; return t; }
      return '';
    } catch (e) {
      // 307044 是共享额度触发的正常限流（官方定性），只退避不放弃；
      // 用独立计数器，避免限流把 fails 推到阈值后在下一个无关错误上误判永久失效。
      if (e && e.code === 307044) {
        cloud.rateFails++;
        const delay = Math.min(CLOUD_BACKOFF_MAX, CLOUD_BACKOFF_BASE * 2 ** (cloud.rateFails - 1));
        cloud.until = Date.now() + delay;
        pushLog('云存储限流，' + Math.round(delay / 1000) + 's 后重试');
        return '';
      }
      cloud.fails++;
      const delay = Math.min(CLOUD_BACKOFF_MAX, CLOUD_BACKOFF_BASE * 2 ** (cloud.fails - 1));
      cloud.until = Date.now() + delay;
      if (cloud.fails >= CLOUD_FAIL_LIMIT) { cloud.dead = true; pushLog('云存储不可用，改用本地 token'); }
      return '';
    }
  }

  async function ensureToken() {
    if (conn.token) return true;
    const t = await readCloudToken();
    if (t) { cacheToken(t); return true; }
    try {
      const lt = localStorage.getItem(LOCAL_KEY);
      if (lt) { conn.token = lt; return true; }
    } catch {}
    return false;
  }

  let inflight = null;

  async function post(path, body = {}, auth = true) {
    const base = new URL('api/', PAGE.A_SHARE_BACKEND_URL || BACKEND);
    const headers = { 'Content-Type': 'application/json', 'X-A-Share-Action': '1' };
    if (auth && conn.token) headers.Authorization = 'Bearer ' + conn.token;
    const signals = [AbortSignal.timeout(REQ_TIMEOUT_MS)];
    if (inflight) signals.push(inflight.signal);
    const r = await fetch(new URL(path, base), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    });
    const d = await r.json().catch(() => null);
    if (!r.ok) throw new Error((d && (d.detail || d.error)) || '操作失败');
    return d;
  }

  /* ================= 快照入库 ================= */
  function indexStocks(snap) {
    let changed = false;
    for (const s of snap.stocks || []) {
      if (conn.stocks.get(s.id) !== s) { conn.stocks.set(s.id, s); changed = true; }
    }
    if (changed) conn.tickOf = id => 10 ** -((conn.stocks.get(id) || {}).digits ?? 2);
  }

  function detectFill(snap) {
    const tr = snap.account && snap.account.trades && snap.account.trades[0];
    if (!tr || !(tr.at > stats.lastTradeAt)) return null;
    stats.lastTradeAt = tr.at;
    stats.history.push(tr.pnl);
    if (stats.history.length > HISTORY_MAX) stats.history.shift();
    return tr;
  }

  bus.on('data:snapshot', snap => {
    if (!ui.refs) mount();
    if (snap.serverTime && snap.serverTime === stats.lastServerTime) return;
    stats.lastServerTime = snap.serverTime || 0;
    conn.snap = snap;
    indexStocks(snap);
    const fill = detectFill(snap);
    if (fill) pushLog('成交 ' + conn.nameOf(fill.stock) + ' pnl ' + (fill.pnl >= 0 ? '+' : '') + fill.pnl.toFixed(2) + ' (' + fill.reason + ')');
    step(snap);
    render();
  });

  /* ================= 状态机（纯规划 + 外层执行） ================= */
  let busy = false;

  function pickPair(snap) {
    let best = null;
    for (const p of Object.keys(snap.orderBooks || {})) {
      const bk = snap.orderBooks[p];
      const bid = bk && bk.bids && bk.bids[0];
      const ask = bk && bk.asks && bk.asks[0];
      if (!bid || !ask || !bid.price) continue;
      const spread = (ask.price - bid.price) / bid.price;
      const depth = Math.min(bid.qty, ask.qty);
      const score = spread * clamp(depth / DEPTH_REF, 0, 1);
      if (!best || score > best.score) best = { pair: p, score };
    }
    return best;
  }

  function orderById(snap, id) {
    if (!id) return null;
    const orders = (snap.account && snap.account.orders) || [];
    for (let i = 0; i < orders.length; i++) if (orders[i].id === id) return orders[i];
    return null;
  }

  function firstPos(snap) {
    const ps = (snap.account && snap.account.positions) || [];
    return ps[0] || null;
  }

  // 服务端现价（markets[stock].price）——限价带以它为基准，不是 bid0/ask0
  function refPrice(snap, stock) {
    const m = snap.markets && snap.markets[stock];
    return (m && m.price) || 0;
  }

  function inBand(price, ref) {
    return ref > 0 && Math.abs(price / ref - 1) <= LIMIT_BAND;
  }

  let lastPosCount = 0;

  function planIdle(snap) {
    const ps = (snap.account && snap.account.positions) || [];
    // 自动模式只管理第一个持仓；多仓时给出一次警告（数量变化才打，避免刷屏）
    if (ps.length > 1 && ps.length !== lastPosCount) pushLog('警告：' + ps.length + ' 个持仓，自动模式只管理第一个');
    lastPosCount = ps.length;
    const pos = ps[0] || null;
    if (pos) return { type: 'ask', pos };
    const orders = (snap.account && snap.account.orders) || [];
    for (let i = 0; i < orders.length; i++) if (orders[i].status === 'open') return { type: 'none' };
    const pick = pickPair(snap);
    return pick ? { type: 'bid', pair: pick.pair } : { type: 'none' };
  }

  function planBidding(snap) {
    const od = orderById(snap, mm.orderId);
    if (!od && Date.now() < mm.grace) return { type: 'none' };
    if (!od) return { type: 'reset', why: '买单丢失' };
    if (od.status !== 'open') return { type: 'reset', why: od.status === 'filled' ? '买单成交' : '买单撤销' };
    if (Date.now() > mm.deadline) return { type: 'cancel', why: '买单超时' };
    return { type: 'none' };
  }

  function planAsking(snap) {
    const pos = firstPos(snap);
    if (!pos || pos.id !== mm.posId) return { type: 'reset', why: '卖单成交' };
    if (-pos.pnl / pos.margin >= STOP_RISK) return { type: 'stop', pos };
    const bk = snap.orderBooks && snap.orderBooks[pos.stock];
    const ask = bk && bk.asks && bk.asks[0];
    if (!ask) return { type: 'reset', why: '无卖盘' };
    const want = round2(ask.price - conn.tickOf(pos.stock));
    const od = orderById(snap, mm.orderId);
    if (!od && Date.now() < mm.grace) return { type: 'none' };
    if (!od || od.status !== 'open') return { type: 'ask', pos };
    if (Math.abs(od.price - want) >= conn.tickOf(pos.stock) * 2) return { type: 'requote', pos, price: want };
    if (Date.now() > mm.deadline) return { type: 'stop', pos };
    return { type: 'none' };
  }

  function planClosing(snap) {
    const pos = firstPos(snap);
    if (!pos || pos.id !== mm.posId) return { type: 'reset', why: '平仓成交' };
    const bk = snap.orderBooks && snap.orderBooks[pos.stock];
    const bid = bk && bk.bids && bk.bids[0];
    if (!bid || Date.now() > mm.stopAt + STOP_FALLBACK_MS) return { type: 'stopMarket', pos };
    return { type: 'none' };
  }

  const PLANNERS = { idle: planIdle, bidding: planBidding, asking: planAsking, closing: planClosing };

  function reset(why) {
    if (why) pushLog(why);
    mm.phase = 'idle';
    mm.pair = null;
    mm.orderId = null;
    mm.posId = null;
    mm.deadline = 0;
    mm.grace = 0;
    mm.stopAt = 0;
  }

  async function placeBid(snap, pair) {
    if (!(await ensureToken())) { pushLog('无 token，跳过下单'); return reset(); }
    const bk = snap.orderBooks[pair];
    const bid = bk && bk.bids && bk.bids[0];
    if (!bid) return reset();
    const price = round2(bid.price + conn.tickOf(pair));
    const ref = refPrice(snap, pair);
    if (!inBand(price, ref)) { pushLog('挂买价 ' + price + ' 超出现价 ' + ref + ' 的 ±20%'); return reset(); }
    const avail = (snap.account && snap.account.available) || 0;
    const margin = Math.max(MIN_MARGIN, Math.min(cfg.margin, avail * kelly()));
    if (avail < margin) { pushLog('可用不足'); return reset(); }
    const r = await post('order', {
      stock: pair, side: 1, margin: round2(margin),
      leverage: cfg.lev, orderType: 'limit', limitPrice: price,
    });
    if (!r || !r.orderId) return reset();
    mm.phase = 'bidding';
    mm.pair = pair;
    mm.orderId = r.orderId;
    mm.deadline = Date.now() + WAIT_MS;
    mm.grace = Date.now() + GRACE_MS;
    pushLog('挂买 ' + conn.nameOf(pair) + ' @' + price + ' 保证金 ¥' + NF0.format(margin));
  }

  async function placeAsk(snap, pos) {
    if (!(await ensureToken())) { pushLog('无 token，跳过平仓'); return reset(); }
    const bk = snap.orderBooks[pos.stock];
    const ask = bk && bk.asks && bk.asks[0];
    if (!ask) return reset();
    const price = round2(ask.price - conn.tickOf(pos.stock));
    const ref = refPrice(snap, pos.stock);
    if (!inBand(price, ref)) { pushLog('挂卖价 ' + price + ' 超出现价 ' + ref + ' 的 ±20%'); return reset(); }
    const r = await post('close', { id: pos.id, orderType: 'limit', limitPrice: price });
    if (!r) return reset();
    mm.phase = 'asking';
    mm.orderId = r.orderId;
    mm.posId = pos.id;
    mm.deadline = Date.now() + WAIT_MS;
    mm.grace = Date.now() + GRACE_MS;
    pushLog('挂卖 ' + conn.nameOf(pos.stock) + ' @' + price);
  }

  async function closeLimit(snap, pos, why) {
    if (!(await ensureToken())) { pushLog('无 token，跳过止损'); return reset(); }
    const bk = snap.orderBooks[pos.stock];
    const bid = bk && bk.bids && bk.bids[0];
    if (!bid) return closeMarket(pos, why);
    const price = round2(bid.price);
    const ref = refPrice(snap, pos.stock);
    if (!inBand(price, ref)) { pushLog('止损价 ' + price + ' 超出现价 ' + ref + ' 的 ±20%，改市价'); return closeMarket(pos, why); }
    try {
      await post('close', { id: pos.id, orderType: 'limit', limitPrice: price });
      mm.phase = 'closing';
      mm.posId = pos.id;
      mm.stopAt = Date.now();
      pushLog('限价平 ' + conn.nameOf(pos.stock) + '(' + why + ') @' + price);
    } catch (e) {
      pushLog('限价平失败: ' + e.message);
      await closeMarket(pos, why);
    }
  }

  async function closeMarket(pos, why) {
    try {
      await post('close', { id: pos.id, orderType: 'market' });
      pushLog('市价平 ' + conn.nameOf(pos.stock) + '(' + why + ')');
    } catch (e) { pushLog('平仓失败: ' + e.message); }
    reset();
  }

  async function cancelOrder() {
    if (!mm.orderId) return true;
    try {
      await post('cancel', { id: mm.orderId });
      mm.orderId = null;
      return true;
    } catch (e) {
      if (/不存在|已撤销|已成交|已经平仓/.test(e.message)) { mm.orderId = null; return true; }
      pushLog('撤单失败: ' + e.message);
      return false;
    }
  }

  async function execute(snap, plan) {
    switch (plan.type) {
      case 'bid': return placeBid(snap, plan.pair);
      case 'ask': return placeAsk(snap, plan.pos);
      case 'requote': {
        if (!(await cancelOrder())) return;
        return placeAsk(snap, plan.pos);
      }
      case 'cancel': {
        if (!(await cancelOrder())) return;
        return reset(plan.why);
      }
      case 'stop': return closeLimit(snap, plan.pos, '止损');
      case 'stopMarket': return closeMarket(plan.pos, '止损降级');
      case 'reset': return reset(plan.why);
      default: return;
    }
  }

  async function step(snap) {
    if (!ui.auto || busy || !snap || !snap.account) return;
    busy = true;
    const seq = ++mm.seq;
    inflight = new AbortController();
    const timer = setTimeout(() => inflight && inflight.abort(), WATCHDOG_MS);
    try {
      const plan = (PLANNERS[mm.phase] || planIdle)(snap);
      if (seq !== mm.seq) return;
      await execute(snap, plan);
    } catch (e) {
      if (e && e.name !== 'AbortError') pushLog('错误: ' + e.message);
    } finally {
      clearTimeout(timer);
      inflight = null;
      busy = false;
    }
  }

  /* ================= 日志 ================= */
  function pushLog(msg) {
    const line = TF.format(new Date()) + '  ' + msg;
    ui.logs.unshift(line);
    if (ui.logs.length > LOG_MAX) ui.logs.pop();
    if (ui.refs) prependLogLine(line);
  }

  /* ================= 面板 ================= */
  const HTML = [
    '<div class="aq-head"><span class="aq-dot" data-aq="dot"></span><b>大A 做市</b>',
    '<button class="aq-btn" data-aq="fold">—</button></div>',
    '<div class="aq-body">',
    '  <div class="aq-row"><span data-aq="conn">未连接</span><span data-aq="equity">—</span></div>',
    '  <div class="aq-row"><span>阶段</span><b data-aq="phase">空闲</b></div>',
    '  <div class="aq-grid">',
    '    <div><span>可用</span><b data-aq="cash">—</b></div>',
    '    <div><span>浮盈</span><b data-aq="float">—</b></div>',
    '    <div><span>凯利</span><b data-aq="kelly">—</b></div>',
    '  </div>',
    '  <div class="aq-actions">',
    '    <button class="aq-btn" data-aq="auto">自动 关</button>',
    '    <button class="aq-btn" data-aq="closeall">全平</button>',
    '  </div>',
    '  <div class="aq-pos" data-aq="pos">无持仓</div>',
    '  <div class="aq-log" data-aq="log"></div>',
    '</div>',
  ].join('');

  const CSS = [
    '#aq-panel{position:fixed;right:16px;top:80px;width:258px;z-index:99999;',
    'background:rgba(18,26,24,.94);color:#d8e4e0;border:1px solid rgba(120,200,180,.25);',
    'border-radius:10px;font:12px/1.5 system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.45);user-select:none}',
    '#aq-panel .aq-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid rgba(120,200,180,.15)}',
    '#aq-panel .aq-dot{width:8px;height:8px;border-radius:50%;background:#4a5;flex:0 0 auto}',
    '#aq-panel .aq-dot.warn{background:#eb4}',
    '#aq-panel .aq-dot.err{background:#e55}',
    '#aq-panel .aq-head b{flex:1;font-size:12px}',
    '#aq-panel .aq-body{padding:8px 10px;display:flex;flex-direction:column;gap:6px}',
    '#aq-panel.aq-fold .aq-body{display:none}',
    '#aq-panel .aq-row{display:flex;justify-content:space-between;gap:8px}',
    '#aq-panel .aq-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:4px}',
    '#aq-panel .aq-grid div{background:rgba(255,255,255,.04);border-radius:6px;padding:4px}',
    '#aq-panel .aq-grid span{display:block;opacity:.6;font-size:10px}',
    '#aq-panel .aq-grid b{font-size:11px}',
    '#aq-panel .aq-actions{display:flex;gap:4px}',
    '#aq-panel .aq-btn{flex:1;background:rgba(120,200,180,.12);color:#cfe;border:1px solid rgba(120,200,180,.25);',
    'border-radius:6px;padding:4px 6px;font-size:11px;cursor:pointer}',
    '#aq-panel .aq-btn.on{background:rgba(90,220,150,.3);border-color:rgba(90,220,150,.6)}',
    '#aq-panel .aq-pos{font-size:11px;opacity:.85}',
    '#aq-panel .aq-log{font-size:10px;opacity:.7;max-height:110px;overflow:auto;line-height:1.45}',
    // 移动端：贴底 + 安全区 + 高度上限，避免遮挡游戏底部按钮
    '@media (max-width:' + MOBILE_BREAKPOINT + 'px){',
    '#aq-panel{right:8px;left:8px;top:auto;bottom:calc(8px + env(safe-area-inset-bottom,0px));width:auto;',
    'max-height:calc(100dvh - 24px);display:flex;flex-direction:column}',
    '#aq-panel .aq-body{overflow:auto}',
    '}',
  ].join('');

  const mobileQuery = PAGE.matchMedia ? PAGE.matchMedia('(max-width:' + MOBILE_BREAKPOINT + 'px)') : null;
  const isMobile = () => (mobileQuery ? mobileQuery.matches : PAGE.innerWidth <= MOBILE_BREAKPOINT);

  function mount() {
    if (ui.refs) return;
    if (!document.body || !document.head) { setTimeout(mount, 100); return; }
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    const root = document.createElement('div');
    root.id = 'aq-panel';
    root.innerHTML = HTML;
    document.body.appendChild(root);
    const q = k => root.querySelector('[data-aq="' + k + '"]');
    ui.refs = {
      root,
      dot: q('dot'), conn: q('conn'), equity: q('equity'), phase: q('phase'),
      cash: q('cash'), float: q('float'), kelly: q('kelly'), pos: q('pos'), log: q('log'),
    };
    const syncFoldBtn = () => { q('fold').textContent = root.classList.contains('aq-fold') ? '+' : '—'; };
    q('fold').onclick = () => {
      const folded = root.classList.toggle('aq-fold');
      try { localStorage.setItem(FOLD_KEY, folded ? '1' : '0'); } catch {}
      syncFoldBtn();
      render();
    };
    syncFoldBtn();
    let folded = null;
    try { folded = localStorage.getItem(FOLD_KEY); } catch {}
    // 移动端首次访问默认折叠（只留标题条），用户手动展开后记住选择
    if (folded === '1' || (folded === null && isMobile())) root.classList.add('aq-fold');
    q('auto').onclick = () => {
      ui.auto = !ui.auto;
      q('auto').classList.toggle('on', ui.auto);
      q('auto').textContent = '自动 ' + (ui.auto ? '开' : '关');
      pushLog('做市 ' + (ui.auto ? '开启' : '关闭'));
      render();
    };
    q('closeall').onclick = async () => {
      const snap = conn.snap;
      if (!snap) return;
      await cancelOrder();
      for (const p of (snap.account.positions || [])) await closeMarket(p, '手动');
      reset();
    };
    render();
  }

  function prependLogLine(line) {
    const box = ui.refs && ui.refs.log;
    if (!box) return;
    const div = document.createElement('div');
    div.textContent = line;
    box.prepend(div);
    while (box.childElementCount > LOG_SHOW) box.lastElementChild.remove();
  }

  function render() {
    const r = ui.refs;
    if (!r) return;
    const snap = conn.snap;
    const acct = snap && snap.account;
    const pos = (acct && acct.positions) || [];
    if (r.root.classList.contains('aq-fold')) {
      const risk = pos.some(p => -p.pnl / p.margin >= STOP_RISK * 0.8);
      r.dot.className = 'aq-dot' + (risk ? ' err' : ui.auto ? ' warn' : '');
      return;
    }
    r.conn.textContent = snap ? '已联机' : '未连接';
    r.equity.textContent = acct ? '¥' + NF2.format(acct.equity) : '—';
    r.cash.textContent = acct ? '¥' + NF0.format(acct.available) : '—';
    r.float.textContent = acct ? (acct.floating >= 0 ? '+' : '') + NF0.format(acct.floating) : '—';
    r.kelly.textContent = (kelly() * 100).toFixed(0) + '%';
    r.phase.textContent = PHASE[mm.phase] || mm.phase;
    r.pos.textContent = pos.length
      ? pos.map(p => conn.nameOf(p.stock) + (p.side > 0 ? '多' : '空') + ' ' + p.qty + '股 ' + (p.pnl >= 0 ? '+' : '') + p.pnl.toFixed(1)).join(' | ')
      : '无持仓';
  }

  /* ================= 独立账户（测试用） ================= */
  let anonWs = null;
  let wsRetry = 0;
  let wsConnecting = false;
  let wsTimer = null;

  async function useAnonymous() {
    try {
      if (!conn.token) {
        const d = await post('session', {}, false);
        if (!d || !d.sessionToken) throw new Error('无 token');
        cacheToken(d.sessionToken);
        pushLog('独立账户 ' + ((d.account && d.account.nickname) || ''));
        bus.emit('data:snapshot', d);
      }
      connectAnonWs();
    } catch (e) { pushLog('独立账户失败: ' + e.message); }
  }

  function connectAnonWs() {
    if (wsConnecting) return;
    wsConnecting = true;
    clearTimeout(wsTimer);
    if (anonWs) { try { anonWs.close(); } catch {} anonWs = null; }
    let ws;
    try {
      const base = new URL(PAGE.A_SHARE_BACKEND_URL || BACKEND);
      const wsUrl = new URL('ws', base);
      wsUrl.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(wsUrl);
    } catch (e) {
      wsConnecting = false;
      pushLog('行情连接失败: ' + e.message);
      return;
    }
    anonWs = ws;
    ws.onopen = () => {
      wsConnecting = false;
      wsRetry = 0;
      ws.send(JSON.stringify({ sessionToken: conn.token }));
    };
    ws.onmessage = ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m && m.type === 'snapshot') bus.emit('data:snapshot', m);
    };
    ws.onclose = () => {
      if (anonWs !== ws) return;   // 已被新连接取代，旧连接的 onclose 不应再触发重连
      anonWs = null;
      wsConnecting = false;
      const baseDelay = Math.min(WS_RETRY_MAX, WS_RETRY_BASE * 2 ** wsRetry);
      wsRetry = Math.min(wsRetry + 1, 6);
      const jitter = baseDelay * WS_RETRY_JITTER * (Math.random() * 2 - 1);
      clearTimeout(wsTimer);
      wsTimer = setTimeout(connectAnonWs, baseDelay + jitter);
    };
    ws.onerror = () => {};
  }

  /* ================= 自建 WS（不依赖游戏 socket） ================= */
  async function bootstrap() {
    for (let i = 0; i < 40 && !conn.token; i++) await new Promise(r => setTimeout(r, 500));
    if (!conn.token) await ensureToken();
    if (!conn.token) { pushLog('无 token：请确认已登录 B 站并进入游戏'); return; }
    pushLog('token 就绪，连接行情');
    connectAnonWs();
  }

  /* ================= 启动 ================= */
  initBridge();
  document.addEventListener('visibilitychange', onVisibilityChange);
  setTimeout(bootstrap, 1500);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else setTimeout(mount, 0);
  if (/[?&]aq_anon=1/.test(location.search)) setTimeout(useAnonymous, 800);

  window.__AQ__ = { conn, mm, ui, stats, bus, kelly, step, pickPair, useAnonymous, ensureToken, PAGE, planIdle, planBidding, planAsking, planClosing, refPrice, inBand, LIMIT_BAND, shiftTimers, cacheToken, cloud };
})();
