import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../fx-kurumi.user.js', import.meta.url), 'utf8');
const start = source.indexOf('function createRingBuffer(');
const end = source.indexOf('\n    /* MATH:BEGIN', start);
assert.notEqual(start, -1, 'production Ring Buffer helper must exist');
assert.notEqual(end, -1, 'Ring Buffer helper must have a clear end marker');
const declaration = source.slice(start, end).trim();
const createRingBuffer = vm.runInNewContext('(' + declaration + ')');

test('Ring Buffer preserves FIFO order without growing past capacity', () => {
  const ring = createRingBuffer(3);
  assert.equal(ring.length, 0);
  assert.equal(ring.push('a'), undefined);
  assert.equal(ring.push('b'), undefined);
  assert.equal(ring.push('c'), undefined);
  assert.equal(ring.length, 3);
  assert.deepEqual([ring.at(0), ring.at(1), ring.at(2)], ['a', 'b', 'c']);
  assert.equal(ring.push('d'), 'a');
  assert.equal(ring.length, 3);
  assert.deepEqual([ring.at(0), ring.at(1), ring.at(2)], ['b', 'c', 'd']);
  assert.equal(ring.at(-1), 'd');
  assert.equal(ring.at(-3), 'b');
  assert.equal(ring.at(3), undefined);
  assert.equal(ring.at(-4), undefined);
});

test('Ring Buffer handles repeated wrap-around and capacity one', () => {
  const ring = createRingBuffer(1);
  assert.equal(ring.push(1), undefined);
  assert.equal(ring.push(2), 1);
  assert.equal(ring.push(3), 2);
  assert.equal(ring.length, 1);
  assert.equal(ring.at(0), 3);
  assert.equal(ring.at(-1), 3);
});

test('Ring Buffer clear resets indexes and releases retained entries', () => {
  const ring = createRingBuffer(2);
  ring.push({ id: 1 });
  ring.push({ id: 2 });
  ring.clear();
  assert.equal(ring.length, 0);
  assert.equal(ring.at(0), undefined);
  assert.equal(ring.push('fresh'), undefined);
  assert.equal(ring.at(0), 'fresh');
});

test('Ring Buffer rejects invalid capacities', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => createRingBuffer(value), { name: 'RangeError' });
  }
});
