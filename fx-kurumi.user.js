// ==UserScript==
// @name         FX Kurumi Quant
// @namespace    fxkq
// @version      0.3.0
// @description  久留美模拟器：风控执行 / 指标过滤 / 配对套利
// @author       local
// @match        https://www.bilibilitoy.com/toy/fx-kurumi/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(() => {
    'use strict';
    const VERSION = '0.3.0';
    /* ───────── 事件契约（冻结） ───────── */
    const EV = Object.freeze({
        BRIDGE_READY: 'bridge:ready',
        BRIDGE_STATE: 'bridge:state',
        BRIDGE_LOST: 'bridge:lost',
        CONFIG: 'config:changed',
        QUOTES: 'feed:quotes',
        RISK: 'risk:update',
        ORDER: 'exec:order',
        LOG: 'core:log',
    });
    /* ───────── 游戏常量（app 源码 te / Vi） ───────── */
    const GAME = Object.freeze({
        USD_JPY: 150, USD_HKD: 7.8,
        RENT_JPY: 35000, FOOD_JPY: 15000,
        MINUTES_PER_DAY: 1440, SETTLE_DAYS: 7,
        LIQ_RATIO: 0.9, LIQ_REFUND: 0.1,
    });
    const RENT_TOTAL = GAME.RENT_JPY + GAME.FOOD_JPY;
    const JPY_PER_HKD = GAME.USD_JPY / GAME.USD_HKD;
    /* ───────── 调优常量（唯一来源） ───────── */
    const TUNING = Object.freeze({
        schedTickMs: 250,
        harvestMs: 1000,
        healthMs: 1000,
        strategyMs: 4000,
        pairScanMs: 12000,
        firstPushDelayMs: 1200,
        healthTimeoutMs: 8000,
        maxFibers: 300000,
        maxHooks: 400,
        maxFiberDepth: 10000,
        maxQuoteSymbols: 40,
        bucketMs: 5000,
        maxTicks: 4000,
        maxBuckets: 720,
        tickDedupeMs: 400,
        logThrottleMs: 10000,
        logRingMax: 120,
        logPanelLines: 3,
        spreadWindow: 240,
        pairWarmupMin: 8,
        signalMinTicks: 60,
        signalFastN: 8,
        signalSlowN: 34,
        signalRsiN: 14,
        signalAtrN: 14,
        signalTrendN: 60,
        signalMinTrend: 0.35,
        signalMaxVol: 0.02,
        signalRsiHigh: 72,
        signalRsiLow: 28,
        signalMaxEntries: 2,
    });
    /* ───────── 配置 ───────── */
    const CFG_KEY = 'fxkq:config:v3';
    const DEFAULTS = Object.freeze({
        auto: true, pairs: true, directional: false,
        leverage: 10, maxMarginPct: 0.02, maxGrossMult: 3, maxPositions: 4,
        minLiqDist: 0.45, maxDailyLossPct: 0.08, maxConsecLoss: 3,
        rentBufferDays: 1, cooldownMs: 15000, panelOpen: true,
        zEntry: 2, zExit: 0.5, minCorr: 0.6, warmupBuckets: 24,
    });
    /* ───────── 总线 ───────── */
    function createBus() {
        const map = new Map();
        let depth = 0;
        return {
            on(ev, fn) {
                let s = map.get(ev);
                if (!s) {
                    s = new Set();
                    map.set(ev, s);
                }
                s.add(fn);
                return () => { s.delete(fn); };
            },
            emit(ev, payload) {
                if (depth > 8)
                    return;
                const s = map.get(ev);
                if (!s)
                    return;
                depth++;
                try {
                    for (const fn of Array.from(s)) {
                        try {
                            fn(payload);
                        }
                        catch { /* 订阅者隔离 */ }
                    }
                }
                finally {
                    depth--;
                }
            },
        };
    }
    /* ───────── 日志（节流 + 计数） ───────── */
    function createLog(bus) {
        const ring = [];
        const lastAt = new Map();
        const pending = new Map();
        function push(key, msg) {
            const now = Date.now();
            const prev = lastAt.get(key);
            if (prev !== undefined && now - prev < TUNING.logThrottleMs) {
                pending.set(key, (pending.get(key) ?? 0) + 1);
                return;
            }
            const skipped = pending.get(key) ?? 0;
            pending.delete(key);
            lastAt.set(key, now);
            const suffix = skipped > 0 ? ' ×' + (skipped + 1) : '';
            ring.push(new Date(now).toISOString().slice(11, 19) + ' ' + msg + suffix);
            if (ring.length > TUNING.logRingMax)
                ring.shift();
            bus.emit(EV.LOG, msg);
        }
        return { push, tail: (n) => ring.slice(-n) };
    }
    /* ───────── 单调度器（相位分频） ───────── */
    function createScheduler(tickMs) {
        const jobs = [];
        let handle = null;
        return {
            every(ms, fn) {
                jobs.push({ every: Math.max(1, Math.round(ms / tickMs)), fn, n: 0 });
            },
            start() {
                if (handle)
                    return;
                handle = setInterval(() => {
                    for (const j of jobs) {
                        if (++j.n < j.every)
                            continue;
                        j.n = 0;
                        try {
                            j.fn();
                        }
                        catch { /* 作业隔离 */ }
                    }
                }, tickMs);
            },
            stop() { if (handle) {
                clearInterval(handle);
                handle = null;
            } },
        };
    }
    /* MATH:BEGIN —— 纯函数，自包含（不引用块外符号），backtest.mts 直接切片复用 */
    const MIN_SPREAD_LEN = 8;
    function mean(v) { if (!v.length)
        return 0; let s = 0; for (const x of v)
        s += x; return s / v.length; }
    function stdev(v) {
        if (v.length < 2)
            return 0;
        const m = mean(v);
        let s = 0;
        for (const x of v) {
            const d = x - m;
            s += d * d;
        }
        return Math.sqrt(s / (v.length - 1));
    }
    function ema(v, n) {
        if (!v.length || n <= 0)
            return 0;
        const k = 2 / (n + 1);
        let e = v[0];
        for (let i = 1; i < v.length; i++)
            e = v[i] * k + e * (1 - k);
        return e;
    }
    function rsi(v, n) {
        if (v.length < n + 1)
            return 50;
        let gain = 0, loss = 0;
        for (let i = v.length - n; i < v.length; i++) {
            const d = v[i] - v[i - 1];
            if (d >= 0)
                gain += d;
            else
                loss -= d;
        }
        if (gain + loss === 0)
            return 50;
        return (gain / (gain + loss)) * 100;
    }
    /** 无 OHLC 时的 ATR 代理：|Δp|/p 的 EMA */
    function atrPct(v, n) {
        if (v.length < 2)
            return 0;
        const d = [];
        for (let i = 1; i < v.length; i++)
            d.push(Math.abs(v[i] - v[i - 1]) / Math.max(v[i - 1], 1e-12));
        return ema(d.slice(-Math.max(n, 2)), n);
    }
    /** ADX 代理：|净位移| / 总行程，0=纯震荡 1=单边 */
    function trendiness(v, n) {
        if (v.length < n + 1)
            return 0;
        const seg = v.slice(-(n + 1));
        let path = 0;
        for (let i = 1; i < seg.length; i++)
            path += Math.abs(seg[i] - seg[i - 1]);
        const net = Math.abs(seg[seg.length - 1] - seg[0]);
        return path > 0 ? net / path : 0;
    }
    function correlation(a, b) {
        const n = Math.min(a.length, b.length);
        if (n < 3)
            return 0;
        const x = a.slice(-n), y = b.slice(-n);
        const mx = mean(x), my = mean(y);
        let sxy = 0, sxx = 0, syy = 0;
        for (let i = 0; i < n; i++) {
            const dx = x[i] - mx, dy = y[i] - my;
            sxy += dx * dy;
            sxx += dx * dx;
            syy += dy * dy;
        }
        if (sxx < 1e-12 || syy < 1e-12)
            return 0;
        return sxy / Math.sqrt(sxx * syy);
    }
    /** 对数价差回归：spread = ln(a) - (alpha + beta*ln(b))，返回 beta 与当前 z */
    function spreadZ(a, b, n) {
        const len = Math.min(a.length, b.length, n);
        if (len < MIN_SPREAD_LEN)
            return { beta: 0, z: 0, sd: 0 };
        const x = [], y = [];
        for (let i = a.length - len; i < a.length; i++)
            y.push(Math.log(Math.max(a[i], 1e-12)));
        for (let i = b.length - len; i < b.length; i++)
            x.push(Math.log(Math.max(b[i], 1e-12)));
        const mx = mean(x), my = mean(y);
        let sxy = 0, sxx = 0;
        for (let i = 0; i < len; i++) {
            const dx = x[i] - mx;
            sxy += dx * (y[i] - my);
            sxx += dx * dx;
        }
        const beta = sxx > 1e-12 ? sxy / sxx : 0;
        const alpha = my - beta * mx;
        const spread = [];
        for (let i = 0; i < len; i++)
            spread.push(y[i] - (alpha + beta * x[i]));
        const sd = stdev(spread);
        if (sd < 1e-12)
            return { beta, z: 0, sd: 0 };
        return { beta, z: spread[spread.length - 1] / sd, sd };
    }
    /* MATH:END */
    /* ───────── fiber 原语（纯函数，无闭包状态） ───────── */
    function findRootFiber(doc) {
        const rootEl = doc.getElementById('root');
        if (!rootEl)
            return null;
        const el = (rootEl.firstElementChild || rootEl);
        const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$'));
        if (!key)
            return null;
        let f = el[key];
        let depth = 0;
        while (f && f.return && depth++ < TUNING.maxFiberDepth)
            f = f.return;
        return f;
    }
    function walkFibers(root, visit) {
        if (!root)
            return;
        const seen = new Set();
        const stack = [root];
        let n = 0;
        while (stack.length && n < TUNING.maxFibers) {
            const f = stack.pop();
            n++;
            if (!f || seen.has(f))
                continue;
            seen.add(f);
            if (visit(f))
                return;
            if (f.child)
                stack.push(f.child);
            if (f.sibling)
                stack.push(f.sibling);
        }
    }
    function eachHook(fiber, visit) {
        let hook = fiber.memoizedState;
        let n = 0;
        while (hook && n++ < TUNING.maxHooks) {
            if (visit(hook))
                return true;
            hook = hook.next;
        }
        return false;
    }
    /** 识别 zustand subscribe：deps 长度为 1 的函数，调用后返回 unsubscribe。tried 保证每个候选只试一次 */
    function detectSubscribe(root, tried) {
        let found = null;
        walkFibers(root, (fiber) => eachHook(fiber, (hook) => {
            const memo = hook.memoizedState;
            const deps = hook.deps ?? (memo && memo.deps);
            if (!Array.isArray(deps) || deps.length !== 1 || typeof deps[0] !== 'function')
                return false;
            const cand = deps[0];
            if (tried.has(cand))
                return false;
            tried.add(cand);
            try {
                const off = cand(() => { });
                if (typeof off !== 'function')
                    return false;
                off();
                found = cand;
                return true;
            }
            catch {
                return false;
            }
        }));
        return found;
    }
    /** 从任意 hook 的 memoizedState 里找 {symbol: {mid,...}} 形态的行情表 */
    function harvestQuoteMap(root) {
        let out = null;
        walkFibers(root, (fiber) => eachHook(fiber, (hook) => {
            const v = hook.memoizedState;
            if (!v || typeof v !== 'object' || Array.isArray(v))
                return false;
            const keys = Object.keys(v);
            if (keys.length < 2 || keys.length > TUNING.maxQuoteSymbols)
                return false;
            const first = v[keys[0]];
            if (!first || typeof first !== 'object' || typeof first.mid !== 'number')
                return false;
            const map = {};
            for (const k of keys) {
                const q = v[k];
                if (!q || typeof q !== 'object' || typeof q.mid !== 'number')
                    return false;
                map[k] = {
                    symbol: String(q.symbol ?? k), market: String(q.market ?? ''),
                    bid: Number(q.bid ?? 0), ask: Number(q.ask ?? 0), mid: Number(q.mid),
                    ts: String(q.ts ?? ''), stale: !!q.stale, source: String(q.source ?? ''),
                };
            }
            out = map;
            return true;
        }));
        return out;
    }
    /** 兜底：调用 setNotice 触发一次 setState，让订阅者拿到首帧 */
    function forceFirstPush(root) {
        let done = false;
        walkFibers(root, (fiber) => eachHook(fiber, (hook) => {
            const queue = hook.queue;
            if (!queue || typeof queue.getSnapshot !== 'function')
                return false;
            try {
                const snap = queue.getSnapshot();
                if (typeof snap === 'function' && snap.name === 'setNotice') {
                    snap(null);
                    done = true;
                    return true;
                }
            }
            catch { /* 非目标 */ }
            return false;
        }));
        return done;
    }
    /* ───────── 桥（只负责生命周期） ───────── */
    function createBridge(doc, bus, log) {
        let unsubscribe = null;
        let state = null;
        let lastPush = 0;
        let quotes = {};
        const tried = new WeakSet();
        function connect() {
            if (unsubscribe)
                return;
            const sub = detectSubscribe(findRootFiber(doc), tried);
            if (!sub)
                return;
            unsubscribe = sub((next) => {
                state = next;
                lastPush = Date.now();
                bus.emit(EV.BRIDGE_STATE, next);
            });
            log.push('bridge', '通道已连接');
            setTimeout(() => { if (!state)
                forceFirstPush(findRootFiber(doc)); }, TUNING.firstPushDelayMs);
        }
        function disconnect() {
            try {
                unsubscribe?.();
            }
            catch { /* ignore */ }
            unsubscribe = null;
            state = null;
            bus.emit(EV.BRIDGE_LOST);
        }
        function health() {
            if (!unsubscribe) {
                connect();
                return;
            }
            if (Date.now() - lastPush <= TUNING.healthTimeoutMs)
                return;
            log.push('bridge', '心跳超时，重连');
            disconnect();
        }
        function harvest() {
            const map = harvestQuoteMap(findRootFiber(doc));
            if (!map)
                return;
            quotes = map;
            bus.emit(EV.QUOTES, map);
        }
        return {
            connect, disconnect, health, harvest,
            get state() { return state; },
            get quotes() { return quotes; },
            get ready() { return state !== null; },
        };
    }
    /* ───────── 配置 ───────── */
    function createConfig(bus) {
        let cfg = { ...DEFAULTS };
        try {
            const raw = localStorage.getItem(CFG_KEY);
            if (raw)
                cfg = { ...DEFAULTS, ...JSON.parse(raw) };
        }
        catch { /* 损坏回落默认 */ }
        return {
            get() { return cfg; },
            set(patch) {
                cfg = { ...cfg, ...patch };
                try {
                    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
                }
                catch { /* 配额 */ }
                bus.emit(EV.CONFIG, cfg);
            },
        };
    }
    /* ───────── 序列 ───────── */
    function createSeries() {
        const ticks = new Map();
        const buckets = new Map();
        function push(symbol, price, now) {
            if (!symbol || !Number.isFinite(price) || price <= 0)
                return;
            let arr = ticks.get(symbol);
            if (!arr) {
                arr = [];
                ticks.set(symbol, arr);
            }
            const last = arr[arr.length - 1];
            if (last && now - last.t < TUNING.tickDedupeMs) {
                last.p = price;
                last.t = now;
            }
            else {
                arr.push({ t: now, p: price });
                if (arr.length > TUNING.maxTicks)
                    arr.shift();
            }
            let bm = buckets.get(symbol);
            if (!bm) {
                bm = new Map();
                buckets.set(symbol, bm);
            }
            bm.set(Math.floor(now / TUNING.bucketMs), price);
            if (bm.size > TUNING.maxBuckets)
                bm.delete(bm.keys().next().value);
        }
        function prices(symbol) {
            const arr = ticks.get(symbol);
            if (!arr)
                return [];
            const out = new Array(arr.length);
            for (let i = 0; i < arr.length; i++)
                out[i] = arr[i].p;
            return out;
        }
        /** 两标的分桶对齐（同 bucket 索引） */
        function aligned(a, b) {
            const ba = buckets.get(a), bb = buckets.get(b);
            if (!ba || !bb)
                return { a: [], b: [], n: 0 };
            const keys = [];
            for (const k of ba.keys())
                if (bb.has(k))
                    keys.push(k);
            keys.sort((x, y) => x - y);
            const outA = new Array(keys.length);
            const outB = new Array(keys.length);
            for (let i = 0; i < keys.length; i++) {
                outA[i] = ba.get(keys[i]);
                outB[i] = bb.get(keys[i]);
            }
            return { a: outA, b: outB, n: keys.length };
        }
        return { push, prices, aligned };
    }
    /* ───────── 行情 → 序列（事件驱动） ───────── */
    function createFeed(bridge, series, bus) {
        let quotes = {};
        function onQuotes() {
            const now = Date.now();
            const next = {};
            for (const [sym, q] of Object.entries(bridge.quotes)) {
                if (!q || q.stale || !Number.isFinite(q.mid) || q.mid <= 0)
                    continue;
                next[sym] = q.mid;
                series.push(sym, q.mid, now);
            }
            quotes = next;
        }
        bus.on(EV.QUOTES, onQuotes);
        return {
            price(symbol) { return quotes[symbol] ?? 0; },
            all() { return quotes; },
        };
    }
    /* ───────── 风控 ───────── */
    function pnlOf(p, price) {
        return (p.side === 'long' ? price - p.avgCost : p.avgCost - price) * p.qty;
    }
    function riskRatio(p, price) { return -pnlOf(p, price) / Math.max(p.margin, 1e-9); }
    function toJpy(amount, currency) {
        if (currency === 'JPY')
            return amount;
        if (currency === 'USD')
            return amount * GAME.USD_JPY;
        if (currency === 'HKD')
            return amount * JPY_PER_HKD;
        return 0;
    }
    const EMPTY_RISK = Object.freeze({
        equityJpy: 0, cashJpy: 0, grossJpy: 0, ccyJpy: Object.freeze({}),
        rows: Object.freeze([]), daysToRent: 0, rentShortJpy: 0, tripped: Object.freeze([]),
    });
    function createRisk(bridge, feed, cfg, bus) {
        let startEquity = 0;
        let consecLoss = 0;
        let tripped = new Set();
        let cache = null;
        let dirty = true;
        bus.on(EV.BRIDGE_STATE, () => { dirty = true; });
        bus.on(EV.QUOTES, () => { dirty = true; });
        function compute() {
            const s = bridge.state;
            if (!s)
                return EMPTY_RISK;
            const cashJpy = toJpy(s.cash.USD ?? 0, 'USD') + toJpy(s.cash.HKD ?? 0, 'HKD') + toJpy(s.cash.JPY ?? 0, 'JPY');
            let grossJpy = 0;
            let equity = cashJpy;
            const ccyJpy = {};
            const rows = [];
            for (const p of Object.values(s.positions)) {
                const price = feed.price(p.symbol) || p.avgCost;
                const pnl = pnlOf(p, price);
                const jpy = toJpy(Math.abs(p.qty * price), p.currency);
                grossJpy += jpy;
                ccyJpy[p.currency] = (ccyJpy[p.currency] ?? 0) + jpy;
                rows.push({ symbol: p.symbol, side: p.side, margin: p.margin, pnl, liqDist: GAME.LIQ_RATIO - riskRatio(p, price), price });
                equity += toJpy(Math.max(0, p.margin + pnl), p.currency);
            }
            for (const pd of s.pending ?? [])
                equity += toJpy(pd.amount, pd.currency);
            const minutesLeft = Math.max(0, (s.nextSettleMinute ?? 0) - (s.gameMinutes ?? 0));
            return {
                equityJpy: equity, cashJpy, grossJpy, ccyJpy, rows,
                daysToRent: minutesLeft / GAME.MINUTES_PER_DAY,
                rentShortJpy: Math.max(0, RENT_TOTAL - (s.cash.JPY ?? 0)),
                tripped: Array.from(tripped),
            };
        }
        function check() {
            if (!bridge.state)
                return;
            const r = compute();
            if (startEquity === 0 && r.equityJpy > 0)
                startEquity = r.equityJpy;
            const c = cfg.get();
            const next = new Set();
            for (const row of r.rows)
                if (row.liqDist < c.minLiqDist)
                    next.add('LIQ:' + row.symbol);
            if (startEquity > 0 && (startEquity - r.equityJpy) / startEquity > c.maxDailyLossPct)
                next.add('DRAWDOWN');
            if (consecLoss >= c.maxConsecLoss)
                next.add('STREAK');
            if (r.daysToRent <= c.rentBufferDays && r.rentShortJpy > 0)
                next.add('RENT');
            tripped = next;
            dirty = true;
            bus.emit(EV.RISK, report());
        }
        function report() {
            if (cache && !dirty)
                return cache;
            cache = compute();
            dirty = false;
            return cache;
        }
        return {
            check, report,
            tripped() { return tripped; },
            noteLoss(won) { consecLoss = won ? 0 : consecLoss + 1; dirty = true; },
        };
    }
    /* ───────── 配对 ───────── */
    const PAIR_CANDIDATES = Object.freeze([
        { a: 'EURUSD', b: 'GBPUSD', market: 'FX', ccy: 'USD' },
        { a: 'EURUSD', b: 'USDJPY', market: 'FX', ccy: 'USD' },
        { a: 'AAPL', b: 'TSLA', market: 'US', ccy: 'USD' },
        { a: '00700.HK', b: '09988.HK', market: 'HK', ccy: 'HKD' },
    ]);
    /** 唯一计算入口：一轮只算一次 */
    function analyzePairs(series, cfg) {
        const c = cfg.get();
        const out = [];
        for (const p of PAIR_CANDIDATES) {
            const al = series.aligned(p.a, p.b);
            const key = p.a + '/' + p.b;
            if (al.n < c.warmupBuckets) {
                out.push({ key, a: p.a, b: p.b, market: p.market, ccy: p.ccy, z: 0, corr: 0, n: al.n });
                continue;
            }
            const sp = spreadZ(al.a, al.b, Math.min(al.n, TUNING.spreadWindow));
            out.push({ key, a: p.a, b: p.b, market: p.market, ccy: p.ccy, z: sp.z, corr: correlation(al.a, al.b), n: al.n });
        }
        return out;
    }
    function decidePairs(views, cfg) {
        const c = cfg.get();
        if (!c.pairs)
            return [];
        const out = [];
        for (const v of views) {
            if (v.n < c.warmupBuckets)
                continue;
            if (!Number.isFinite(v.corr) || v.corr < c.minCorr)
                continue;
            if (!Number.isFinite(v.z) || Math.abs(v.z) < c.zEntry)
                continue;
            const longA = v.z < 0;
            const why = 'pair ' + v.key + ' z=' + v.z.toFixed(2) + ' corr=' + v.corr.toFixed(2);
            out.push({ symbol: longA ? v.a : v.b, market: v.market, side: longA ? 'long' : 'short', currency: v.ccy, reason: why, score: Math.abs(v.z) });
            out.push({ symbol: longA ? v.b : v.a, market: v.market, side: longA ? 'short' : 'long', currency: v.ccy, reason: why, score: Math.abs(v.z) });
        }
        return out.sort((x, y) => y.score - x.score);
    }
    function pairExit(views, symbol, cfg) {
        const c = cfg.get();
        for (const v of views) {
            if (v.a !== symbol && v.b !== symbol)
                continue;
            if (v.n < c.warmupBuckets)
                return null;
            if (Math.abs(v.z) <= c.zExit)
                return 'pair 回归 z=' + v.z.toFixed(2);
            return null;
        }
        return null;
    }
    /* ───────── 方向性信号 ───────── */
    function decideSignal(series, symbols, cfg) {
        const c = cfg.get();
        if (!c.directional)
            return [];
        const out = [];
        for (const sym of symbols) {
            const px = series.prices(sym);
            if (px.length < TUNING.signalMinTicks)
                continue;
            const vol = atrPct(px, TUNING.signalAtrN);
            if (vol <= 0 || vol > TUNING.signalMaxVol)
                continue;
            const trend = trendiness(px, TUNING.signalTrendN);
            if (trend < TUNING.signalMinTrend)
                continue;
            const r = rsi(px, TUNING.signalRsiN);
            const up = ema(px.slice(-40), TUNING.signalFastN) > ema(px.slice(-120), TUNING.signalSlowN);
            if (up && r > TUNING.signalRsiHigh)
                continue;
            if (!up && r < TUNING.signalRsiLow)
                continue;
            const hk = sym.endsWith('.HK');
            out.push({
                symbol: sym, market: hk ? 'HK' : /^[A-Z]{6}$/.test(sym) ? 'FX' : 'US',
                side: up ? 'long' : 'short', currency: hk ? 'HKD' : 'USD',
                reason: 'trend ' + (up ? 'up' : 'down') + ' rsi=' + r.toFixed(0) + ' adx~' + trend.toFixed(2) + ' atr=' + (vol * 100).toFixed(2) + '%',
                score: trend,
            });
        }
        return out.sort((x, y) => y.score - x.score).slice(0, TUNING.signalMaxEntries);
    }
    function canOpen(ctx, d) {
        const s = ctx.bridge.state;
        if (!s)
            return 'no-state';
        if (!s.alive)
            return 'dead';
        const c = ctx.cfg.get();
        if (!c.auto)
            return 'auto-off';
        if (Date.now() - ctx.state.lastAction < c.cooldownMs)
            return 'cooldown';
        if (ctx.risk.tripped().size > 0)
            return 'tripped:' + Array.from(ctx.risk.tripped()).join(',');
        if (Object.keys(s.positions).length >= c.maxPositions)
            return 'max-positions';
        if (ctx.state.busy.has(d.symbol))
            return 'busy';
        const r = ctx.risk.report();
        if (r.grossJpy > (r.equityJpy || 1) * c.maxGrossMult)
            return 'gross-cap';
        if ((s.cash[d.currency] ?? 0) <= 0)
            return 'no-cash:' + d.currency;
        return null;
    }
    function doClose(ctx, symbol, why) {
        const s = ctx.bridge.state;
        if (!s)
            return false;
        const p = s.positions[symbol];
        if (!p)
            return false;
        const price = ctx.feed.price(symbol) || p.avgCost;
        ctx.state.busy.add(symbol);
        try {
            const pnl = pnlOf(p, price);
            s.closePosition({ symbol, qty: p.qty, price });
            ctx.state.lastAction = Date.now();
            ctx.risk.noteLoss(pnl >= 0);
            ctx.log.push('close:' + symbol, '平 ' + symbol + ' ' + (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + ' — ' + why);
            ctx.bus.emit(EV.ORDER, { kind: 'close', symbol, price, reason: why });
            return true;
        }
        catch (e) {
            ctx.log.push('close-fail:' + symbol, '平仓失败 ' + symbol + ': ' + String(e).slice(0, 60));
            return false;
        }
        finally {
            ctx.state.busy.delete(symbol);
        }
    }
    function doOpen(ctx, d) {
        const s = ctx.bridge.state;
        if (!s)
            return false;
        const blocked = canOpen(ctx, d);
        if (blocked) {
            ctx.log.push('reject:' + d.symbol, '拒单 ' + d.symbol + ': ' + blocked);
            return false;
        }
        const price = ctx.feed.price(d.symbol);
        if (!price || price <= 0)
            return false;
        const c = ctx.cfg.get();
        const r = ctx.risk.report();
        const rate = d.currency === 'JPY' ? 1 : d.currency === 'USD' ? GAME.USD_JPY : JPY_PER_HKD;
        const margin = Math.floor(((r.equityJpy || 0) * c.maxMarginPct / rate) * 100) / 100;
        if (margin <= 0 || (s.cash[d.currency] ?? 0) < margin)
            return false;
        ctx.state.busy.add(d.symbol);
        try {
            const ok = s.openPosition({ symbol: d.symbol, market: d.market, side: d.side, margin, leverage: c.leverage, price, currency: d.currency });
            if (!ok)
                return false;
            ctx.state.lastAction = Date.now();
            ctx.log.push('open:' + d.symbol, '开 ' + d.symbol + ' ' + d.side + ' m=' + margin + ' @' + price + ' — ' + d.reason);
            ctx.bus.emit(EV.ORDER, { kind: 'open', symbol: d.symbol, side: d.side, margin, price, reason: d.reason });
            return true;
        }
        catch (e) {
            ctx.log.push('open-fail:' + d.symbol, '开仓失败 ' + d.symbol + ': ' + String(e).slice(0, 60));
            return false;
        }
        finally {
            ctx.state.busy.delete(d.symbol);
        }
    }
    function runCycle(ctx, decisions, views) {
        const s = ctx.bridge.state;
        if (!s || !s.alive || !ctx.cfg.get().auto)
            return;
        const c = ctx.cfg.get();
        // 1) 爆仓守卫
        for (const p of Object.values(s.positions)) {
            const price = ctx.feed.price(p.symbol) || p.avgCost;
            const dist = GAME.LIQ_RATIO - riskRatio(p, price);
            if (dist < c.minLiqDist)
                doClose(ctx, p.symbol, '爆仓守卫 ' + dist.toFixed(2));
        }
        // 2) 配对回归离场
        for (const sym of Object.keys(s.positions)) {
            const why = pairExit(views, sym, ctx.cfg);
            if (why)
                doClose(ctx, sym, why);
        }
        // 3) 交租保护
        const r = ctx.risk.report();
        if (r.daysToRent <= c.rentBufferDays && r.rentShortJpy > 0 && typeof s.exchange === 'function') {
            const need = r.rentShortJpy / GAME.USD_JPY;
            if ((s.cash.USD ?? 0) > need) {
                try {
                    const res = s.exchange('USD', 'JPY', Math.ceil(need * 100) / 100);
                    if (res && res.ok)
                        ctx.log.push('rent-fx', '交租换汇 USD→JPY ' + need.toFixed(2));
                }
                catch (e) {
                    ctx.log.push('rent-fx-fail', '换汇失败: ' + String(e).slice(0, 60));
                }
            }
        }
        // 4) 入场
        const held = Object.keys(s.positions);
        for (const d of decisions) {
            if (held.length >= c.maxPositions)
                break;
            if (held.includes(d.symbol))
                continue;
            if (!doOpen(ctx, d))
                continue;
            held.push(d.symbol);
        }
    }
    function createExec(ctx) {
        return { runCycle: (d, v) => runCycle(ctx, d, v), doOpen: (d) => doOpen(ctx, d), doClose: (s, w) => doClose(ctx, s, w), canOpen: (d) => canOpen(ctx, d) };
    }
    const UI_CSS = [
        ':host{all:initial}',
        '.p{position:fixed;top:10px;right:10px;z-index:2147483000;width:284px;font:12px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#e7edf5;background:rgba(14,18,26,.94);border:1px solid rgba(120,150,190,.28);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.55);backdrop-filter:blur(10px);overflow:hidden;user-select:none}',
        '.h{display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:move;background:linear-gradient(180deg,rgba(40,52,72,.9),rgba(24,32,45,.9));border-bottom:1px solid rgba(120,150,190,.18)}',
        '.h b{font-size:12px;letter-spacing:.3px;flex:1}',
        '.dot{width:7px;height:7px;border-radius:50%;background:#e05561}.dot.on{background:#38c172;box-shadow:0 0 6px #38c172}',
        '.x{cursor:pointer;opacity:.6;padding:0 3px;font-size:14px;line-height:1}',
        '.b{padding:8px 10px;display:none;max-height:56vh;overflow:auto}.b.open{display:block}',
        '.row{display:flex;justify-content:space-between;gap:8px;padding:2px 0}',
        '.k{opacity:.62}.v{font-variant-numeric:tabular-nums;font-weight:600}',
        '.sep{height:1px;background:rgba(120,150,190,.16);margin:6px 0}',
        '.pos{padding:4px 6px;margin:3px 0;border-radius:6px;background:rgba(255,255,255,.04);font-size:11px}',
        '.pos .t{display:flex;justify-content:space-between}',
        '.bar{height:3px;border-radius:2px;background:rgba(255,255,255,.1);margin-top:3px;overflow:hidden}',
        '.bar i{display:block;height:100%;background:#38c172}',
        '.warn{color:#f0a020}.bad{color:#e05561}.ok{color:#38c172}',
        '.btn{flex:1;padding:5px 0;text-align:center;border-radius:6px;cursor:pointer;background:rgba(255,255,255,.08);border:1px solid rgba(120,150,190,.2);font-size:11px}',
        '.btn.on{background:rgba(56,193,114,.22);border-color:rgba(56,193,114,.5);color:#9df0be}',
        '.btns{display:flex;gap:6px;margin-top:6px}',
        '.log{margin-top:6px;font:10px/1.4 ui-monospace,monospace;opacity:.6;max-height:48px;overflow:auto;white-space:pre-wrap}',
    ].join('');
    function createUi(ctx) {
        const { doc, bridge, risk, feed, cfg, bus, log, exec } = ctx;
        let root = null;
        let raf = 0;
        const el = {};
        const money = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
        function requestRender() {
            if (raf)
                return;
            if (typeof requestAnimationFrame !== 'function') {
                render();
                return;
            }
            raf = requestAnimationFrame(() => { raf = 0; render(); });
        }
        function build() {
            const host = doc.createElement('div');
            host.id = 'fxkq-host';
            root = host.attachShadow({ mode: 'open' });
            const style = doc.createElement('style');
            style.textContent = UI_CSS;
            const p = doc.createElement('div');
            p.className = 'p';
            p.innerHTML =
                '<div class="h"><span class="dot" data-k="dot"></span><b>FXKQ ' + VERSION + '</b><span class="x" data-k="toggle">▾</span></div>' +
                    '<div class="b open" data-k="body">' +
                    '<div class="row"><span class="k">权益(JPY)</span><span class="v" data-k="equity">-</span></div>' +
                    '<div class="row"><span class="k">现金</span><span class="v" data-k="cash">-</span></div>' +
                    '<div class="row"><span class="k">总敞口</span><span class="v" data-k="gross">-</span></div>' +
                    '<div class="row"><span class="k">距交租</span><span class="v" data-k="rent">-</span></div>' +
                    '<div class="sep"></div><div data-k="positions"></div>' +
                    '<div class="sep"></div>' +
                    '<div class="row"><span class="k">配对</span><span class="v" data-k="pairs">-</span></div>' +
                    '<div class="row"><span class="k">状态</span><span class="v" data-k="status">-</span></div>' +
                    '<div class="btns"><div class="btn" data-k="auto">自动</div><div class="btn" data-k="pairsBtn">配对</div><div class="btn" data-k="panic">平全部</div></div>' +
                    '<div class="log" data-k="log"></div></div>';
            root.append(style, p);
            doc.documentElement.appendChild(host);
            for (const n of Array.from(p.querySelectorAll('[data-k]')))
                el[n.dataset.k] = n;
            el.toggle.addEventListener('click', () => {
                const open = el.body.classList.toggle('open');
                el.toggle.textContent = open ? '▾' : '▸';
                cfg.set({ panelOpen: open });
                if (open)
                    requestRender();
            });
            if (!cfg.get().panelOpen) {
                el.body.classList.remove('open');
                el.toggle.textContent = '▸';
            }
            el.auto.addEventListener('click', () => { cfg.set({ auto: !cfg.get().auto }); requestRender(); });
            el.pairsBtn.addEventListener('click', () => { cfg.set({ pairs: !cfg.get().pairs }); requestRender(); });
            el.panic.addEventListener('click', () => {
                const s = bridge.state;
                if (!s)
                    return;
                for (const sym of Object.keys(s.positions))
                    exec.doClose(sym, '手动平全部');
            });
            let drag = false, dx = 0, dy = 0;
            const head = p.querySelector('.h');
            head.addEventListener('pointerdown', (e) => { drag = true; dx = e.clientX; dy = e.clientY; head.setPointerCapture(e.pointerId); });
            head.addEventListener('pointermove', (e) => {
                if (!drag)
                    return;
                const r = p.getBoundingClientRect();
                p.style.left = Math.max(0, r.left + e.clientX - dx) + 'px';
                p.style.top = Math.max(0, r.top + e.clientY - dy) + 'px';
                p.style.right = 'auto';
                dx = e.clientX;
                dy = e.clientY;
            });
            head.addEventListener('pointerup', (e) => { drag = false; try {
                head.releasePointerCapture(e.pointerId);
            }
            catch { /* ignore */ } });
        }
        function render() {
            if (!root || !el.body)
                return;
            const s = bridge.state;
            const r = risk.report();
            const c = cfg.get();
            el.dot.className = 'dot' + (bridge.ready ? ' on' : '');
            el.equity.textContent = s ? money(r.equityJpy) : '未连接';
            el.cash.textContent = s ? 'USD ' + money(s.cash.USD ?? 0) + ' / JPY ' + money(s.cash.JPY ?? 0) : '-';
            el.gross.textContent = money(r.grossJpy);
            el.rent.textContent = s ? r.daysToRent.toFixed(1) + ' 天' + (r.rentShortJpy > 0 ? ' 缺' + money(r.rentShortJpy) : '') : '-';
            const t = r.tripped;
            el.status.textContent = t.length ? t.join(' ') : '正常';
            el.status.className = 'v ' + (t.length ? 'bad' : 'ok');
            el.auto.className = 'btn' + (c.auto ? ' on' : '');
            el.pairsBtn.className = 'btn' + (c.pairs ? ' on' : '');
            if (!el.body.classList.contains('open'))
                return;
            el.positions.innerHTML = r.rows.map((row) => {
                const pct = Math.max(0, Math.min(1, 1 - row.liqDist / GAME.LIQ_RATIO));
                const cls = row.liqDist < 0.2 ? 'bad' : row.liqDist < 0.4 ? 'warn' : '';
                return '<div class="pos"><div class="t"><span>' + row.symbol + ' ' + (row.side === 'long' ? '多' : '空') + '</span><span class="' + cls + '">' + (row.pnl >= 0 ? '+' : '') + row.pnl.toFixed(2) + '</span></div>' +
                    '<div class="t"><span class="k">爆仓距 ' + row.liqDist.toFixed(2) + '</span><span class="k">' + row.price + '</span></div>' +
                    '<div class="bar"><i style="width:' + (pct * 100).toFixed(0) + '%"></i></div></div>';
            }).join('') || '<div class="k" style="padding:2px 0">无持仓</div>';
            el.log.textContent = log.tail(TUNING.logPanelLines).join('\n');
        }
        return {
            start() {
                build();
                bus.on(EV.RISK, requestRender);
                bus.on(EV.QUOTES, requestRender);
                bus.on(EV.LOG, requestRender);
                bus.on(EV.CONFIG, requestRender);
                requestRender();
            },
            render,
            setPairsSummary(views) {
                if (!el.pairs)
                    return;
                el.pairs.textContent = views.length
                    ? views.map((v) => v.key.split('/')[0].slice(0, 5) + ' z' + v.z.toFixed(1) + ' n' + v.n).join(' ')
                    : '预热';
            },
        };
    }
    /* ───────── 引导 ───────── */
    function whenRoot(doc, cb) {
        if (doc.getElementById('root')) {
            cb();
            return;
        }
        const mo = new MutationObserver(() => {
            if (!doc.getElementById('root'))
                return;
            mo.disconnect();
            cb();
        });
        mo.observe(doc.documentElement, { childList: true, subtree: true });
    }
    function boot() {
        const w = window;
        if (w.__FXKQ__)
            return;
        const bus = createBus();
        const log = createLog(bus);
        const cfg = createConfig(bus);
        const bridge = createBridge(document, bus, log);
        const series = createSeries();
        const feed = createFeed(bridge, series, bus);
        const risk = createRisk(bridge, feed, cfg, bus);
        const execCtx = { bridge, risk, feed, cfg, bus, log, state: { lastAction: 0, busy: new Set() } };
        const exec = createExec(execCtx);
        const ui = createUi({ doc: document, bridge, risk, feed, cfg, bus, log, exec });
        let views = [];
        let lastPairScan = 0;
        const sched = createScheduler(TUNING.schedTickMs);
        sched.every(TUNING.harvestMs, () => bridge.harvest());
        sched.every(TUNING.healthMs, () => bridge.health());
        sched.every(TUNING.strategyMs, () => {
            const s = bridge.state;
            if (!s)
                return;
            const now = Date.now();
            if (now - lastPairScan >= TUNING.pairScanMs) {
                views = analyzePairs(series, cfg);
                lastPairScan = now;
                ui.setPairsSummary(views);
            }
            const held = Object.keys(s.positions);
            const decisions = [];
            if (views.length)
                decisions.push(...decidePairs(views, cfg));
            const pool = Object.keys(bridge.quotes).filter((k) => !held.includes(k));
            decisions.push(...decideSignal(series, pool, cfg));
            exec.runCycle(decisions, views);
        });
        sched.every(TUNING.healthMs, () => risk.check());
        whenRoot(document, () => {
            bridge.connect();
            bridge.harvest();
            sched.start();
            ui.start();
            log.push('boot', '已启动 v' + VERSION);
        });
        w.__FXKQ__ = {
            version: VERSION,
            debug: () => ({
                ready: bridge.ready,
                quotes: bridge.quotes,
                prices: feed.all(),
                state: bridge.state,
                risk: risk.report(),
                pairs: views,
                log: log.tail(40),
            }),
            stop: () => { sched.stop(); bridge.disconnect(); },
        };
    }
    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    else
        boot();
})();
