import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { apply, newGame, COLORS, MAX_TEAMS, displayView, phoneView, hostView, GameError } from '../lib/game.js';
import { validateSet } from '../lib/validate.js';

const sample = JSON.parse(readFileSync(new URL('../sets/sample.json', import.meta.url)));

// Tiny set: 2 categories × 2 questions, with a final.
const small = {
  v: 1,
  title: 'Small',
  categories: [
    { name: 'A', questions: [{ value: 100, question: 'a1', answer: 'A1' }, { value: 200, question: 'a2', answer: 'A2' }] },
    { name: 'B', questions: [{ value: 100, question: 'b1', answer: 'B1' }, { value: 200, question: 'b2', answer: 'B2' }] },
  ],
  final: { category: 'F', question: 'fq', answer: 'FA' },
};

function run(state, ...actions) {
  return actions.reduce(apply, state);
}

// A game on the board with teams r, b, g; r picks first.
function started(settings = {}, set = small) {
  return run(
    newGame(set, settings),
    { type: 'join', teamId: 'r', name: 'Red', color: COLORS[0] },
    { type: 'join', teamId: 'b', name: 'Blue', color: COLORS[1] },
    { type: 'join', teamId: 'g', name: 'Green', color: COLORS[2] },
    { type: 'start', picker: 'r' },
  );
}

const score = (s, id) => s.teams.find((t) => t.id === id).score;
const armedAt = (s, c = 0, i = 1, now = 1000) => run(s, { type: 'pick', c, i }, { type: 'arm', now });

test('the sample set is valid', () => {
  assert.deepEqual(validateSet(sample), []);
  assert.deepEqual(validateSet(small), []);
});

test('validateSet reports missing parts', () => {
  const bad = structuredClone(small);
  bad.title = ' ';
  bad.categories[1].questions[0].answer = '';
  bad.categories[0].questions[1].value = -5;
  bad.final.question = '';
  assert.deepEqual(validateSet(bad), [
    { code: 'no-title' },
    { code: 'bad-value', c: 0, i: 1 },
    { code: 'no-answer', c: 1, i: 0 },
    { code: 'no-final-question' },
  ]);
  assert.deepEqual(validateSet({ title: 'x', categories: [] }), [{ code: 'no-categories' }]);
  assert.deepEqual(validateSet(null), [{ code: 'not-a-set' }]);
});

test('joining: names and colours must be unique, max teams', () => {
  let s = newGame(small);
  s = apply(s, { type: 'join', teamId: 'r', name: '  Red   Team ', color: COLORS[0] });
  assert.equal(s.teams[0].name, 'Red Team');
  assert.throws(() => apply(s, { type: 'join', teamId: 'x', name: 'red team', color: COLORS[1] }), { code: 'name-taken' });
  assert.throws(() => apply(s, { type: 'join', teamId: 'x', name: 'Other', color: COLORS[0] }), { code: 'color-taken' });
  assert.throws(() => apply(s, { type: 'join', teamId: 'x', name: '', color: COLORS[1] }), { code: 'bad-name' });
  assert.throws(() => apply(s, { type: 'join', teamId: 'x', name: 'x'.repeat(21), color: COLORS[1] }), { code: 'bad-name' });
  assert.throws(() => apply(s, { type: 'join', teamId: 'x', name: 'Other', color: '#000' }), { code: 'bad-color' });

  // Re-joining with the same id updates the team instead of adding one.
  s = apply(s, { type: 'join', teamId: 'r', name: 'Red', color: COLORS[3] });
  assert.equal(s.teams.length, 1);
  assert.equal(s.teams[0].color, COLORS[3]);

  for (let n = 1; n < MAX_TEAMS; n++) s = apply(s, { type: 'join', teamId: `t${n}`, name: `T${n}`, color: COLORS[(n + 3) % MAX_TEAMS] });
  assert.equal(s.teams.length, MAX_TEAMS);
  assert.throws(() => apply(s, { type: 'join', teamId: 'late', name: 'Late', color: COLORS[0] }), { code: 'full' });
});

test('apply never changes the state it was given', () => {
  const s = started();
  const copy = structuredClone(s);
  apply(s, { type: 'pick', c: 0, i: 0 });
  assert.deepEqual(s, copy);
});

test('start needs at least one team and goes to the board', () => {
  assert.equal(apply(newGame(small), { type: 'start' }).phase, 'lobby');
  const s = started();
  assert.equal(s.phase, 'board');
  assert.equal(s.picker, 'r');
});

test('a correct answer scores the value and makes that team the picker', () => {
  let s = armedAt(started());
  assert.equal(s.phase, 'armed');
  assert.equal(s.deadline, 1000 + 10_000);
  s = apply(s, { type: 'buzz', teamId: 'b', now: 1200 });
  assert.equal(s.phase, 'answering');
  assert.equal(s.q.buzzedTeam, 'b');
  assert.equal(s.deadline, 1200 + 15_000);
  assert.equal(s.event.type, 'buzz');
  s = apply(s, { type: 'correct' });
  assert.equal(score(s, 'b'), 200);
  assert.equal(s.picker, 'b');
  assert.equal(s.phase, 'revealed');
  assert.deepEqual(s.q.result, { type: 'correct', teamId: 'b' });
  s = apply(s, { type: 'next', now: 2000 });
  assert.equal(s.phase, 'board');
  assert.equal(s.used[0][1], true);
});

test('only the first buzz counts; later buzzes are recorded for the host', () => {
  let s = armedAt(started());
  s = apply(s, { type: 'buzz', teamId: 'g', now: 1100 });
  s = apply(s, { type: 'buzz', teamId: 'r', now: 1138 });
  s = apply(s, { type: 'buzz', teamId: 'g', now: 1140 }); // double tap is ignored
  assert.equal(s.q.buzzedTeam, 'g');
  assert.deepEqual(s.q.buzzes, [
    { teamId: 'g', at: 1100 },
    { teamId: 'r', at: 1138 },
  ]);
});

test('buzzes before arming lock that team for a moment', () => {
  let s = run(started(), { type: 'pick', c: 0, i: 0 });
  s = apply(s, { type: 'buzz', teamId: 'r', now: 900 });
  assert.equal(s.phase, 'reading');
  assert.equal(s.event.type, 'early');
  s = apply(s, { type: 'arm', now: 1000 });
  assert.equal(apply(s, { type: 'buzz', teamId: 'r', now: 1300 }).phase, 'armed'); // still locked until 1400
  assert.equal(apply(s, { type: 'buzz', teamId: 'r', now: 1400 }).q.buzzedTeam, 'r');
  // With earlyLockMs 0 early buzzes are simply ignored.
  const off = run(started({ earlyLockMs: 0 }), { type: 'pick', c: 0, i: 0 });
  assert.equal(apply(off, { type: 'buzz', teamId: 'r', now: 900 }), off);
});

test('wrong answer penalties: half (default), full, none', () => {
  for (const [penalty, expected] of [['half', -100], ['full', -200], ['none', 0]]) {
    const s = run(armedAt(started({ penalty })), { type: 'buzz', teamId: 'r', now: 1100 }, { type: 'wrong', now: 1500 });
    assert.equal(score(s, 'r'), expected, penalty);
  }
});

test('scores can be kept from going negative', () => {
  const s = run(armedAt(started({ allowNegative: false })), { type: 'buzz', teamId: 'r', now: 1100 }, { type: 'wrong', now: 1500 });
  assert.equal(score(s, 'r'), 0);
});

test('after a wrong answer the others can buzz, the wrong team cannot', () => {
  let s = run(armedAt(started()), { type: 'buzz', teamId: 'r', now: 1100 }, { type: 'wrong', now: 1500 });
  assert.equal(s.phase, 'armed');
  assert.deepEqual(s.q.lockedOut, ['r']);
  assert.equal(s.deadline, 1500 + 10_000); // a fresh buzz window
  assert.equal(s.event.type, 'wrong');
  assert.equal(s.event.reopened, true);
  assert.equal(apply(s, { type: 'buzz', teamId: 'r', now: 1600 }), s);
  s = run(s, { type: 'buzz', teamId: 'b', now: 1600 }, { type: 'correct' });
  assert.equal(score(s, 'b'), 200);
  assert.equal(score(s, 'r'), -100);
});

test('when every team has answered wrong the answer is revealed and the picker stays', () => {
  let s = armedAt(started());
  for (const id of ['r', 'b', 'g']) s = run(s, { type: 'buzz', teamId: id, now: 1100 }, { type: 'wrong', now: 1200 });
  assert.equal(s.phase, 'revealed');
  assert.deepEqual(s.q.result, { type: 'nobody' });
  assert.equal(s.deadline, null);
  assert.equal(s.picker, 'r');
});

test('timers: nobody buzzes, and running out of answer time counts as wrong', () => {
  let s = armedAt(started());
  assert.equal(apply(s, { type: 'timeout', now: 10_999 }), s); // not yet
  const t = apply(s, { type: 'timeout', now: 11_000 });
  assert.equal(t.phase, 'revealed');
  assert.deepEqual(t.q.result, { type: 'timeout' });

  s = apply(s, { type: 'buzz', teamId: 'b', now: 2000 });
  s = apply(s, { type: 'timeout', now: 17_000 });
  assert.equal(score(s, 'b'), -100);
  assert.equal(s.phase, 'armed');
  assert.equal(s.event.type, 'timeup');
});

test('timers can be switched off', () => {
  let s = armedAt(started({ buzzSeconds: 0, answerSeconds: 0 }));
  assert.equal(s.deadline, null);
  s = apply(s, { type: 'buzz', teamId: 'b', now: 2000 });
  assert.equal(s.deadline, null);
  assert.equal(apply(s, { type: 'timeout', now: 999_999 }), s);
});

test('cancel puts the tile back; reveal gives up on it', () => {
  let s = run(started(), { type: 'pick', c: 1, i: 0 });
  s = apply(s, { type: 'cancel' });
  assert.equal(s.phase, 'board');
  assert.equal(s.used[1][0], false);
  s = run(s, { type: 'pick', c: 1, i: 0 }, { type: 'reveal' });
  assert.equal(s.phase, 'revealed');
  assert.deepEqual(s.q.result, { type: 'nobody' });
  // No cancelling once someone has answered wrong.
  const w = run(armedAt(started()), { type: 'buzz', teamId: 'r', now: 1100 }, { type: 'wrong', now: 1200 });
  assert.equal(apply(w, { type: 'cancel' }), w);
});

test('used tiles cannot be picked again', () => {
  const s = run(started(), { type: 'pick', c: 0, i: 0 }, { type: 'reveal' }, { type: 'next', now: 0 });
  assert.equal(apply(s, { type: 'pick', c: 0, i: 0 }), s);
  assert.equal(apply(s, { type: 'pick', c: 9, i: 0 }), s);
});

test('undo takes back the last judgement', () => {
  let s = armedAt(started());
  s = run(s, { type: 'buzz', teamId: 'r', now: 1100 }, { type: 'correct' });
  s = apply(s, { type: 'undo' });
  assert.equal(score(s, 'r'), 0);
  assert.equal(s.phase, 'answering');
  assert.equal(s.q.buzzedTeam, 'r');
  assert.equal(s.deadline, null); // no timer after an undo
  s = apply(s, { type: 'wrong', now: 1200 });
  assert.equal(score(s, 'r'), -100);
  assert.equal(s.phase, 'armed');
  assert.equal(hostView(s).canUndo, true);
  s = apply(s, { type: 'undo' });
  assert.equal(hostView(s).canUndo, false);
  assert.equal(apply(s, { type: 'undo' }), s);
});

test('undo keeps teams that joined in the meantime', () => {
  let s = run(armedAt(started()), { type: 'buzz', teamId: 'r', now: 1100 }, { type: 'correct' });
  s = apply(s, { type: 'join', teamId: 'y', name: 'Yellow', color: COLORS[3] });
  s = apply(s, { type: 'undo' });
  assert.deepEqual(s.teams.map((t) => t.id), ['r', 'b', 'g', 'y']);
});

test('the host can adjust scores by hand', () => {
  let s = apply(started(), { type: 'adjust', teamId: 'g', delta: 50 });
  assert.equal(score(s, 'g'), 50);
  s = apply(s, { type: 'undo' });
  assert.equal(score(s, 'g'), 0);
});

test('removing the team that buzzed re-opens the buzzers', () => {
  let s = run(armedAt(started()), { type: 'buzz', teamId: 'r', now: 1100 });
  s = apply(s, { type: 'removeTeam', teamId: 'r' });
  assert.equal(s.phase, 'armed');
  assert.equal(s.picker, 'b');
  assert.equal(s.teams.length, 2);
});

function playBoard(s) {
  for (let c = 0; c < s.used.length; c++)
    for (let i = 0; i < s.used[c].length; i++) {
      s = run(s, { type: 'pick', c, i }, { type: 'arm', now: 0 }, { type: 'buzz', teamId: 'r', now: 1 }, { type: 'correct' }, { type: 'next', now: 2 });
    }
  return s;
}

test('finishing the board goes to the final round', () => {
  let s = playBoard(started());
  assert.equal(score(s, 'r'), 600);
  assert.equal(s.phase, 'finalWager');
  assert.deepEqual(s.final.base, { r: 600, b: 0, g: 0 });
});

test('without a final question (or with it switched off) the game ends', () => {
  const noFinal = { ...small, final: undefined };
  assert.equal(playBoard(started({}, noFinal)).phase, 'over');
  assert.equal(playBoard(started({ finalRound: false })).phase, 'over');
  assert.equal(apply(started({ finalRound: false }), { type: 'end' }).phase, 'over');
});

test('final round: wager, answer, judge', () => {
  let s = run(started(), { type: 'adjust', teamId: 'r', delta: 500 }, { type: 'adjust', teamId: 'b', delta: 300 }, { type: 'end' });
  assert.equal(s.phase, 'finalWager');
  assert.throws(() => apply(s, { type: 'wager', teamId: 'r', amount: 501 }), { code: 'bad-wager' });
  assert.throws(() => apply(s, { type: 'wager', teamId: 'r', amount: 1.5 }), { code: 'bad-wager' });
  assert.throws(() => apply(s, { type: 'wager', teamId: 'g', amount: 1 }), { code: 'bad-wager' }); // 0 points, can only bet 0
  s = run(s, { type: 'wager', teamId: 'r', amount: 400 }, { type: 'wager', teamId: 'b', amount: '300' }, { type: 'wager', teamId: 'g', amount: 0 });
  assert.equal(phoneView(s, 'r').final.maxWager, 500);

  s = apply(s, { type: 'next', now: 5000 });
  assert.equal(s.phase, 'finalQuestion');
  assert.equal(s.deadline, 5000 + 30_000);
  s = run(s, { type: 'finalAnswer', teamId: 'r', text: ' sogne ' }, { type: 'finalAnswer', teamId: 'r', text: 'Sognefjorden' });
  s = apply(s, { type: 'finalAnswer', teamId: 'b', text: 'x'.repeat(500) });
  assert.equal(s.final.answers.r, 'Sognefjorden');
  assert.equal(s.final.answers.b.length, 100);

  s = apply(s, { type: 'timeout', now: 35_000 });
  assert.equal(s.phase, 'finalJudge');
  assert.equal(apply(s, { type: 'finalAnswer', teamId: 'g', text: 'late' }), s);

  s = run(s, { type: 'judgeFinal', teamId: 'r', correct: true }, { type: 'judgeFinal', teamId: 'b', correct: false });
  assert.equal(score(s, 'r'), 900);
  assert.equal(score(s, 'b'), 0);
  s = apply(s, { type: 'judgeFinal', teamId: 'b', correct: true }); // host changes their mind
  assert.equal(score(s, 'b'), 600);
  s = apply(s, { type: 'judgeFinal', teamId: 'b', correct: null });
  assert.equal(score(s, 'b'), 300);
  s = apply(s, { type: 'next', now: 0 });
  assert.equal(s.phase, 'over');
});

test('the TV never sees an answer before it is revealed', () => {
  let s = run(started(), { type: 'pick', c: 0, i: 1 });
  const json = (v) => JSON.stringify(v);
  assert.ok(!json(displayView(s)).includes('A1'));
  assert.ok(!json(displayView(s)).includes('A2'));
  assert.equal(displayView(s).q.question, 'a2');
  s = apply(s, { type: 'reveal' });
  assert.equal(displayView(s).q.answer, 'A2');
  assert.ok(!json(displayView(s)).includes('A1'));

  s = run(apply(s, { type: 'next', now: 0 }), { type: 'end' });
  assert.ok(!json(displayView(s)).includes('fq'));
  s = run(s, { type: 'next', now: 0 }, { type: 'finalAnswer', teamId: 'r', text: 'secret guess' });
  assert.equal(displayView(s).final.question, 'fq');
  assert.ok(!json(displayView(s)).includes('secret guess'));
  assert.ok(!json(displayView(s)).includes('FA'));
  s = run(s, { type: 'next', now: 0 }, { type: 'judgeFinal', teamId: 'r', correct: false });
  assert.equal(displayView(s).final.reveal.r.answer, 'secret guess');
  s = apply(s, { type: 'next', now: 0 });
  assert.equal(displayView(s).final.answer, 'FA');
});

test('phones never see questions or answers', () => {
  let s = run(armedAt(started()), { type: 'buzz', teamId: 'b', now: 1100 });
  const v = phoneView(s, 'r');
  const json = JSON.stringify(v);
  for (const secret of ['a1', 'a2', 'A2', 'fq', 'FA']) assert.ok(!json.includes(secret), secret);
  assert.equal(v.status, 'other');
  assert.equal(phoneView(s, 'b').status, 'first');
  s = apply(s, { type: 'wrong', now: 1200 });
  assert.equal(phoneView(s, 'b').status, 'locked');
  assert.equal(phoneView(s, 'r').status, 'armed');
  assert.equal(phoneView(s, 'nobody').status, 'unknown');
});

test('bad settings are refused', () => {
  const s = started();
  assert.throws(() => apply(s, { type: 'settings', settings: { penalty: 'double' } }), { code: 'bad-settings' });
  assert.throws(() => apply(s, { type: 'settings', settings: { buzzSeconds: -1 } }), { code: 'bad-settings' });
  assert.equal(apply(s, { type: 'settings', settings: { penalty: 'full', lang: 'no' } }).settings.penalty, 'full');
});

test('restart keeps the teams, clears scores and the board', () => {
  let s = run(armedAt(started()), { type: 'buzz', teamId: 'r', now: 1100 }, { type: 'correct' });
  s = apply(s, { type: 'restart' });
  assert.equal(s.phase, 'lobby');
  assert.equal(s.teams.length, 3);
  assert.equal(score(s, 'r'), 0);
  assert.ok(s.used.flat().every((u) => !u));
  assert.equal(hostView(s).canUndo, false);
});

test('pictures: the TV gets the question picture, the answer picture only when revealed, phones neither', () => {
  const set = structuredClone(small);
  set.categories[0].questions[0].image = 'flag.svg';
  set.categories[0].questions[0].answerImage = 'secret.png';
  set.final.image = 'final-q.jpg';
  set.final.answerImage = 'final-a.jpg';
  assert.deepEqual(validateSet(set), []);

  let s = run(started({}, set), { type: 'pick', c: 0, i: 0 });
  const tv = () => JSON.stringify(displayView(s));
  assert.equal(displayView(s).q.image, 'flag.svg');
  assert.equal(displayView(s).set.categories[0].questions[0].image, 'flag.svg'); // for loading early
  assert.ok(!tv().includes('secret.png'));
  assert.ok(!JSON.stringify(phoneView(s, 'r')).includes('flag.svg'));
  s = apply(s, { type: 'reveal' });
  assert.equal(displayView(s).q.answerImage, 'secret.png');

  s = run(s, { type: 'next', now: 0 }, { type: 'end' });
  assert.ok(!tv().includes('final-q.jpg'));
  s = apply(s, { type: 'next', now: 0 });
  assert.equal(displayView(s).final.image, 'final-q.jpg');
  assert.ok(!tv().includes('final-a.jpg'));
});

test('the final answer shows on the TV once every team is judged', () => {
  let s = run(started(), { type: 'end' }, { type: 'next', now: 0 }, { type: 'next', now: 0 });
  assert.equal(s.phase, 'finalJudge');
  s = run(s, { type: 'judgeFinal', teamId: 'r', correct: true }, { type: 'judgeFinal', teamId: 'b', correct: false });
  assert.equal(displayView(s).final.answer, undefined);
  s = apply(s, { type: 'judgeFinal', teamId: 'g', correct: false });
  assert.equal(displayView(s).final.answer, 'FA');
});

test('pictures must be plain file names; a picture can stand in for the question text', () => {
  const set = structuredClone(small);
  set.categories[1].questions[0] = { value: 100, question: '', image: 'who-is-this.jpg', answer: 'x' };
  assert.deepEqual(validateSet(set), []);
  set.categories[1].questions[1].image = '../../etc/passwd';
  assert.deepEqual(validateSet(set), [{ code: 'bad-image', c: 1, i: 1 }]);
});
