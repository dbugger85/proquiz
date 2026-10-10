// Avatars (a Quick quiz player's face, a board team's mascot): the rules, the drawing, and where they go in the views.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AVATAR_PARTS, AVATAR_KEYS, isValidAvatar, cleanAvatar, randomAvatar, avatarKey } from '../lib/avatar.js';
import { avatarSvg, DRAWN } from '../public/js/avatar.js';
import { apply, newGame, COLORS, GameError, phoneView, displayView, hostView } from '../lib/game.js';
import { standings, standingsBefore } from '../lib/quick.js';

const A = { skin: 2, hair: 3, hairColor: 1, eyes: 0, mouth: 4, glasses: 1, hat: 3 };
const run = (s, ...actions) => actions.reduce(apply, s);

test('an avatar must have every part, each a whole number in range', () => {
  assert.equal(isValidAvatar(A), true);
  assert.equal(isValidAvatar({ ...A, hat: AVATAR_PARTS.hat }), false); // out of range
  assert.equal(isValidAvatar({ ...A, skin: -1 }), false);
  assert.equal(isValidAvatar({ ...A, eyes: 1.5 }), false);
  assert.equal(isValidAvatar({ ...A, mouth: '1' }), false);
  const { glasses, ...missing } = A;
  assert.equal(isValidAvatar(missing), false);
  for (const bad of [null, undefined, 'a', 3, [], [1, 2]]) assert.equal(isValidAvatar(bad), false);
  // Extra keys are dropped, the order is fixed.
  assert.deepEqual(cleanAvatar({ hat: 3, ...A, evil: '<script>' }), A);
  assert.deepEqual(Object.keys(cleanAvatar(A)), AVATAR_KEYS);
  assert.equal(cleanAvatar(null), null);
  assert.equal(avatarKey(A), '2-3-1-0-4-1-3');
  assert.equal(avatarKey({ nope: 1 }), '');
});

test('random avatars are always valid, and about half have no hat or glasses', () => {
  let hats = 0;
  let glasses = 0;
  for (let i = 0; i < 500; i++) {
    const a = randomAvatar();
    assert.ok(isValidAvatar(a), JSON.stringify(a));
    if (a.hat) hats++;
    if (a.glasses) glasses++;
  }
  assert.ok(hats > 175 && hats < 325, `hats: ${hats}`);
  assert.ok(glasses > 175 && glasses < 325, `glasses: ${glasses}`);
  // Every option of every part comes up.
  const seen = Object.fromEntries(AVATAR_KEYS.map((k) => [k, new Set()]));
  for (let i = 0; i < 2000; i++) for (const [k, v] of Object.entries(randomAvatar())) seen[k].add(v);
  for (const k of AVATAR_KEYS) assert.equal(seen[k].size, AVATAR_PARTS[k], k);
});

test('the drawings have exactly the options the rules allow, and every one draws', () => {
  assert.deepEqual(DRAWN, AVATAR_PARTS);
  for (const k of AVATAR_KEYS) {
    for (let n = 0; n < AVATAR_PARTS[k]; n++) {
      const svg = avatarSvg({ ...A, [k]: n });
      assert.match(svg, /^<svg viewBox="0 0 100 100"[^>]*aria-hidden="true"/);
      assert.ok(svg.endsWith('</svg>'));
      assert.doesNotMatch(svg, /<script|<image|href|NaN|undefined|filter|Gradient/i, `${k} ${n}`);
    }
  }
  assert.notEqual(avatarSvg(A), avatarSvg({ ...A, hat: 0 }));
  assert.equal(avatarSvg(null), '');
  assert.equal(avatarSvg({ ...A, hair: 99 }), '');
});

test('joining with an avatar keeps it; a bad one is refused; without one still works', () => {
  let s = newGame({ categories: [{ name: 'A', questions: [{ value: 100, question: 'q', answer: 'a' }] }] });
  s = run(s, { type: 'join', teamId: 'r', name: 'Red', color: COLORS[0], avatar: { ...A, extra: 1 } });
  assert.deepEqual(s.teams[0].avatar, A);
  s = run(s, { type: 'join', teamId: 'b', name: 'Blue', color: COLORS[1] });
  assert.equal('avatar' in s.teams[1], false); // an old phone: just the name
  assert.throws(() => apply(s, { type: 'join', teamId: 'g', name: 'Green', color: COLORS[2], avatar: { ...A, hat: 9 } }), (e) => e instanceof GameError && e.code === 'bad-avatar');
  assert.throws(() => apply(s, { type: 'join', teamId: 'g', name: 'Green', color: COLORS[2], avatar: 'smiley' }), (e) => e.code === 'bad-avatar');
  // Changing the team on the phone changes the mascot; joining again without one keeps it.
  s = run(s, { type: 'join', teamId: 'r', name: 'Red', color: COLORS[0], avatar: { ...A, hat: 0 } });
  assert.equal(s.teams[0].avatar.hat, 0);
  s = run(s, { type: 'join', teamId: 'r', name: 'Reds', color: COLORS[0] });
  assert.equal(s.teams[0].avatar.hat, 0);
  // Every screen gets it.
  assert.deepEqual(phoneView(s, 'r').you.avatar, s.teams[0].avatar);
  assert.deepEqual(phoneView(s, 'b').teams[0].avatar, s.teams[0].avatar);
  assert.deepEqual(displayView(s).teams[0].avatar, s.teams[0].avatar);
  assert.equal('avatar' in phoneView(s, 'r').teams[1], false);
  // Start, undo and restart keep it.
  s = run(s, { type: 'start', picker: 'r' }, { type: 'adjust', teamId: 'r', delta: 100 }, { type: 'undo' }, { type: 'restart' });
  assert.equal(s.teams[0].avatar.hat, 0);
  assert.deepEqual(hostView(s).teams[0].avatar, s.teams[0].avatar);
});

test('a Quick quiz carries the avatars into the standings, the top 5, the fastest and the gap line', () => {
  const set = { v: 1, kind: 'quick', title: 'T', sections: [{ name: 'S', questions: [{ question: 'q', options: ['a', 'b'], correct: 0 }, { question: 'q2', options: ['a', 'b'], correct: 0 }] }] };
  let s = run(
    newGame(set),
    { type: 'join', teamId: 'a', name: 'Ann', color: COLORS[0], avatar: A },
    { type: 'join', teamId: 'b', name: 'Bob', color: COLORS[1] },
    { type: 'start' },
    { type: 'next', now: 0 },
    { type: 'next', now: 100 },
    { type: 'answer', teamId: 'a', option: 0, now: 500 },
    { type: 'answer', teamId: 'b', option: 1, now: 600 },
  );
  assert.equal(s.phase, 'result');
  assert.deepEqual(displayView(s).q.fastest.avatar, A);
  assert.deepEqual(displayView(s).teams[0].avatar, A);
  assert.deepEqual(standings(s)[0].avatar, A);
  assert.equal('avatar' in standings(s)[1], false);
  assert.deepEqual(standingsBefore(s).find((e) => e.id === 'a').avatar, A);
  assert.deepEqual(phoneView(s, 'a').you.avatar, A);
  assert.deepEqual(phoneView(s, 'b').behind.avatar, A);
  s = run(s, { type: 'next', now: 2000 });
  assert.deepEqual(displayView(s).ranks.top[0].avatar, A);
  assert.deepEqual(displayView(s).ranks.before.find((e) => e.id === 'a').avatar, A);
});
