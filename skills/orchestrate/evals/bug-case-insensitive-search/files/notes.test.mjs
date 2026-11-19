import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, search } from './notes.mjs';

test('add gives each note the next id', () => {
  const notes = add(add([], 'first'), 'second');
  assert.deepEqual(notes.map((n) => n.id), [1, 2]);
});

test('search finds notes containing the term', () => {
  const notes = add(add([], 'Buy Milk'), 'Call the bank');
  assert.deepEqual(search(notes, 'bank').map((n) => n.text), ['Call the bank']);
});
