// ==UserScript==
// @name         FX Kurumi Public Store Probe
// @namespace    https://www.bilibilitoy.com/toy/fx-kurumi
// @version      0.1.0
// @description  Read-only probe for deliberately exposed store APIs; does not inspect React Fiber or hook into WebSocket
// @match        https://www.bilibilitoy.com/toy/fx-kurumi/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
  if (window.__FXKQ_API_PROBE__) return;

  const CANDIDATES = [
    '__REDUX_STORE__',
    '__ZUSTAND_STORE__',
    '__FXKQ_PUBLIC_STORE__',
    'fxKurumiStore',
    'gameStore',
    'marketStore',
    'store',
  ];

  function inspect() {
    const out = [];
    for (const name of CANDIDATES) {
      let store = null;
      try {
        const descriptor = Object.getOwnPropertyDescriptor(window, name);
        // Do not invoke global getters: only inspect data properties intentionally exposed on window.
        if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value'))
          store = descriptor.value;
      } catch {
        store = null;
      }
      if (!store || typeof store !== 'object') continue;
      out.push({
        name,
        subscribe: typeof store.subscribe === 'function',
        getState: typeof store.getState === 'function',
        getSnapshot: typeof store.getSnapshot === 'function',
      });
    }
    return out;
  }

  function read(name) {
    const candidate = inspect().find((item) => item.name === name);
    if (!candidate || (!candidate.getState && !candidate.getSnapshot))
      throw new Error('No readable public store candidate: ' + name);

    const descriptor = Object.getOwnPropertyDescriptor(window, name);
    const store = descriptor && descriptor.value;
    const getter = typeof store.getSnapshot === 'function' ? store.getSnapshot : store.getState;
    const state = getter.call(store);
    if (!state || typeof state !== 'object') return { name, valid: false };

    const positions = state.positions;
    const cash = state.cash;
    const quoteCandidates = [
      state.quotes,
      state.prices,
      state.market && state.market.quotes,
      state.marketData && state.marketData.quotes,
    ];
    const quotes = quoteCandidates.find((value) => value && typeof value === 'object' && !Array.isArray(value));
    return {
      name,
      valid: !!(cash && positions && typeof positions === 'object'),
      topLevelKeys: Object.keys(state).slice(0, 40),
      hasCash: !!cash,
      hasPositions: !!positions,
      quoteKeys: quotes ? Object.keys(quotes).slice(0, 40) : [],
    };
  }

  window.__FXKQ_API_PROBE__ = Object.freeze({
    version: '0.1.0',
    inspect,
    read,
  });
})();
