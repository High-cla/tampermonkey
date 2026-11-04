// ==UserScript==
// @name         Bilibili Toy Performance Monitor
// @namespace    https://www.bilibilitoy.com/
// @version      0.1.0
// @description  Low-intrusion browser benchmark helper for Toy userscripts
// @match        https://www.bilibilitoy.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
  if (window.__TOY_PERF__) return;

  const perf = window.performance;
  const state = {
    active: false,
    label: '',
    startedAt: 0,
    raf: 0,
    previousFrame: 0,
    frames: [],
    longTasks: [],
    resourceCountAtStart: 0,
    observer: null,
  };

  function quantile(values, q) {
    if (!values.length) return 0;
    const copy = values.slice().sort((a, b) => a - b);
    return copy[Math.min(copy.length - 1, Math.floor((copy.length - 1) * q))];
  }

  function frameStats() {
    const a = state.frames;
    if (!a.length) return { samples: 0, meanMs: 0, p95Ms: 0, maxMs: 0 };
    let sum = 0, max = 0;
    for (const n of a) {
      sum += n;
      if (n > max) max = n;
    }
    return {
      samples: a.length,
      meanMs: +(sum / a.length).toFixed(2),
      p95Ms: +quantile(a, 0.95).toFixed(2),
      maxMs: +max.toFixed(2),
    };
  }

  function scriptPresence() {
    return {
      fxQuant: !!window.__FXQ__,
      fxKurumi: !!window.__FXKQ__,
      aShare: !!window.__AQ__,
    };
  }

  function frame(now) {
    if (!state.active) return;
    if (state.previousFrame) state.frames.push(now - state.previousFrame);
    state.previousFrame = now;
    state.raf = requestAnimationFrame(frame);
  }

  function start(label = 'manual') {
    if (state.active) throw new Error('Benchmark already running; call stop() first');
    state.label = String(label);
    state.startedAt = perf.now();
    state.previousFrame = 0;
    state.frames = [];
    state.longTasks = [];
    state.resourceCountAtStart = perf.getEntriesByType('resource').length;
    state.active = true;

    try {
      if (typeof PerformanceObserver === 'function') {
        state.observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.entryType === 'longtask') {
              state.longTasks.push({ startMs: +entry.startTime.toFixed(2), durationMs: +entry.duration.toFixed(2) });
            }
          }
        });
        state.observer.observe({ type: 'longtask', buffered: false });
      }
    } catch {
      state.observer = null;
    }
    state.raf = requestAnimationFrame(frame);
    return { started: true, label: state.label };
  }

  function stop() {
    if (!state.active) return null;
    state.active = false;
    cancelAnimationFrame(state.raf);
    try { state.observer?.disconnect(); } catch {}
    state.observer = null;

    const elapsedMs = perf.now() - state.startedAt;
    const resources = perf.getEntriesByType('resource').slice(state.resourceCountAtStart);
    let transferBytes = 0;
    let apiRequests = 0;
    for (const item of resources) {
      transferBytes += item.transferSize || 0;
      if (/frankfurter|\/api\/|\/ws(?:\?|$)/i.test(item.name)) apiRequests++;
    }
    const heap = perf.memory ? {
      usedBytes: perf.memory.usedJSHeapSize,
      totalBytes: perf.memory.totalJSHeapSize,
      limitBytes: perf.memory.jsHeapSizeLimit,
    } : null;
    const longTaskTotalMs = state.longTasks.reduce((sum, item) => sum + item.durationMs, 0);
    const result = {
      label: state.label,
      elapsedMs: +elapsedMs.toFixed(2),
      scripts: scriptPresence(),
      frames: frameStats(),
      longTasks: {
        supported: !!(typeof PerformanceObserver === 'function'),
        count: state.longTasks.length,
        totalMs: +longTaskTotalMs.toFixed(2),
        maxMs: state.longTasks.reduce((max, item) => Math.max(max, item.durationMs), 0),
        entries: state.longTasks,
      },
      resources: {
        count: resources.length,
        apiLikeCount: apiRequests,
        transferBytes,
      },
      heap,
      userAgent: navigator.userAgent,
    };
    state.last = result;
    return result;
  }

  function report() {
    return state.active ? { active: true, label: state.label } : (state.last || null);
  }

  window.__TOY_PERF__ = Object.freeze({ start, stop, report, version: '0.1.0' });
})();
