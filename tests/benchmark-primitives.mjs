import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import vm from 'node:vm';

const source = await readFile(new URL('../fx-kurumi.user.js', import.meta.url), 'utf8');
const start = source.indexOf('function createRingBuffer(');
const end = source.indexOf('\n    /* MATH:BEGIN', start);
if (start < 0 || end < 0) throw new Error('Could not locate production Ring Buffer helper');
const createRingBuffer = vm.runInNewContext('(' + source.slice(start, end).trim() + ')');

const capacity = Number(process.env.CAPACITY || 4000);
const operations = Number(process.env.OPERATIONS || 500000);
if (!Number.isInteger(capacity) || capacity < 1 || !Number.isInteger(operations) || operations < capacity) {
  throw new Error('CAPACITY must be positive and OPERATIONS must be >= CAPACITY');
}

function run(name, fn) {
  // Warm-up reduces first-call/JIT noise; this is a microbenchmark, not a browser result.
  fn(Math.min(operations, 50000));
  const t0 = performance.now();
  fn(operations);
  return { name, operations, elapsedMs: +(performance.now() - t0).toFixed(2) };
}

const arrayResult = run('Array.push+shift', (count) => {
  const values = [];
  for (let i = 0; i < count; i++) {
    values.push(i);
    if (values.length > capacity) values.shift();
  }
});

const ringResult = run('RingBuffer.push', (count) => {
  const values = createRingBuffer(capacity);
  for (let i = 0; i < count; i++) values.push(i);
});

console.log(JSON.stringify({
  note: 'Microbenchmark only. Use Edge DevTools on the real game page for acceptance.',
  capacity,
  results: [arrayResult, ringResult],
}, null, 2));
