// Kaosmodus / Crazy mode: the special tiles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { apply, newGame, COLORS, displayView, phoneView, hostView } from '../lib/game.js';
import { placeSpecials, specialCount, turboTiles, maxBet, SOLO } from '../lib/crazy.js';

const sample = JSON.parse(readFileSync(new URL('../sets/sample.json', import.meta.url)));
const run = (s, ...actions) => actions.reduce(apply, s);
const score = (s, id) => s.teams.find((t) => t.id === id).score;

// Teams r, b, g on the sample board; r picks. `specials` places them by hand.
function game(specials, settings = {}) {
  return run(
    newGame(sample, { crazy: 'some', ...settings }),
    { type: 'join', teamId: 'r', name: 'Red', color: COLORS[0] },
    { type: 'join', teamId: 'b', name: 'Blue', color: COLORS[1] },
    { type: 'join', teamId: 'g', name: 'Green', color: COLORS[2] },
    { type: 'start', picker: 'r', seed: 42, specials },
  );
}

test('placement: a little is about 1 in 8 tiles, lots about 1 in 4, always a triple and a bomb, one turbo at most', () => {
  assert.equal(specialCount('some', 25), 3);
  assert.equal(specialCount('lots', 25), 6);
  assert.equal(specialCount('off', 25), 0);
  for (let seed = 1; seed < 200; seed++) {
    const s = { set: sample, rng: seed };
    const lots = Object.values(placeSpecials(s, 'lots'));
    assert.equal(lots.length, 6);
    assert.ok(lots.includes('triple') && lots.includes('bomb'));
    for (const k of ['turbo', 'jackpot', 'rescue']) assert.ok(lots.filter((x) => x === k).length <= 1, k);
  }
  // The server's seed decides it, the same seed gives the same board.
  const a = run(newGame(sample, { crazy: 'lots' }), { type: 'join', teamId: 'r', name: 'R', color: COLORS[0] }, { type: 'start', seed: 7 });
  const b = run(newGame(sample, { crazy: 'lots' }), { type: 'join', teamId: 'r', name: 'R', color: COLORS[0] }, { type: 'start', seed: 7 });
  assert.deepEqual(a.specials, b.specials);
  assert.equal(Object.keys(a.specials).length, 6);
  const off = run(newGame(sample), { type: 'join', teamId: 'r', name: 'R', color: COLORS[0] }, { type: 'start', seed: 7 });
  assert.deepEqual(off.specials, {});
});

test('placement: spread over the categories, and no one-team specials on picture questions', () => {
  // A 6×5 board where every 100 and 200 question has a picture.
  const set = { categories: Array.from({ length: 6 }, () => ({ questions: Array.from({ length: 5 }, (_, i) => (i < 2 ? { image: 'x.png' } : {})) })) };
  const perCategory = Array(6).fill(0);
  for (let seed = 1; seed < 500; seed++) {
    const some = placeSpecials({ set, rng: seed }, 'some'); // 4 specials on 6 categories
    const cols = Object.keys(some).map((k) => Number(k.split('-')[0]));
    assert.equal(new Set(cols).size, cols.length, `seed ${seed}: two specials in one category`);
    cols.forEach((c) => perCategory[c]++);
    const lots = placeSpecials({ set, rng: seed }, 'lots', ['triple', 'bomb', 'jackpot', 'freeze']); // only one-team kinds
    for (const [key, kind] of Object.entries(lots)) {
      assert.ok(SOLO.includes(kind));
      assert.ok(Number(key.split('-')[1]) >= 2, `seed ${seed}: ${kind} on a picture question`);
    }
  }
  assert.ok(Math.min(...perCategory) > 200, 'every category gets specials'); // about 333 each
  // Turbo never adds a picture question either.
  const s = { set, rng: 5, specials: {}, used: set.categories.map((cat) => cat.questions.map(() => false)) };
  for (const [, i] of turboTiles(s, 20)) assert.ok(i >= 2);
});

test('the TV and the phones never learn where the specials are', () => {
  let s = game({ '0-0': 'bomb', '1-1': 'triple', '2-2': 'jackpot' });
  const secret = (v) => JSON.stringify(v).includes('bomb') || JSON.stringify(v).includes('triple') || JSON.stringify(v).includes('"pot"');
  assert.ok(!secret(displayView(s)));
  assert.ok(!secret(phoneView(s, 'r')));
  assert.ok(hostView(s).specials['0-0'] === 'bomb'); // the host knows
  // Once picked, everybody may know.
  s = apply(s, { type: 'pick', c: 1, i: 1 });
  assert.equal(s.phase, 'special');
  assert.equal(s.event.type, 'special');
  assert.equal(displayView(s).q.special, 'triple');
  assert.equal(phoneView(s, 'b').special, 'triple');
  assert.equal(phoneView(s, 'b').status, 'special');
  assert.equal(displayView(s).specials, undefined); // still not the others
});

test('triple: 3× the points, and 3× the penalty for every team that answers wrong', () => {
  let s = run(game({ '1-1': 'triple' }), { type: 'pick', c: 1, i: 1 }); // a 200 tile
  assert.equal(apply(s, { type: 'buzz', teamId: 'b', now: 1 }), s); // no buzzing during the reveal
  s = run(s, { type: 'next', now: 0 }, { type: 'arm', now: 0 });
  assert.equal(s.q.value, 600);
  assert.equal(s.q.baseValue, 200);
  s = run(s, { type: 'buzz', teamId: 'b', now: 1 }, { type: 'wrong', now: 2 }); // half of 600
  assert.equal(score(s, 'b'), -300);
  s = run(s, { type: 'buzz', teamId: 'g', now: 3 }, { type: 'correct' });
  assert.equal(score(s, 'g'), 600);
});

test('bomb: no question, the picking team loses the value at once (undo gives it back)', () => {
  let s = run(game({ '0-4': 'bomb' }), { type: 'pick', c: 0, i: 4 }); // a 500 tile
  assert.equal(s.phase, 'special');
  s = apply(s, { type: 'next', now: 0 });
  assert.equal(s.phase, 'revealed');
  assert.deepEqual(s.q.result, { type: 'boom', teamId: 'r', amount: 500 });
  assert.equal(score(s, 'r'), -500);
  assert.equal(s.event.type, 'boom');
  assert.equal(s.picker, 'r');
  s = apply(s, { type: 'undo' });
  assert.equal(score(s, 'r'), 0);
  assert.equal(s.phase, 'special');
  // With negative scores switched off, a bomb stops at zero.
  const z = run(game({ '0-4': 'bomb' }, { allowNegative: false }), { type: 'pick', c: 0, i: 4 }, { type: 'next', now: 0 });
  assert.equal(score(z, 'r'), 0);
});

test('hot seat: only the picking team answers, with the normal penalty and no second chances', () => {
  let s = run(game({ '0-1': 'hotseat' }), { type: 'pick', c: 0, i: 1 }, { type: 'next', now: 0 });
  assert.equal(s.q.solo, 'r');
  assert.equal(phoneView(s, 'r').status, 'soloReady');
  assert.equal(phoneView(s, 'b').status, 'standBack');
  assert.equal(apply(s, { type: 'buzz', teamId: 'b', now: 1 }), s);
  s = apply(s, { type: 'arm', now: 1000 });
  assert.equal(s.phase, 'answering');
  assert.equal(s.q.buzzedTeam, 'r');
  assert.equal(s.deadline, 1000 + 15_000);
  assert.equal(phoneView(s, 'r').status, 'solo');
  s = apply(s, { type: 'wrong', now: 2000 });
  assert.equal(score(s, 'r'), -100);
  assert.equal(s.phase, 'revealed'); // nobody else gets to try
});

test('rescue: the team in last place answers alone, and a wrong answer costs nothing', () => {
  let s = run(game({ '2-2': 'rescue' }), { type: 'adjust', teamId: 'r', delta: 500 }, { type: 'adjust', teamId: 'g', delta: 200 });
  s = run(s, { type: 'pick', c: 2, i: 2 }, { type: 'next', now: 0 });
  assert.equal(s.q.solo, 'b');
  s = run(s, { type: 'arm', now: 0 }, { type: 'wrong', now: 1 });
  assert.equal(score(s, 'b'), 0);
  assert.equal(s.picker, 'r');
});

test('turbo: three questions in a row for the picking team, 5 seconds each, no penalty', () => {
  let s = run(game({ '3-0': 'turbo', '4-4': 'bomb' }), { type: 'pick', c: 3, i: 0 }, { type: 'next', now: 0 });
  assert.deepEqual({ n: s.turbo.n, total: s.turbo.total, team: s.turbo.team }, { n: 1, total: 3, team: 'r' });
  assert.ok(!s.turbo.queue.some(([c, i]) => c === 4 && i === 4)); // never another special
  assert.ok(!s.turbo.queue.some(([c, i]) => c === 3 && i === 0));
  assert.deepEqual(displayView(s).turbo, { n: 1, total: 3, team: 'r' });
  s = apply(s, { type: 'arm', now: 1000 });
  assert.equal(s.deadline, 1000 + 5000);
  s = apply(s, { type: 'correct' });
  const first = s.q.value;
  assert.equal(score(s, 'r'), first);
  // Next opens the second turbo question by itself.
  s = apply(s, { type: 'next', now: 0 });
  assert.equal(s.phase, 'reading');
  assert.equal(s.turbo.n, 2);
  assert.equal(s.q.solo, 'r');
  s = run(s, { type: 'arm', now: 0 }, { type: 'timeout', now: 5000 }); // too slow: no penalty
  assert.equal(score(s, 'r'), first);
  assert.equal(s.phase, 'revealed');
  s = run(s, { type: 'next', now: 0 }, { type: 'arm', now: 0 }, { type: 'wrong', now: 1 });
  assert.equal(score(s, 'r'), first);
  assert.equal(phoneView(s, 'r').canPick, false); // the run never goes back to the board in between
  s = apply(s, { type: 'next', now: 0 });
  assert.equal(s.phase, 'board');
  assert.equal(s.turbo, null);
  assert.equal(s.used.flat().filter(Boolean).length, 3);
  assert.equal(phoneView(s, s.picker).canPick, true); // afterwards the picking team picks on its phone again
});

test('a special tile picked on the phone gets the same reveal, and the phone board never gives specials away', () => {
  let s = game({ '0-1': 'hotseat', '2-3': 'bomb' });
  const v = JSON.stringify(phoneView(s, 'r'));
  for (const secret of ['hotseat', 'bomb', 'specials', 'special":"']) assert.ok(!v.includes(secret), secret);
  s = apply(s, { type: 'pick', c: 0, i: 1, teamId: 'r' });
  assert.equal(s.phase, 'special');
  assert.deepEqual([s.event.type, s.event.kind, s.event.teamId], ['special', 'hotseat', 'r']);
});

test('jackpot: lost points pile up in a secret pot, and a right answer on the jackpot tile wins it', () => {
  let s = game({ '2-0': 'jackpot', '0-4': 'bomb' });
  s = run(s, { type: 'pick', c: 0, i: 4 }, { type: 'next', now: 0 }, { type: 'next', now: 0 }); // bomb: −500 into the pot
  s = run(s, { type: 'pick', c: 1, i: 1 }, { type: 'arm', now: 0 }, { type: 'buzz', teamId: 'b', now: 1 }, { type: 'wrong', now: 2 }); // −100
  assert.equal(s.pot, 600);
  assert.equal(displayView(s).pot, undefined);
  s = run(s, { type: 'reveal' }, { type: 'next', now: 0 });
  s = run(s, { type: 'pick', c: 2, i: 0 }, { type: 'next', now: 0 });
  assert.equal(displayView(s).q.pot, 600); // now the room sees it
  s = run(s, { type: 'arm', now: 0 }, { type: 'buzz', teamId: 'g', now: 1 }, { type: 'correct' });
  assert.equal(score(s, 'g'), 100 + 600);
  assert.equal(s.q.won, 600);
  assert.equal(s.pot, 0);
});

test('freeze: the chosen team cannot buzz on this question', () => {
  let s = run(game({ '4-1': 'freeze' }), { type: 'pick', c: 4, i: 1 });
  s = run(s, { type: 'freeze', teamId: 'g' }, { type: 'freeze', teamId: 'b' });
  assert.equal(s.q.frozen, 'b');
  s = run(s, { type: 'next', now: 0 }, { type: 'arm', now: 0 });
  assert.equal(phoneView(s, 'b').status, 'frozen');
  assert.equal(apply(s, { type: 'buzz', teamId: 'b', now: 1 }), s);
  s = run(s, { type: 'buzz', teamId: 'r', now: 1 }, { type: 'wrong', now: 2 }, { type: 'buzz', teamId: 'g', now: 3 }, { type: 'wrong', now: 4 });
  assert.equal(s.phase, 'revealed'); // everyone who could answer has tried
});

test('a special tile can be put back, and it stays special', () => {
  let s = run(game({ '1-1': 'triple' }), { type: 'pick', c: 1, i: 1 }, { type: 'cancel' });
  assert.equal(s.phase, 'board');
  assert.equal(s.used[1][1], false);
  s = apply(s, { type: 'pick', c: 1, i: 1 });
  assert.equal(s.phase, 'special');
});

test('a sound clip waits during the reveal and starts with the question', () => {
  const set = structuredClone(sample);
  set.categories[3].questions[1].audio = 'song.mp3';
  let s = run(
    newGame(set, { crazy: 'some' }),
    { type: 'join', teamId: 'r', name: 'Red', color: COLORS[0] },
    { type: 'start', specials: { '3-1': 'triple' } },
    { type: 'pick', c: 3, i: 1 },
  );
  assert.deepEqual(s.media, { playing: false, seq: 0 });
  s = apply(s, { type: 'next', now: 0 });
  assert.equal(s.media.playing, true);
});

test('restart clears the specials; bad levels are refused', () => {
  const s = apply(game({ '1-1': 'triple' }), { type: 'restart' });
  assert.deepEqual(s.specials, {});
  assert.throws(() => apply(s, { type: 'settings', settings: { crazy: 'wild' } }), { code: 'bad-settings' });
});

test('the host can leave specials out', () => {
  for (let seed = 1; seed < 100; seed++) {
    const kinds = Object.values(placeSpecials({ set: sample, rng: seed }, 'lots', ['jackpot', 'bomb']));
    assert.equal(kinds.length, 6);
    assert.ok(!kinds.includes('jackpot') && !kinds.includes('bomb'));
    assert.ok(kinds.includes('triple'));
  }
  // Only kinds that may appear once: the board gets just those.
  const few = Object.values(placeSpecials({ set: sample, rng: 3 }, 'lots', ['triple', 'bomb', 'hotseat', 'freeze']));
  assert.deepEqual(few.sort(), ['double', 'jackpot', 'rescue', 'turbo']);
  // Everything left out: no specials at all.
  assert.deepEqual(placeSpecials({ set: sample, rng: 3 }, 'lots', ['triple', 'bomb', 'hotseat', 'rescue', 'turbo', 'jackpot', 'freeze', 'double']), {});

  // Through the settings, which keep a tidy list and refuse unknown kinds.
  let s = newGame(sample, { crazy: 'lots' });
  s = apply(s, { type: 'settings', settings: { crazyExclude: ['jackpot', 'turbo', 'jackpot'] } });
  assert.deepEqual(s.settings.crazyExclude, ['turbo', 'jackpot']);
  assert.throws(() => apply(s, { type: 'settings', settings: { crazyExclude: ['lava'] } }), { code: 'bad-settings' });
  assert.throws(() => apply(s, { type: 'settings', settings: { crazyExclude: 'jackpot' } }), { code: 'bad-settings' });
  s = run(s, { type: 'join', teamId: 'r', name: 'R', color: COLORS[0] }, { type: 'start', seed: 9 });
  assert.ok(!Object.values(s.specials).some((k) => k === 'jackpot' || k === 'turbo'));
});

test('freeze: the picking team chooses on its phone, never itself, and only the picking team', () => {
  let s = run(game({ '4-1': 'freeze' }), { type: 'pick', c: 4, i: 1 });
  assert.equal(phoneView(s, 'r').status, 'freezeChoose');
  assert.equal(phoneView(s, 'b').status, 'special');
  assert.equal(apply(s, { type: 'freezePick', teamId: 'b', target: 'g' }), s); // not their pick
  assert.equal(apply(s, { type: 'freezePick', teamId: 'r', target: 'r' }), s); // not yourself
  assert.equal(apply(s, { type: 'freezePick', teamId: 'r', target: 'nobody' }), s);
  s = run(s, { type: 'freezePick', teamId: 'r', target: 'g' }, { type: 'freezePick', teamId: 'r', target: 'b' });
  assert.equal(s.q.frozen, 'b');
  assert.equal(phoneView(s, 'r').frozen, 'b');
  s = apply(s, { type: 'freezePick', teamId: 'r', target: 'b' }); // tap again to take it back
  assert.equal(s.q.frozen, null);
  s = run(s, { type: 'freezePick', teamId: 'r', target: 'g' }, { type: 'next', now: 0 }, { type: 'arm', now: 0 });
  assert.equal(phoneView(s, 'g').status, 'frozen');
  // Not outside the reveal, and not on other specials.
  assert.equal(apply(s, { type: 'freezePick', teamId: 'r', target: 'b' }), s);
  const t = run(game({ '1-1': 'triple' }), { type: 'pick', c: 1, i: 1 });
  assert.equal(apply(t, { type: 'freezePick', teamId: 'r', target: 'b' }), t);
});

test('daily double: the picking team bets on its phone, answers alone, wins the bet or loses all of it', () => {
  let s = run(game({ '0-2': 'double' }, { penalty: 'none' }), { type: 'adjust', teamId: 'r', delta: 300 }, { type: 'pick', c: 0, i: 2 });
  assert.equal(s.phase, 'special');
  assert.equal(phoneView(s, 'r').status, 'bet');
  assert.equal(phoneView(s, 'b').status, 'special');
  assert.equal(phoneView(s, 'b').betting, undefined);
  // Up to the score or the board's top value (500), whichever is more.
  assert.deepEqual(phoneView(s, 'r').betting, { bet: null, max: 500, value: 300 });
  assert.equal(maxBet(sample.categories, 900), 900);
  assert.equal(maxBet(sample.categories, -200), 500);
  assert.throws(() => apply(s, { type: 'bet', teamId: 'r', amount: 501 }), { code: 'bad-wager' });
  assert.throws(() => apply(s, { type: 'bet', teamId: 'r', amount: -1 }), { code: 'bad-wager' });
  assert.throws(() => apply(s, { type: 'bet', teamId: 'r', amount: 1.5 }), { code: 'bad-wager' });
  assert.equal(apply(s, { type: 'bet', teamId: 'b', amount: 100 }), s); // only the picking team bets
  s = apply(s, { type: 'bet', teamId: 'r', amount: 450 });
  assert.equal(phoneView(s, 'r').betting.bet, 450);
  assert.equal(displayView(s).q.bet, 450); // the TV shows the bet
  s = run(s, { type: 'next', now: 0 });
  assert.equal(s.q.value, 450);
  assert.equal(s.q.solo, 'r');
  assert.equal(apply(s, { type: 'bet', teamId: 'r', amount: 10 }), s); // too late to change it
  s = run(s, { type: 'arm', now: 0 });
  assert.equal(s.phase, 'answering');
  // Wrong costs the whole bet, even with "no penalty" for wrong answers.
  const wrong = apply(s, { type: 'wrong', now: 1 });
  assert.equal(score(wrong, 'r'), 300 - 450);
  assert.equal(wrong.phase, 'revealed');
  assert.equal(wrong.pot, 450); // into the jackpot
  const right = apply(s, { type: 'correct' });
  assert.equal(score(right, 'r'), 300 + 450);
  // Running out of time is wrong too.
  assert.equal(score(apply(s, { type: 'timeout', now: 999999 }), 'r'), -150);
});

test('daily double: with no bet the tile’s value is played, and the host can bet for a team', () => {
  let s = run(game({ '1-0': 'double' }), { type: 'pick', c: 1, i: 0 });
  const plain = apply(s, { type: 'next', now: 0 });
  assert.equal(plain.q.value, 100);
  s = run(s, { type: 'bet', amount: 0 }, { type: 'next', now: 0 }, { type: 'arm', now: 0 }, { type: 'wrong', now: 1 });
  assert.equal(score(s, 'r'), 0);
  // Without negative scores, a lost bet stops at zero.
  s = run(game({ '1-0': 'double' }, { allowNegative: false }), { type: 'pick', c: 1, i: 0 }, { type: 'bet', amount: 500 }, { type: 'next', now: 0 }, { type: 'arm', now: 0 }, { type: 'wrong', now: 1 });
  assert.equal(score(s, 'r'), 0);
});

test('specials placed by hand in the quiz: they always play, Kaosmodus adds random ones elsewhere', () => {
  const set = structuredClone(sample);
  set.categories[0].questions[0].special = 'double';
  set.categories[2].questions[3].special = 'bomb';
  set.categories[1].questions[1].special = 'lava'; // unknown kinds are ignored
  const join = { type: 'join', teamId: 'r', name: 'R', color: COLORS[0] };
  const off = run(newGame(set), join, { type: 'start', seed: 3 });
  assert.deepEqual(off.specials, { '0-0': 'double', '2-3': 'bomb' });
  const notUsed = run(newGame(set, { quizSpecials: false }), join, { type: 'start', seed: 3 });
  assert.deepEqual(notUsed.specials, {});
  for (let seed = 1; seed < 100; seed++) {
    const lots = run(newGame(set, { crazy: 'lots' }), join, { type: 'start', seed }).specials;
    assert.equal(Object.keys(lots).length, 6, `seed ${seed}`); // the hand-placed ones count
    assert.equal(lots['0-0'], 'double');
    assert.equal(lots['2-3'], 'bomb');
    assert.equal(Object.values(lots).filter((k) => k === 'double').length, 1);
  }
  // The TV never sees them in the quiz.
  assert.ok(!JSON.stringify(displayView(off)).includes('double'));
});
