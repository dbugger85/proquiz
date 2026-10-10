// Quick quiz (multiple choice): format, rules, scoring and who sees what.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, newGame, COLORS, MAX_TEAMS, MAX_PLAYERS, hostView, displayView, phoneView, clipFor, pointsFor, resumeFix, DEFAULT_SETTINGS } from '../lib/game.js';
import { validateSet, modeOf, rightSet } from '../lib/validate.js';
import { createStore, filesOf } from '../store.js';

const load = (name) => JSON.parse(readFileSync(new URL(`../sets/${name}.json`, import.meta.url)));
const board = load('sample');

// Two sections: 2 questions and 1. The second question has a clip, the third is worth double.
const tiny = {
  v: 1,
  kind: 'quick',
  title: 'Tiny',
  sections: [
    {
      name: 'One',
      seconds: 10,
      questions: [
        { question: 'q1', options: ['a', 'b', 'c', 'd'], correct: 1 },
        { question: 'q2', options: ['yes', 'no'], correct: 0, seconds: 20, audio: 'clip.mp3', audioStart: 3 },
      ],
    },
    { name: 'Two', questions: [{ question: 'q3', options: ['x', 'y', 'z'], correct: 2, points: 2000 }] },
  ],
};

function run(state, ...actions) {
  return actions.reduce(apply, state);
}

// Players r, b, g (r and b share a colour), the game started: the first section's title card.
function started(settings = {}, set = tiny) {
  return run(
    newGame(set, settings),
    { type: 'join', teamId: 'r', name: 'Red', color: COLORS[0] },
    { type: 'join', teamId: 'b', name: 'Blue', color: COLORS[0] },
    { type: 'join', teamId: 'g', name: 'Green', color: COLORS[2] },
    { type: 'start' },
  );
}

// The first question shown at time 0 and its answers opened by the host at 1000 (10 seconds to answer).
const opened = (settings, set) => run(started(settings, set), { type: 'next', now: 0 }, { type: 'next', now: 1000 });
const score = (s, id) => s.teams.find((t) => t.id === id).score;
const answer = (teamId, option, now, extra = {}) => ({ type: 'answer', teamId, option, now, ...extra });

test('the sample quick quizzes are valid and have what the plan asks for', () => {
  for (const name of ['quick-sample', 'lynquiz']) {
    const set = load(name);
    assert.deepEqual(validateSet(set), [], name);
    assert.equal(modeOf(set), 'quick');
    assert.equal(set.sections.length, 3);
    assert.ok(set.sections.every((sec) => sec.questions.length === 5));
    const qs = set.sections.flatMap((sec) => sec.questions);
    assert.ok(qs.some((q) => q.image === 'sample-flag-japan.svg'), `${name}: a picture question`);
    assert.ok(qs.some((q) => q.audio === 'sample-twinkle.mp3'), `${name}: a sound question`);
    assert.ok(qs.some((q) => q.options.length === 2), `${name}: a true/false question`);
    assert.ok(qs.some((q) => q.points === 2000), `${name}: a double-points question`);
    assert.ok(qs.some((q) => Array.isArray(q.correct) && q.correct.length === 2), `${name}: a question with two right answers`);
  }
  assert.deepEqual(validateSet(tiny), []);
  assert.equal(modeOf(board), 'board');
});

test('validation of a quick quiz', () => {
  assert.deepEqual(validateSet({ kind: 'quick', title: 'x' }), [{ code: 'no-sections' }]);
  assert.deepEqual(validateSet({ kind: 'quick', title: 'x', sections: [] }), [{ code: 'no-sections' }]);
  const many = { kind: 'quick', title: 'x', sections: Array.from({ length: 11 }, () => structuredClone(tiny.sections[1])) };
  assert.deepEqual(validateSet(many), [{ code: 'too-many-sections' }]);
  const long = { kind: 'quick', title: 'x', sections: [{ name: 'L', questions: Array.from({ length: 31 }, () => tiny.sections[1].questions[0]) }] };
  assert.deepEqual(validateSet(long), [{ code: 'too-many-section-questions', c: 0 }]);

  const bad = structuredClone(tiny);
  bad.title = '';
  bad.sections[0].name = ' ';
  bad.sections[0].seconds = 3;
  bad.sections[0].questions[0] = { question: '', options: ['a'], correct: 1, seconds: 121, points: 500, image: 'x.exe' };
  bad.sections[0].questions[1].options = ['yes', ''];
  bad.sections[0].questions[1].correct = 2;
  bad.sections[0].questions[1].audio = 'nope.txt';
  bad.sections[1].questions = [];
  assert.deepEqual(validateSet(bad), [
    { code: 'no-title' },
    { code: 'no-section-name', c: 0 },
    { code: 'bad-seconds', c: 0 },
    { code: 'bad-options', c: 0, i: 0 },
    { code: 'bad-correct', c: 0, i: 0 },
    { code: 'bad-seconds', c: 0, i: 0 },
    { code: 'bad-points', c: 0, i: 0 },
    { code: 'bad-image', c: 0, i: 0 },
    { code: 'bad-options', c: 0, i: 1 },
    { code: 'bad-correct', c: 0, i: 1 },
    { code: 'bad-audio', c: 0, i: 1 },
    { code: 'no-questions', c: 1 },
  ]);
  // Five options is too many; a picture alone is a question; no points and double points are fine.
  const ok = structuredClone(tiny);
  ok.sections[0].questions[0] = { question: '', image: 'p.png', options: ['a', 'b'], correct: 0, points: 0 };
  assert.deepEqual(validateSet(ok), []);
  ok.sections[0].questions[0].options = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(validateSet(ok), [{ code: 'bad-options', c: 0, i: 0 }]);
  delete ok.sections[0].questions[0].image;
  assert.deepEqual(validateSet(ok), [{ code: 'no-question', c: 0, i: 0 }, { code: 'bad-options', c: 0, i: 0 }]);
});

test('several right answers: rightSet() reads both kinds, and validation', () => {
  assert.deepEqual(rightSet({ correct: 2 }), [2]);
  assert.deepEqual(rightSet({ correct: [3, 0, 3] }), [0, 3]);
  assert.deepEqual(rightSet({}), []);
  assert.deepEqual(rightSet({ correct: 'x' }), []);
  const set = (correct, options = ['a', 'b', 'c', 'd']) => ({ kind: 'quick', title: 'x', sections: [{ name: 'S', questions: [{ question: 'q', options, correct }] }] });
  assert.deepEqual(validateSet(set(1)), []); // old files: one number
  assert.deepEqual(validateSet(set([1])), []);
  assert.deepEqual(validateSet(set([0, 2])), []);
  assert.deepEqual(validateSet(set([0, 1, 3])), []);
  for (const bad of [[], [0, 4], [1, 1], ['1'], [0.5], null]) assert.deepEqual(validateSet(set(bad)), [{ code: 'bad-correct', c: 0, i: 0 }], JSON.stringify(bad));
  // Not every option may be right (then nobody could be wrong).
  assert.deepEqual(validateSet(set([0, 1, 2, 3])), [{ code: 'all-correct', c: 0, i: 0 }]);
  assert.deepEqual(validateSet(set([0, 1], ['True', 'False'])), [{ code: 'all-correct', c: 0, i: 0 }]);
});

test('several right answers: the store keeps a list (a number when only one), and the marks follow their options', async () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'proquiz-quick-')));
  await store.save('multi', {
    kind: 'quick',
    title: 'Multi',
    sections: [
      {
        name: 'S',
        questions: [
          { question: 'A', options: ['a', '', 'c', 'd'], correct: [3, 0] }, // the empty one goes, the marks move with theirs
          { question: 'B', options: ['a', 'b', 'c'], correct: [1] }, // a list of one is saved as a number
          { question: 'C', options: ['a', '', 'c'], correct: [1, 2] }, // an empty option marked right stays
          { question: 'D', options: ['a', 'b'], correct: [] },
        ],
      },
    ],
  });
  const qs = (await store.get('multi')).set.sections[0].questions;
  assert.deepEqual(qs[0], { question: 'A', options: ['a', 'c', 'd'], correct: [0, 2] });
  assert.deepEqual(qs[1], { question: 'B', options: ['a', 'b', 'c'], correct: 1 });
  assert.deepEqual(qs[2], { question: 'C', options: ['a', '', 'c'], correct: [1, 2] });
  assert.deepEqual(qs[3], { question: 'D', options: ['a', 'b'] });
});

test('several right answers: any right one scores, with speed points, streaks and the fastest title', () => {
  const multi = structuredClone(tiny);
  multi.sections[0].questions[0].correct = [1, 3]; // b and d both count
  let s = opened({ quickStreak: true }, multi);
  s = run(s, answer('g', 3, 2000), answer('r', 1, 3000), answer('b', 0, 2500));
  assert.equal(s.phase, 'result');
  assert.equal(score(s, 'g'), pointsFor(1000, 10, 1000));
  assert.equal(score(s, 'r'), pointsFor(2000, 10, 1000));
  assert.equal(score(s, 'b'), 0);
  assert.deepEqual(s.q.counts, [1, 1, 0, 1]);
  assert.deepEqual([s.teams.find((t) => t.id === 'g').streak, s.teams.find((t) => t.id === 'b').streak], [1, 0]);
  // Every screen gets the right options as a list, from the result on.
  assert.deepEqual(hostView(s).q.correct, [1, 3]);
  assert.deepEqual(hostView(s).q.fastest.id, 'g');
  const tv = displayView(s);
  assert.deepEqual(tv.q.correct, [1, 3]);
  assert.equal(tv.q.fastest.id, 'g');
  assert.deepEqual(phoneView(s, 'b').q.correct, [1, 3]);
  assert.equal(phoneView(s, 'r').q.gained, score(s, 'r'));
  // …but not before.
  const open = opened({}, multi);
  assert.ok(!JSON.stringify(displayView(open)).includes('correct'));
  assert.ok(!JSON.stringify(phoneView(open, 'r')).includes('correct'));
  assert.deepEqual(hostView(open).q.correct, [1, 3]); // the host sees them all along
});

test('a game saved with the right answer as a number still scores after an update', () => {
  let s = opened();
  s = { ...s, q: { ...s.q, correct: 1 } }; // how a running question was saved before lists
  s = run(s, answer('r', 1, 2000), answer('b', 0, 2000), answer('g', 1, 2000));
  assert.equal(s.phase, 'result');
  assert.ok(score(s, 'r') > 0 && score(s, 'g') > 0);
  assert.equal(score(s, 'b'), 0);
  assert.deepEqual(displayView(s).q.correct, [1]);
});

test('the store keeps a quick quiz tidy, lists its kind and finds its files', async () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'proquiz-quick-')));
  const messy = {
    kind: 'quick',
    title: 'Messy',
    extra: 'dropped',
    sections: [
      {
        name: 'S',
        seconds: '15',
        categories: 'dropped',
        questions: [
          { question: 'Q', options: ['a', '', 'c', 'x'.repeat(100)], correct: 2, points: 2000, image: 'p.png', audio: 'c.mp3', audioStart: 2, value: 5, answer: 'no' },
          { question: 'R', options: ['', 'b', ''], correct: 2, points: 1000 },
        ],
      },
    ],
  };
  await store.save('messy', messy);
  const { set } = await store.get('messy');
  assert.deepEqual(set, {
    v: 1,
    kind: 'quick',
    title: 'Messy',
    sections: [
      {
        name: 'S',
        seconds: 15,
        questions: [
          { question: 'Q', options: ['a', 'c', 'x'.repeat(80)], correct: 1, points: 2000, image: 'p.png', audio: 'c.mp3', audioStart: 2 },
          // The empty option marked right stays, so the editor can show the problem.
          { question: 'R', options: ['b', ''], correct: 1 },
        ],
      },
    ],
  });
  assert.deepEqual(filesOf(set).sort(), ['c.mp3', 'p.png']);
  const list = await store.list();
  const quick = list.find((q) => q.id === 'quick-sample');
  assert.equal(quick.kind, 'quick');
  assert.equal(quick.questions, 15);
  assert.equal(quick.problems, 0);
  assert.equal(list.find((q) => q.id === 'lynquiz').kind, 'quick');
  assert.equal(list.find((q) => q.id === 'sample').kind, 'board');
  assert.equal(list.find((q) => q.id === 'messy').questions, 2);
  // An exported quick quiz can be imported again.
  const id = await store.importPackage(await store.exportPackage('quick-sample'));
  assert.deepEqual(validateSet((await store.get(id)).set), []);
});

test('a new game knows its mode, and the quick settings have defaults', () => {
  const s = newGame(tiny);
  assert.equal(s.mode, 'quick');
  assert.deepEqual(s.used, []);
  assert.equal(s.pos, null);
  assert.equal(newGame(board).mode, 'board');
  assert.equal(DEFAULT_SETTINGS.quickReadSeconds, 4);
  assert.equal(DEFAULT_SETTINGS.quickStreak, false);
  assert.equal(DEFAULT_SETTINGS.quickPhoneText, true);
  assert.throws(() => apply(s, { type: 'settings', settings: { quickReadSeconds: 31 } }), { code: 'bad-settings' });
  assert.throws(() => apply(s, { type: 'settings', settings: { quickReadSeconds: -1 } }), { code: 'bad-settings' });
  const t = apply(s, { type: 'settings', settings: { quickReadSeconds: 0, quickStreak: 1, quickPhoneText: 'yes' } });
  assert.deepEqual([t.settings.quickReadSeconds, t.settings.quickStreak, t.settings.quickPhoneText], [0, true, true]);
  // A game saved before these settings existed can still change its settings.
  const { quickReadSeconds, ...old } = s.settings;
  assert.equal(apply({ ...s, settings: old }, { type: 'settings', settings: { sound: false } }).settings.quickReadSeconds, 4);
});

test('joining a quick quiz: up to 30 players, colours may repeat, names may not', () => {
  let s = newGame(tiny);
  for (let n = 0; n < MAX_PLAYERS; n++) s = apply(s, { type: 'join', teamId: `p${n}`, name: `P${n}`, color: COLORS[0] });
  assert.equal(s.teams.length, 30);
  assert.throws(() => apply(s, { type: 'join', teamId: 'late', name: 'Late', color: COLORS[1] }), { code: 'full-players' });
  assert.throws(() => apply(newGame(tiny, {}), { type: 'join', teamId: 'x', name: 'X', color: '#123456' }), { code: 'bad-color' });
  const two = run(newGame(tiny), { type: 'join', teamId: 'a', name: 'Ann', color: COLORS[0] });
  assert.throws(() => apply(two, { type: 'join', teamId: 'b', name: 'ann', color: COLORS[0] }), { code: 'name-taken' });
  // A board quiz still wants its own colour per team.
  const b = run(newGame(board), { type: 'join', teamId: 'a', name: 'Ann', color: COLORS[0] });
  assert.throws(() => apply(b, { type: 'join', teamId: 'b', name: 'Bo', color: COLORS[0] }), { code: 'color-taken' });
});

test('choosing a board quiz with too many players is refused; shared colours are sorted out', () => {
  let s = newGame(tiny);
  for (let n = 0; n <= MAX_TEAMS; n++) s = apply(s, { type: 'join', teamId: `p${n}`, name: `P${n}`, color: COLORS[0] });
  assert.throws(() => apply(s, { type: 'loadSet', set: board, setId: 'sample' }), { code: 'too-many-teams' });
  s = apply(s, { type: 'removeTeam', teamId: 'p0' });
  const b = apply(s, { type: 'loadSet', set: board, setId: 'sample' });
  assert.equal(b.mode, 'board');
  assert.equal(new Set(b.teams.map((t) => t.color)).size, MAX_TEAMS);
  assert.equal(b.teams[0].color, COLORS[0]);
  assert.equal(b.used.length, board.categories.length);
  // And back: a quick quiz from a board lobby.
  const q = apply(b, { type: 'loadSet', set: tiny, setId: 'tiny' });
  assert.equal(q.mode, 'quick');
  assert.deepEqual(q.used, []);
});

test('a whole quick quiz: section, ready, open, answers, result, top 5, next section, podium', () => {
  let s = started({ quickReadSeconds: 4 });
  assert.equal(s.phase, 'section');
  assert.deepEqual(s.pos, { s: 0, i: 0 });
  assert.equal(s.event.type, 'section');
  assert.ok(s.teams.every((t) => t.score === 0 && t.streak === 0));

  // Space shows the question; after the read time the answers appear by themselves.
  s = apply(s, { type: 'next', now: 0 });
  assert.equal(s.phase, 'ready');
  assert.equal(s.deadline, 4000);
  assert.equal(apply(s, { type: 'timeout', now: 3999 }), s);
  assert.equal(apply(s, answer('r', 1, 100)), s, 'no answering before the answers appear');
  s = apply(s, { type: 'timeout', now: 4000 });
  assert.equal(s.phase, 'open');
  assert.equal(s.event.type, 'quickOpen');
  assert.equal(s.q.openedAt, 4000);
  assert.equal(s.deadline, 4000 + 10_000);

  // Red right at once, Blue wrong; Green never answers and the clock runs out.
  s = run(s, answer('r', 1, 4000), answer('b', 0, 6000));
  assert.equal(s.phase, 'open');
  s = apply(s, { type: 'timeout', now: 14_000 });
  assert.equal(s.phase, 'result');
  assert.equal(s.event.type, 'quickResult');
  assert.equal(score(s, 'r'), 1000);
  assert.equal(score(s, 'b'), 0);
  assert.deepEqual(s.q.counts, [1, 1, 0, 0]);
  assert.deepEqual(s.q.gained, { r: 1000, b: 0, g: 0 });
  assert.deepEqual(s.teams.map((t) => t.streak), [1, 0, 0]);

  s = apply(s, { type: 'next', now: 15_000 });
  assert.equal(s.phase, 'ranks');
  assert.equal(s.event.type, 'ranks');

  // Next question (a 20-second one); everybody answers, so it closes at once.
  s = run(s, { type: 'next', now: 16_000 }, { type: 'next', now: 17_000 });
  assert.deepEqual(s.pos, { s: 0, i: 1 });
  assert.equal(s.phase, 'open');
  s = run(s, answer('g', 0, 17_000), answer('r', 0, 27_000), answer('b', 1, 28_000));
  assert.equal(s.phase, 'result');
  assert.equal(score(s, 'g'), 1000);
  assert.equal(score(s, 'r'), 1000 + 750); // half the time gone: 750
  assert.equal(s.deadline, null);

  // The section is over: the next section's title card, then its one question, then the podium.
  s = run(s, { type: 'next', now: 30_000 }, { type: 'next', now: 31_000 });
  assert.equal(s.phase, 'section');
  assert.deepEqual(s.pos, { s: 1, i: 0 });
  assert.deepEqual(s.event, { seq: s.seq, type: 'section', s: 1 });
  s = run(s, { type: 'next', now: 32_000 }, { type: 'next', now: 33_000 });
  assert.equal(s.q.seconds, 20, 'no seconds anywhere: 20');
  assert.equal(s.q.points, 2000);
  s = run(s, answer('b', 2, 34_000), { type: 'next', now: 34_500 });
  assert.equal(s.phase, 'result', 'the host can stop the clock early');
  assert.equal(score(s, 'b'), 2000 - Math.round(2000 * (1000 / 20_000) / 2));
  s = run(s, { type: 'next', now: 35_000 }, { type: 'next', now: 36_000 });
  assert.equal(s.phase, 'over');
  assert.equal(s.event.type, 'over');
  assert.equal(apply(s, { type: 'next', now: 37_000 }), s);
});

test('with no read time the answers wait for Space', () => {
  let s = run(started({ quickReadSeconds: 0 }), { type: 'next', now: 0 });
  assert.equal(s.phase, 'ready');
  assert.equal(s.deadline, null);
  s = apply(s, { type: 'next', now: 500 });
  assert.equal(s.phase, 'open');
  assert.equal(s.q.openedAt, 500);
});

test('pointsFor: faster is more, double, no points, streak bonus', () => {
  assert.equal(pointsFor(0, 20, 1000), 1000);
  assert.equal(pointsFor(10_000, 20, 1000), 750);
  assert.equal(pointsFor(19_999, 20, 1000), 500);
  assert.equal(pointsFor(20_000, 20, 1000), 500);
  assert.equal(pointsFor(99_000, 20, 1000), 500, 'never below half');
  assert.equal(pointsFor(-50, 20, 1000), 1000, 'never above the base');
  assert.equal(pointsFor(0, 20, 2000), 2000);
  assert.equal(pointsFor(10_000, 20, 2000), 1500);
  assert.equal(pointsFor(0, 20, 0), 0);
  assert.equal(pointsFor(0, 20, 0, 4, true), 0, 'no points means no bonus either');
  assert.equal(pointsFor(0, 0, 1000), 1000, 'no timer');
  assert.equal(pointsFor(0, 20, 1000, 3), 1000, 'the bonus only with the setting on');
  assert.equal(pointsFor(0, 20, 1000, 0, true), 1000);
  assert.equal(pointsFor(0, 20, 1000, 1, true), 1100);
  assert.equal(pointsFor(0, 20, 1000, 5, true), 1500);
  assert.equal(pointsFor(0, 20, 1000, 9, true), 1500, 'at most +500');
});

test('the streak bonus and a no-points question', () => {
  const set = structuredClone(tiny);
  set.sections[0].questions.push({ question: 'q-survey', options: ['a', 'b'], correct: 0, points: 0 });
  set.sections[0].questions.push({ question: 'q4', options: ['a', 'b'], correct: 0 });
  let s = opened({ quickStreak: true }, set);
  s = run(s, answer('r', 1, 1000), answer('b', 1, 1000), answer('g', 0, 1000));
  assert.deepEqual(s.teams.map((t) => [t.score, t.streak]), [[1000, 1], [1000, 1], [0, 0]]);
  // Second in a row: +100. Blue misses it (no answer) and loses the streak.
  s = run(s, { type: 'next', now: 2000 }, { type: 'next', now: 3000 }, { type: 'next', now: 4000 });
  s = run(s, answer('r', 0, 4000), answer('g', 0, 4000), { type: 'timeout', now: 24_000 });
  assert.deepEqual(s.teams.map((t) => [t.score, t.streak]), [[2100, 2], [1000, 0], [1000, 1]]);
  // A no-points question: nobody scores and streaks stay.
  s = run(s, { type: 'next', now: 25_000 }, { type: 'next', now: 26_000 }, { type: 'next', now: 27_000 });
  s = run(s, answer('r', 1, 27_000), answer('b', 0, 27_000), answer('g', 0, 27_000));
  assert.equal(s.phase, 'result');
  assert.deepEqual(s.teams.map((t) => [t.score, t.streak]), [[2100, 2], [1000, 0], [1000, 1]]);
  assert.deepEqual(s.q.counts, [2, 1]);
  // And on: Red's third in a row.
  s = run(s, { type: 'next', now: 28_000 }, { type: 'next', now: 29_000 }, { type: 'next', now: 30_000 });
  s = apply(s, answer('r', 0, 30_000));
  s = apply(s, { type: 'next', now: 31_000 });
  assert.equal(score(s, 'r'), 2100 + 1200);
});

test('one answer per player, only real options, only players', () => {
  let s = opened();
  s = apply(s, answer('r', 0, 1500));
  assert.equal(apply(s, answer('r', 1, 1600)), s, 'a second press is ignored');
  assert.equal(apply(s, answer('b', 4, 1600)), s, 'no fifth option');
  assert.equal(apply(s, answer('b', -1, 1600)), s);
  assert.equal(apply(s, answer('b', '1', 1600)), s);
  assert.equal(apply(s, answer('nobody', 1, 1600)), s);
  assert.deepEqual(s.q.answers, { r: { option: 0, at: 1500 } });
});

test('answer timing: the press time counts, within the measured slack, never before the answers appeared', () => {
  let s = opened(); // answers open at 1000
  // Pressed at 1100, arrived at 1300 with 250 ms of slack: counts as 1100.
  s = apply(s, answer('r', 1, 1300, { at: 1100, slack: 250 }));
  assert.equal(s.q.answers.r.at, 1100);
  // A claim earlier than the slack allows is cut to arrival − slack.
  s = apply(s, answer('b', 1, 2000, { at: 0, slack: 100 }));
  assert.equal(s.q.answers.b.at, 1900);
  // A press before the answers appeared counts as the moment they appeared; slack is capped.
  s = apply(s, answer('g', 1, 1200, { at: 500, slack: 9999 }));
  assert.equal(s.q.answers.g.at, 1000);
  assert.equal(s.phase, 'result');
  assert.equal(score(s, 'g'), 1000);
  assert.equal(score(s, 'r'), pointsFor(100, 10, 1000));
  // A press "after" its arrival counts as the arrival; no measurement means the arrival counts.
  let t = opened();
  t = run(t, answer('r', 1, 2000, { at: 5000, slack: 50 }), answer('b', 1, 3000));
  assert.deepEqual([t.q.answers.r.at, t.q.answers.b.at], [2000, 3000]);
});

test('answer timing over the internet: half the round trip is taken off, and a press after time ran out is refused', () => {
  let s = opened(); // answers open at 1000, 10 s to answer
  // The answers reached a far-away phone 200 ms late (round trip 400): pressed at 1600, counts as 1400.
  s = apply(s, answer('r', 1, 1900, { at: 1600, slack: 405, lead: 200 }));
  assert.equal(s.q.answers.r.at, 1400);
  // Never before the answers appeared, and the lead is capped (at half the largest slack, 300).
  s = apply(s, answer('b', 1, 1300, { at: 1100, slack: 405, lead: 9999 }));
  assert.equal(s.q.answers.b.at, 1000);
  // Pressed after the time was up (the answer was still on its way): doesn't count.
  const late = apply(s, answer('g', 1, 11_200, { at: 11_050, slack: 405, lead: 200 }));
  assert.equal(late, s);
  // Pressed just before the end, arriving just after: counts.
  s = apply(s, answer('g', 1, 11_200, { at: 10_950, slack: 405, lead: 200 }));
  assert.equal(s.q.answers.g.at, 10_750);
  assert.equal(s.phase, 'result');
});

test('a player who leaves loses their answer, and the others can still finish early', () => {
  let s = opened();
  s = run(s, answer('r', 1, 1500), answer('b', 1, 1500));
  s = apply(s, { type: 'removeTeam', teamId: 'r' });
  assert.deepEqual(Object.keys(s.q.answers), ['b']);
  assert.equal(s.phase, 'open');
  s = apply(s, answer('g', 1, 1600));
  assert.equal(s.phase, 'result');
  assert.deepEqual(s.q.counts, [0, 2, 0, 0]);
  assert.equal(apply(s, { type: 'removeTeam', teamId: 'nobody' }), s);
});

test('undo after the result gives the points back and reopens the question with a fresh clock', () => {
  let s = opened({ quickStreak: true });
  s = run(s, answer('r', 1, 1000), answer('b', 1, 2000), answer('g', 1, 3000));
  assert.equal(s.phase, 'result');
  assert.equal(score(s, 'r'), 1000);
  const u = apply(s, { type: 'undo', now: 50_000 });
  assert.equal(u.phase, 'open');
  assert.deepEqual(u.q.answers, {});
  assert.equal(u.q.openedAt, 50_000);
  assert.equal(u.deadline, 60_000);
  assert.deepEqual(u.teams.map((t) => [t.score, t.streak]), [[0, 0], [0, 0], [0, 0]]);
  assert.equal(u.event.type, 'undo');
  // Answering again scores once.
  const again = run(u, answer('r', 1, 50_000), answer('b', 0, 50_000), answer('g', 0, 50_000));
  assert.equal(score(again, 'r'), 1000);
  // Undo from the top 5 goes back to the result, and undo from "get ready" restarts its read time.
  const ranks = apply(s, { type: 'next', now: 4000 });
  assert.equal(apply(ranks, { type: 'undo', now: 5000 }).phase, 'result');
  const open = run(ranks, { type: 'next', now: 6000 }, { type: 'next', now: 6500 });
  assert.equal(open.phase, 'open');
  const back = apply(open, { type: 'undo', now: 7000 });
  assert.equal(back.phase, 'ready');
  assert.equal(back.deadline, 7000 + 4000);
});

test('skip drops the question (nobody scores) and goes on', () => {
  let s = opened();
  s = apply(s, answer('r', 1, 1500));
  s = apply(s, { type: 'skip', now: 2000 });
  assert.equal(s.phase, 'ready');
  assert.deepEqual(s.pos, { s: 0, i: 1 });
  assert.equal(score(s, 'r'), 0);
  assert.deepEqual(s.q.answers, {});
  // Skipping the last question of a section goes to the next section's card, and from "get ready" too.
  s = apply(s, { type: 'skip', now: 3000 });
  assert.equal(s.phase, 'section');
  assert.deepEqual(s.pos, { s: 1, i: 0 });
  assert.equal(apply(s, { type: 'skip', now: 3000 }), s, 'nothing to skip on a title card');
  s = run(s, { type: 'next', now: 4000 }, { type: 'skip', now: 5000 });
  assert.equal(s.phase, 'over');
  // Undo brings the skipped question back.
  assert.equal(apply(s, { type: 'undo', now: 6000 }).phase, 'ready');
});

test('board actions do nothing in a quick quiz, and quick actions nothing on a board', () => {
  const s = opened();
  for (const a of [{ type: 'pick', c: 0, i: 0 }, { type: 'arm', now: 1 }, { type: 'buzz', teamId: 'r', now: 1 }, { type: 'correct' }, { type: 'wrong', now: 1 },
    { type: 'reveal' }, { type: 'cancel' }, { type: 'end' }, { type: 'setPicker', teamId: 'b' }, { type: 'wager', teamId: 'r', amount: 0 }]) {
    assert.equal(apply(s, a), s, a.type);
  }
  assert.throws(() => apply(s, { type: 'nonsense' }), { code: 'unknown-action' });
  const b = run(newGame(board), { type: 'join', teamId: 'r', name: 'Red', color: COLORS[0] }, { type: 'start', picker: 'r' });
  assert.equal(apply(b, answer('r', 0, 1)), b);
  assert.equal(apply(b, { type: 'skip', now: 1 }), b);
  assert.equal(phoneView(b, 'r').mode, 'board');
  // A host's score fix works in both.
  assert.equal(score(apply(s, { type: 'adjust', teamId: 'g', delta: 300 }), 'g'), 300);
});

test('the clip starts with the question, plays while answering and stops at the result', () => {
  let s = run(started(), { type: 'next', now: 0 }, { type: 'next', now: 1000 }, answer('r', 0, 1000), answer('b', 0, 1000), answer('g', 0, 1000));
  s = apply(s, { type: 'next', now: 2000 }); // ranks
  assert.equal(s.media, null);
  s = apply(s, { type: 'next', now: 3000 }); // ready: question 2 has a clip
  assert.deepEqual(clipFor(s), { file: 'clip.mp3', start: 3 });
  assert.deepEqual(s.media, { playing: true, seq: 0 });
  assert.deepEqual(hostView(s).clip, { file: 'clip.mp3', start: 3 });
  assert.deepEqual(displayView(s).clip, { file: 'clip.mp3', start: 3 });
  s = apply(s, { type: 'next', now: 4000 }); // open
  assert.equal(s.media.playing, true);
  s = apply(s, { type: 'mediaRestart' });
  assert.equal(s.media.seq, 1);
  s = apply(s, { type: 'next', now: 5000 }); // result
  assert.equal(s.media.playing, false);
  s = apply(s, { type: 'next', now: 6000 }); // ranks
  assert.equal(s.media, null);
  assert.equal(clipFor(s), null);
});

test('views: the host sees everything, the TV not the right answer too soon, phones no texts unless allowed', () => {
  let s = run(started({ quickPhoneText: false }), { type: 'next', now: 0 });
  // Get ready: the TV has the question but no options yet; phones have neither.
  let tv = displayView(s);
  assert.equal(tv.mode, 'quick');
  assert.equal(tv.q.question, 'q1');
  assert.equal(tv.q.options, undefined);
  assert.equal(tv.q.correct, undefined);
  assert.equal(tv.set.categories, undefined);
  assert.deepEqual(tv.set.sections, [{ name: 'One', n: 2 }, { name: 'Two', n: 1 }]);
  assert.deepEqual(tv.set.preload, [{ audio: 'clip.mp3' }]);
  assert.ok(!JSON.stringify(tv).includes('q2'), 'no questions ahead of time');
  let ph = phoneView(s, 'r');
  assert.equal(ph.mode, 'quick');
  assert.equal(ph.status, 'ready');
  assert.deepEqual(ph.q, { n: 4, seconds: 10, points: 1000, mine: null });

  // Open: options on the TV, still no right answer; the count of answers goes up.
  s = run(s, { type: 'next', now: 1000 }, answer('r', 1, 1500));
  tv = displayView(s);
  assert.deepEqual(tv.q.options, ['a', 'b', 'c', 'd']);
  assert.equal(tv.q.correct, undefined);
  assert.equal(tv.q.counts, undefined);
  assert.deepEqual([tv.q.answered, tv.q.total], [1, 3]);
  assert.equal(tv.q.answers, undefined);
  assert.ok(!JSON.stringify(tv).includes('correct'), 'no `correct` anywhere on the TV yet');
  assert.equal(phoneView(s, 'r').status, 'answered');
  assert.equal(phoneView(s, 'r').q.mine, 1);
  assert.equal(phoneView(s, 'b').status, 'answer');
  assert.equal(phoneView(s, 'b').q.mine, null);
  for (const id of ['r', 'b']) {
    const json = JSON.stringify(phoneView(s, id));
    for (const secret of ['q1', '"a"', 'correct', 'clip.mp3', 'answers']) assert.ok(!json.includes(secret), `${id}: ${secret}`);
  }
  const host = hostView(s);
  assert.deepEqual(host.q.correct, [1]); // always a list of the right options
  assert.deepEqual(host.q.answers, { r: { option: 1, at: 1500 } });
  assert.equal(host.set.sections[0].questions[0].question, 'q1');
  assert.equal(host.canUndo, true);
  assert.equal(host.history, undefined);

  // With the setting on, phones get the texts (the options only once they're open).
  const withText = run(started({ quickPhoneText: true }), { type: 'next', now: 0 });
  assert.equal(phoneView(withText, 'r').q.question, 'q1');
  assert.equal(phoneView(withText, 'r').q.options, undefined);
  const openText = apply(withText, { type: 'next', now: 1000 });
  assert.deepEqual(phoneView(openText, 'r').q.options, ['a', 'b', 'c', 'd']);
  assert.equal(phoneView(openText, 'r').q.correct, undefined);
  assert.equal(phoneView(openText, 'r').settings.quickPhoneText, true);

  // Result: the right answer and the counts everywhere; each phone its own points.
  s = run(s, answer('b', 0, 2000), answer('g', 1, 11_000));
  tv = displayView(s);
  assert.deepEqual(tv.q.correct, [1]);
  assert.deepEqual(tv.q.counts, [1, 2, 0, 0]);
  ph = phoneView(s, 'r');
  assert.equal(ph.status, 'result');
  assert.deepEqual([ph.q.correct, ph.q.mine, ph.q.gained], [[1], 1, 975]);
  assert.equal(phoneView(s, 'b').q.gained, 0);
  assert.deepEqual([ph.rank, ph.rankBefore, ph.total], [1, null, 3]); // everyone shared 1st before
  assert.deepEqual(ph.you, { id: 'r', name: 'Red', color: COLORS[0], score: 975, streak: 1 });

  // Top 5: everyone was 1st before (no points yet), so nobody has really moved: no arrows.
  s = apply(s, { type: 'next', now: 12_000 });
  tv = displayView(s);
  assert.equal(tv.ranks.total, 3);
  assert.deepEqual(
    tv.ranks.top.map((r) => [r.id, r.rank, r.delta, r.move]),
    [['r', 1, 975, 'same'], ['g', 2, 500, 'same'], ['b', 3, 0, 'same']],
  );
  assert.equal(phoneView(s, 'g').rankBefore, null);
  assert.equal(tv.standings, undefined);
  assert.equal(phoneView(s, 'b').status, 'ranks');
  assert.equal(phoneView(s, 'b').rank, 3);
  assert.equal(phoneView(s, 'nobody').status, 'unknown');
  assert.equal(phoneView(s, 'nobody').you, null);
});

test('the leaderboard shows five, the title card and the podium everyone', () => {
  let s = newGame(tiny);
  for (let n = 0; n < 7; n++) s = apply(s, { type: 'join', teamId: `p${n}`, name: `P${n}`, color: COLORS[n % 3] });
  s = run(s, { type: 'start' }, { type: 'next', now: 0 }, { type: 'next', now: 1000 });
  // Players answer right one after another, so the later they join the fewer points they get.
  for (let n = 6; n >= 0; n--) s = apply(s, answer(`p${n}`, 1, 1000 + (6 - n) * 1000));
  s = apply(s, { type: 'next', now: 9000 });
  const tv = displayView(s);
  assert.deepEqual(tv.ranks.top.map((r) => r.id), ['p6', 'p5', 'p4', 'p3', 'p2']);
  assert.equal(tv.ranks.total, 7);
  assert.deepEqual(tv.ranks.top.map((r) => r.move), ['same', 'same', 'same', 'same', 'same']); // nobody had points before
  assert.equal(hostView(s).standings.length, 7);
  // Skip to the next section's card: everyone's standing is on it.
  s = run(s, { type: 'next', now: 10_000 }, { type: 'skip', now: 11_000 });
  assert.equal(s.phase, 'section');
  assert.equal(displayView(s).standings.length, 7);
  assert.equal(displayView(s).ranks.top.length, 5);
  assert.equal(displayView(s).q, null);
});

test('the top 5 knows how it stood before the question, so the TV can animate the change', () => {
  let s = newGame(tiny);
  for (let n = 0; n < 7; n++) s = apply(s, { type: 'join', teamId: `p${n}`, name: `P${n}`, color: COLORS[n % 3] });
  s = run(s, { type: 'start' }, { type: 'next', now: 0 }, { type: 'next', now: 1000 });
  for (let n = 6; n >= 0; n--) s = apply(s, answer(`p${n}`, 1, 1000 + (6 - n) * 1000));
  s = apply(s, { type: 'next', now: 9000 });
  // Question 1: everyone had 0 before, in the order they joined.
  let before = displayView(s).ranks.before;
  assert.deepEqual(before.map((r) => r.id), ['p0', 'p1', 'p2', 'p3', 'p4']);
  assert.ok(before.every((r) => r.score === 0 && r.rank === 1));
  const after1 = Object.fromEntries(s.teams.map((t) => [t.id, t.score]));
  // Question 2: the two at the bottom answer right, the others wrong; someone joins while it is open.
  s = run(s, { type: 'next', now: 10_000 }, { type: 'next', now: 11_000 }, { type: 'join', teamId: 'late', name: 'Late', color: COLORS[3] });
  s = run(s, answer('p0', 0, 11_000), answer('p1', 0, 11_100));
  for (let n = 2; n < 7; n++) s = apply(s, answer(`p${n}`, 1, 12_000));
  s = run(s, { type: 'next', now: 31_000 });
  if (s.phase === 'result') s = apply(s, { type: 'next', now: 32_000 });
  assert.equal(s.phase, 'ranks');
  const tv = displayView(s);
  before = tv.ranks.before;
  assert.equal(before.length, 5);
  assert.deepEqual(before.map((r) => r.id), ['p6', 'p5', 'p4', 'p3', 'p2']); // the old order
  for (const r of before) assert.equal(r.score, after1[r.id]); // the old scores
  assert.deepEqual(before.map((r) => r.rank), [1, 2, 3, 4, 5]);
  assert.ok(!before.some((r) => r.id === 'late'));
  assert.deepEqual(tv.ranks.top.slice(0, 2).map((r) => r.id).sort(), ['p0', 'p1']); // climbed in
  assert.ok(!tv.ranks.top.some((r) => r.id === 'p2')); // p2 (and p3) fell out: in before, not in top
  assert.deepEqual(hostView(s).ranks.before, before);
  // Only on the top 5 itself.
  s = apply(s, { type: 'next', now: 40_000 });
  assert.equal(displayView(s).ranks?.before, undefined);
});

test('resumeFix: a question that was showing starts again from "get ready"', () => {
  let s = opened();
  s = apply(s, answer('r', 1, 1500));
  const fixed = resumeFix(s, 100_000);
  assert.equal(fixed.phase, 'ready');
  assert.deepEqual(fixed.q.answers, {});
  assert.equal(fixed.q.openedAt, null);
  assert.equal(fixed.deadline, 104_000);
  assert.equal(s.phase, 'open', 'the old state is untouched');
  // It opens normally again.
  assert.equal(apply(fixed, { type: 'timeout', now: 104_000 }).phase, 'open');
  // Anything else stays as it was.
  const result = run(s, answer('b', 1, 1600), answer('g', 1, 1700));
  assert.equal(resumeFix(result, 1), result);
  const b = newGame(board);
  assert.equal(resumeFix(b, 1), b);
});

test('restart puts everyone back to zero and the quiz back to the lobby', () => {
  let s = opened();
  s = run(s, answer('r', 1, 1000), answer('b', 1, 1000), answer('g', 1, 1000));
  s = apply(s, { type: 'restart' });
  assert.equal(s.phase, 'lobby');
  assert.equal(s.pos, null);
  assert.equal(s.q, null);
  assert.ok(s.teams.every((t) => t.score === 0 && !('streak' in t)));
  assert.equal(apply(s, { type: 'start' }).phase, 'section');
});

test('a player joining during a question can still answer, and shows as new on the leaderboard', () => {
  let s = opened();
  s = apply(s, { type: 'join', teamId: 'late', name: 'Late', color: COLORS[0] });
  s = run(s, answer('late', 1, 1000), answer('r', 0, 1000), answer('b', 0, 1000), answer('g', 0, 1000));
  assert.equal(s.phase, 'result');
  s = apply(s, { type: 'next', now: 2000 });
  const late = displayView(s).ranks.top.find((r) => r.id === 'late');
  assert.deepEqual([late.rank, late.move, late.delta], [1, 'new', 1000]);
});

test('the fastest right answer gets a title: earliest press, then the lowest id; nobody right, nobody', () => {
  // r answers wrong first, g and b right at the same moment: b wins on the id.
  let s = run(opened(), answer('r', 0, 1100), answer('g', 1, 3300), answer('b', 1, 3300));
  assert.equal(s.phase, 'result');
  const fastest = { id: 'b', name: 'Blue', color: COLORS[0], ms: 2300 };
  assert.deepEqual(displayView(s).q.fastest, fastest);
  assert.deepEqual(hostView(s).q.fastest, fastest);
  assert.equal(phoneView(s, 'b').q.fastest, true);
  assert.equal(phoneView(s, 'g').q.fastest, false);
  assert.equal(phoneView(s, 'r').q.fastest, false);
  // Still there on the top 5, and never before the result.
  assert.deepEqual(displayView(apply(s, { type: 'next', now: 5000 })).q.fastest, fastest);
  const open = run(opened(), answer('g', 1, 1200));
  assert.equal(displayView(open).q.fastest, undefined);
  assert.equal(hostView(open).q.fastest, null);
  assert.equal(phoneView(open, 'g').q.fastest, undefined);
  // An earlier press wins even when it arrives later (fair timing).
  s = run(opened(), answer('g', 1, 3000, { at: 2000, slack: 200 }), answer('r', 1, 2900));
  s = apply(s, { type: 'timeout', now: 20_000 });
  assert.equal(displayView(s).q.fastest.id, 'g'); // g's press counts as 2800 (3000 − 200), before r's 2900
  // Nobody right: no title.
  s = run(opened(), answer('r', 0, 1100), answer('g', 2, 1200), answer('b', 3, 1300));
  assert.equal(displayView(s).q.fastest, null);
  assert.equal(phoneView(s, 'r').q.fastest, false);
});

test('each phone knows the player just above it, or the leader the one just below', () => {
  let s = run(opened(), answer('r', 1, 1000), answer('g', 1, 6000), answer('b', 0, 1200)); // r 1000, g 750, b 0
  s = apply(s, { type: 'next', now: 12_000 });
  assert.deepEqual(phoneView(s, 'r').ahead, { name: 'Green', color: COLORS[2], gap: 250 });
  assert.equal(phoneView(s, 'r').behind, undefined);
  assert.deepEqual(phoneView(s, 'g').behind, { name: 'Red', color: COLORS[0], gap: 250 });
  assert.deepEqual(phoneView(s, 'b').behind, { name: 'Green', color: COLORS[2], gap: 750 });
  // Level with the one above: a gap of 0.
  s = apply(s, { type: 'adjust', teamId: 'b', delta: 1000 });
  assert.deepEqual(phoneView(s, 'b').behind.gap, 0);
  // Alone in the game: nobody to compare with.
  const solo = run(newGame(tiny), { type: 'join', teamId: 'x', name: 'X', color: COLORS[0] }, { type: 'start' });
  assert.equal(phoneView(solo, 'x').behind, undefined);
  assert.equal(phoneView(solo, 'x').ahead, undefined);
});
