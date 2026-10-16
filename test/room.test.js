// lib/room.js: host keys and the room codes made from them (the website version, docs/dev/web-plan.md §1.4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newKey, codeFor, base32, normalizeCode, KEY, ROOM_CODE, CODE_ALPHABET, CODE_LENGTH } from '../lib/room.js';

test('the alphabet has 32 symbols and none of 0, O, 1, I', () => {
  assert.equal(CODE_ALPHABET.length, 32);
  assert.equal(new Set(CODE_ALPHABET).size, 32);
  for (const ch of '0O1I') assert.ok(!CODE_ALPHABET.includes(ch), ch);
  assert.equal(CODE_LENGTH, 6);
});

test('newKey(): 22 base64url characters, different every time', () => {
  const keys = Array.from({ length: 50 }, newKey);
  for (const k of keys) assert.match(k, KEY);
  assert.equal(new Set(keys).size, keys.length);
});

test('codeFor(): the same code for the same key, 6 symbols from the alphabet, fixed vectors', async () => {
  assert.equal(await codeFor('test-key'), 'NLZ2QB');
  assert.equal(await codeFor('another'), 'X3CJXU');
  const code = await codeFor(newKey());
  assert.match(code, ROOM_CODE);
  assert.equal(code.length, CODE_LENGTH);
  assert.equal(await codeFor('abc'), await codeFor('abc'));
  assert.notEqual(await codeFor('abc'), await codeFor('abd'));
  await assert.rejects(codeFor(''), { message: 'bad-key' });
  await assert.rejects(codeFor(null), { message: 'bad-key' });
});

test('base32(): bits packed from the left, no padding', () => {
  assert.equal(base32(new Uint8Array([])), '');
  assert.equal(base32(new Uint8Array([0, 0, 0, 0, 0])), 'AAAAAAAA');
  assert.equal(base32(new Uint8Array([255, 255, 255, 255, 255])), '99999999');
  assert.equal(base32(new Uint8Array([0b11111000])), '9A'); // 11111 then 000 padded to 00000
});

test('normalizeCode(): typed codes are tidied, anything that cannot be a code refused', () => {
  assert.equal(normalizeCode('nlz2qb'), 'NLZ2QB');
  assert.equal(normalizeCode(' NLZ-2QB '), 'NLZ2QB');
  assert.equal(normalizeCode('n1z0qb'), null); // 0, O, 1 and I are never in a code
  assert.equal(normalizeCode('NLZ2Q'), null); // too short
  assert.equal(normalizeCode('NLZ2QBX'), null); // too long
  assert.equal(normalizeCode('NLZ2Q!'), null);
  assert.equal(normalizeCode(''), null);
  assert.equal(normalizeCode(null), null);
});
