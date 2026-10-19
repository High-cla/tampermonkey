// ==UserScript==
// @name         大A 简单! · 做市量化台
// @namespace    fx-quant/a-share
// @version      3.0.0
// @description  限价做市引擎：bid0+1tick 买入 / ask0-1tick 卖出，赚 spread；凯利定仓 + 限价止损 + 增量渲染
// @match        https://www.bilibili.com/toy/suoha/*
// @match        https://www.bilibilitoy.com/toy/suoha/*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  'use strict';
  if (window.__ASHARE_QUANT__) return;
  if (!location.hostname.endsWith('bilibilitoy.com')) return;
  window.__ASHARE_QUANT__ = true;

  /* ================= 常量 ================= */
  const WAIT_MS = 25000;          // 挂单存活期
  const GRACE_MS = 4000;          // 挂单后快照未回显的宽限
  const WATCHDOG_MS = 15000;      // 单次 step 的硬上限（AbortController）
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
  const REQ_TIMEOUT_MS = 8000;
  const CFG_KEY = 'ashare-mm-config-v1';
  const FOLD_KEY = 'ashare-mm-fold';
  const BACKEND = 'https://8.134.122.85/a-share/';

  const PHASE = { idle: '空闲', bidding: '挂买中', asking: '挂卖中', closing: '平仓中' };

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

  const stats = { history: [], lastTradeAt: 0 };

  const ui = { auto: false, logs: [], refs: null };

  const cfg = (() => {
    const def = { lev: 5, margin: 500 };
    try { return { ...def, ...JSON.parse(localStorage.getItem(CFG_KEY) || '{}') }; } catch { return def; }
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
  function initBridge() {
    const Orig = window.WebSocket;
    if (!Orig) return;
    function Patched(url, protocols) {
      const ws = protocols === undefined ? new Orig(url) : new Orig(url, protocols);
      try {
        const send = ws.send.bind(ws);
        ws.send = data => {
          if (!conn.token) {
            try {
              const m = JSON.parse(data);
              if (m && typeof m.sessionToken === 'string' && m.sessionToken) conn.token = m.sessionToken;
            } catch {}
          }
          return send(data);
        };
        ws.addEventListener('message', ev => {
          let d;
          try { d = JSON.parse(ev.data); } catch { return; }
          if (d && d.type === 'snapshot') bus.emit('data:snapshot', d);
        });
      } catch {}
      return ws;
    }
    Patched.prototype = Orig.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Patched[k] = Orig[k];
    window.WebSocket = Patched;
  }

  let inflight = null;

  async function post(path, body = {}, auth = true) {
    const base = new URL(window.A_SHARE_BACKEND_URL || BACKEND);
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

  function planIdle(snap) {
    const pos = firstPos(snap);
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
    const bk = snap.orderBooks[pair];
    const bid = bk && bk.bids && bk.bids[0];
    if (!bid) return reset();
    const price = round2(bid.price + conn.tickOf(pair));
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
    const bk = snap.orderBooks[pos.stock];
    const ask = bk && bk.asks && bk.asks[0];
    if (!ask) return reset();
    const price = round2(ask.price - conn.tickOf(pos.stock));
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
    const bk = snap.orderBooks[pos.stock];
    const bid = bk && bk.bids && bk.bids[0];
    if (!bid) return closeMarket(pos, why);
    const price = round2(bid.price);
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
  ].join('');

  function mount() {
    if (ui.refs || !document.body || !document.head) return;
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
    q('fold').onclick = () => {
      const folded = root.classList.toggle('aq-fold');
      try { localStorage.setItem(FOLD_KEY, folded ? '1' : '0'); } catch {}
    };
    try { if (localStorage.getItem(FOLD_KEY) === '1') root.classList.add('aq-fold'); } catch {}
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

  async function useAnonymous() {
    try {
      if (!conn.token) {
        const d = await post('session', {}, false);
        if (!d || !d.sessionToken) throw new Error('无 token');
        conn.token = d.sessionToken;
        pushLog('独立账户 ' + ((d.account && d.account.nickname) || ''));
        bus.emit('data:snapshot', d);
      }
      connectAnonWs();
    } catch (e) { pushLog('独立账户失败: ' + e.message); }
  }

  function connectAnonWs() {
    if (anonWs) { try { anonWs.close(); } catch {} }
    const base = new URL(window.A_SHARE_BACKEND_URL || BACKEND);
    const wsUrl = new URL('ws', base);
    wsUrl.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(wsUrl);
    anonWs = ws;
    ws.onopen = () => ws.send(JSON.stringify({ sessionToken: conn.token }));
    ws.onmessage = ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m && m.type === 'snapshot') bus.emit('data:snapshot', m);
    };
    ws.onclose = () => setTimeout(connectAnonWs, 3000);
    ws.onerror = () => {};
  }

  /* ================= 启动 ================= */
  initBridge();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else setTimeout(mount, 0);
  if (/[?&]aq_anon=1/.test(location.search)) setTimeout(useAnonymous, 800);

  window.__AQ__ = { conn, mm, ui, stats, bus, kelly, step, pickPair, useAnonymous, planIdle, planBidding, planAsking, planClosing };
})();
