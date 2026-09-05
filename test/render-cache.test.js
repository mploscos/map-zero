import assert from 'node:assert/strict';
import test from 'node:test';
import { LruCache, cachedPromise } from '../packages/core/src/shared/cache.js';

test('cache evicts the least recently used entry and bounds retained memory', () => {
  const cache = new LruCache(2);
  cache.set('a', 1).set('b', 2);
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);
  assert.equal(cache.has('b'), false);
  assert.deepEqual([...cache.keys()], ['a', 'c']);
});

test('concurrent tile consumers share loads; failed tiles can be retried', async () => {
  const cache = new LruCache(2);
  let loads = 0;
  const load = async () => { loads++; throw new Error('temporary'); };
  const first = cachedPromise(cache, 'tile', load);
  const second = cachedPromise(cache, 'tile', load);
  assert.equal(first, second);
  await assert.rejects(first, /temporary/);
  assert.equal(cache.size, 0);
  assert.equal(await cachedPromise(cache, 'tile', () => { loads++; return 42; }), 42);
  assert.equal(loads, 2);
});

test('a late rejected load does not evict its replacement after invalidation', async () => {
  const cache = new LruCache(2);
  let reject;
  const first = cachedPromise(cache, 'tile', () => new Promise((_, fail) => { reject = fail; }));
  await Promise.resolve();
  cache.clear();
  const second = cachedPromise(cache, 'tile', () => 42);
  reject(new Error('old request'));
  await assert.rejects(first);
  assert.equal(cache.get('tile'), second);
});
