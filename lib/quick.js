// Quick quiz (multiple choice, `set.kind === 'quick'`): the rules and the views. game.js sends every action
// here while `state.mode === 'quick'` (see handlerFor() there), so the board rules stay as they are.
//
//   lobby → section (title card with the standings) → ready (the question, no answers yet) → open (answer now)
//         → result (the right answer and who picked what) → ranks (top 5) → ready … → section … → over (podium)
//         (after the last question of the last section, result → over straight away: no top 5 before the podium)
//
// Each phone is a player. Three kinds of question (`type`, see validate.js): 'choice' (pick one; a question may
// have several right options, and picking any of them counts), 'multi' (tick all that are right, then submit:
// exactly the right ones count) and 'order' (the options are shuffled when the question opens, and a player
// submits them in the right order: the whole order must be right). A right answer is worth 1000 at once and
// 500 at the last moment (double for a double-points question, nothing for a no-points one), plus a streak
// bonus when the setting is on. Faster is better in every kind: the Submit press is the answer time.
// Like game.js this is pure: time comes from the action's `now`, and timers are `state.deadline`.
//
// game.js and this file import each other; the imports are only used inside functions, never while loading.

import { remember, emit, teamById, MAX_REMOTE_SLACK_MS, creditFor, clipOf, unveilOf, wantsText, languageChoice } from './game.js';
import { DEFAULT_SECONDS, rightSet, typeOf } from './validate.js';
import { nextRandom } from './crazy.js';
import { avatarOf } from './avatar.js';
import { textOf, optionsOf } from './languages.js';

// Up to 100 phones. More than 30 in one room hasn't been tried in a real game (the lobby says so): it depends on
// the Wi-Fi router more than on ProQuiz, which just sends every phone a small message after each change.
export const MAX_PLAYERS = 100;
// Emoji reactions a player can send after a question (setting `quickReactions`): the phone sends the index,
// never text, and the TV shows "🔥 Alex" floating up. Not part of the game state (see reactionFor()).
export const REACTIONS = ['😂', '🔥', '😱', '👏', '😭', '🎉'];
// The answer shapes and their colours, in the same order on the TV and the phones
// (red, blue, yellow, green: COLORS[0], [1], [3] and [2] in game.js).
export const SHAPES = ['triangle', 'diamond', 'circle', 'square'];
export const OPTION_COLORS = ['#ff453a', '#0a84ff', '#ffd60a', '#30d158'];
export const TOP = 5; // players on the leaderboard after each question
export const STREAK_BONUS = 100; // per right answer in a row before this one (setting quickStreak)
export const MAX_STREAK_BONUS = 5; // so at most +500

// Actions both kinds of game share (game.js runs its own version of these).
export const SHARED = ['join', 'language', 'settings', 'loadSet', 'adjust', 'undo', 'restart', 'mediaToggle', 'mediaRestart'];

// Points for a right answer `elapsedMs` after the answers appeared: `base` at once, half of it at the last moment.
// `streak` is the right answers in a row before this one; with the bonus on, the 2nd in a row gets +100, and so on.
export function pointsFor(elapsedMs, seconds, base, streak = 0, streakOn = false) {
  if (!base) return 0;
  const bonus = streakOn ? STREAK_BONUS * Math.min(Math.max(0, streak), MAX_STREAK_BONUS) : 0;
  if (!seconds) return base + bonus;
  const part = Math.min(1, Math.max(0, elapsedMs) / (seconds * 1000));
  return Math.round(base * (1 - part / 2)) + bonus;
}

// The question being played (or the one at `pos`).
export function questionAt(s, pos = s.pos) {
  return pos && s.set.sections?.[pos.s]?.questions[pos.i];
}

export const secondsOf = (q, section) => q?.seconds || section?.seconds || DEFAULT_SECONDS;
export const pointsOf = (q) => (Number.isInteger(q?.points) ? q.points : 1000);
// Is `option` one of the right ones? (`q` is the question or `state.q`; `correct` a number or a list.)
export const isRight = (q, option) => Number.isInteger(option) && rightSet(q).includes(option);

// The right answer of `state.q` as a list: the right options (sorted) for 'choice' and 'multi', and for 'order'
// the shown positions in the right order (so it must not be sorted). The same list every view calls `correct`.
export function rightOf(q) {
  if (typeOf(q) === 'order') return Array.isArray(q?.correct) ? q.correct : [];
  return rightSet(q);
}

const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

// Is a player's stored answer (`{ option }`, `{ options }` or `{ order }`, see the answer handler) right?
export function isRightAnswer(q, a) {
  if (!a) return false;
  const type = typeOf(q);
  if (type === 'multi') return sameList(a.options, rightOf(q));
  if (type === 'order') return sameList(a.order, rightOf(q));
  return isRight(q, a.option);
}

// A player's answer from a phone message, checked against the question's kind and its `n` options, or null
// when it has the wrong shape: 'choice' takes `option` (one index), 'multi' `options` (1+ indices, stored
// sorted) and 'order' `order` (every shown position exactly once, in the player's order).
export function answerOf(q, n, { option, options, order }) {
  const indices = (list, min, max) =>
    Array.isArray(list) && list.length >= min && list.length <= max && list.every((x) => Number.isInteger(x) && x >= 0 && x < n) && new Set(list).size === list.length;
  const type = typeOf(q);
  if (type === 'multi') return indices(options, 1, n) ? { options: [...options].sort((a, b) => a - b) } : null;
  if (type === 'order') return indices(order, n, n) ? { order: [...order] } : null;
  return Number.isInteger(option) && option >= 0 && option < n ? { option } : null;
}

// A shuffle of 0 … n−1 for a "put in order" question from the game's seeded random (so undo and resume show
// the same order), never the right order itself.
export function shuffledOrder(s, n) {
  const order = Array.from({ length: n }, (_, k) => k);
  do {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(nextRandom(s) * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  } while (n > 1 && order.every((k, p) => k === p));
  return order;
}

// The options as the players see them: shuffled for a "put in order" question, else as written. With `lang`, in
// that language (each option falling back to the written one), in the same shuffled order.
export function shownOptions(s, lang = null) {
  const q = questionAt(s);
  const options = lang ? optionsOf(q, lang) : (q?.options ?? []);
  return s.q?.order ? s.q.order.map((k) => options[k]) : options;
}

// Everyone's place: { teamId: 1, … }. Equal scores share a place.
export function rankMap(teams) {
  return Object.fromEntries(teams.map((t) => [t.id, 1 + teams.filter((o) => o.score > t.score).length]));
}

// Highest score first; equal scores keep the order they joined in.
const sorted = (teams) => [...teams].sort((a, b) => b.score - a.score);

// The standings with arrows: `move` compares with the places before the question opened
// (`new` for someone who joined during it), `delta` is what this question gave, `places` how far they moved.
export function standings(s) {
  const now = rankMap(s.teams);
  const before = s.q?.ranksBefore ?? null;
  const moved = placesBefore(s) !== null; // false while everyone shared 1st place before this question
  return sorted(s.teams).map((t) => {
    const was = before?.[t.id];
    const move = !before ? 'same' : was === undefined ? 'new' : !moved ? 'same' : now[t.id] < was ? 'up' : now[t.id] > was ? 'down' : 'same';
    return {
      id: t.id,
      name: t.name,
      color: t.color,
      ...avatarOf(t),
      score: t.score,
      rank: now[t.id],
      delta: s.q?.gained?.[t.id] ?? 0,
      move,
      places: was === undefined || !moved ? 0 : Math.abs(was - now[t.id]),
      streak: t.streak ?? 0,
    };
  });
}

// The standings as they were when the answers opened (the TV's top 5 starts from these and moves to now):
// [{ id, name, color, score, rank }], highest first. Players who joined since are left out; [] without a question.
export function standingsBefore(s) {
  const before = s.q?.ranksBefore;
  if (!before) return [];
  const then = s.teams.filter((t) => before[t.id] !== undefined).map((t) => ({ id: t.id, name: t.name, color: t.color, ...avatarOf(t), score: t.score - (s.q.gained?.[t.id] ?? 0), rank: before[t.id] }));
  return sorted(then);
}

// The places when the answers opened, or null when everyone shared 1st place (nobody had points yet):
// then nobody has really moved, so no arrows.
export function placesBefore(s) {
  const before = s.q?.ranksBefore ?? null;
  return before && Object.values(before).some((r) => r !== 1) ? before : null;
}

// Who answered right first (from the result on): { id, name, color, ms } (ms after the answers appeared),
// or null. Equal times: the lowest id. A no-points question has no winner.
export function fastestOf(s) {
  const q = s.q;
  if (!q?.answers || !q.points || !['result', 'ranks'].includes(s.phase)) return null;
  let best = null;
  for (const t of s.teams) {
    const a = q.answers[t.id];
    if (!isRightAnswer(q, a)) continue;
    if (!best || a.at < best.at || (a.at === best.at && t.id < best.t.id)) best = { t, at: a.at };
  }
  return best && { id: best.t.id, name: best.t.name, color: best.t.color, ...avatarOf(best.t), ms: Math.max(0, best.at - q.openedAt) };
}

// The player just above (`behind`: I'm behind them), or for the leader the one just below (`ahead`),
// with the points between: { name, color, gap }.
export function neighbours(s, teamId) {
  const order = sorted(s.teams);
  const i = order.findIndex((t) => t.id === teamId);
  if (i < 0 || order.length < 2) return {};
  const me = order[i];
  const other = i === 0 ? order[1] : order[i - 1];
  const info = { name: other.name, color: other.color, ...avatarOf(other), gap: Math.abs(other.score - me.score) };
  return i === 0 ? { ahead: info } : { behind: info };
}

// A player's reaction to show on the TV, or null when it isn't allowed: only in a Quick quiz, only while the
// result or the top 5 shows, only with the setting on, only from a player in the game, and only one of REACTIONS
// (`emoji` is its index). Nothing is stored: the server just passes it to the TV (rate-limited there).
export function reactionFor(s, teamId, emoji) {
  if (s.mode !== 'quick' || !['result', 'ranks'].includes(s.phase) || !s.settings.quickReactions) return null;
  const t = teamById(s, teamId);
  if (!t || !Number.isInteger(emoji) || emoji < 0 || emoji >= REACTIONS.length) return null;
  return { emoji: REACTIONS[emoji], name: t.name, color: t.color, ...avatarOf(t) };
}

// ----- the rules -----

export const quickHandlers = {
  start(s, { seed }) {
    if (s.phase !== 'lobby' || s.teams.length === 0 || !s.set.sections?.length) return false;
    s.rng = Number.isInteger(seed) ? seed >>> 0 : 1;
    for (const t of s.teams) {
      t.score = 0;
      t.streak = 0;
    }
    s.pos = { s: 0, i: 0 };
    s.q = null;
    s.deadline = null;
    s.phase = 'section';
    emit(s, 'section', { s: 0 });
  },

  // Space: start the section, show the answers, stop the clock, show the top 5, go on.
  next(s, { now }) {
    if (!['section', 'ready', 'open', 'result', 'ranks'].includes(s.phase)) return false;
    remember(s);
    if (s.phase === 'section') openQuestion(s, now);
    else if (s.phase === 'ready') openOptions(s, now);
    else if (s.phase === 'open') closeQuestion(s);
    else if (s.phase === 'result' && !isLastQuestion(s)) {
      s.phase = 'ranks';
      emit(s, 'ranks');
    } else goOn(s, now); // after the last question's result: straight to the podium (owner feedback 2026-10-11)
  },

  timeout(s, { now }) {
    if (s.deadline === null || now < s.deadline) return false;
    if (s.phase === 'ready') return openOptions(s, now);
    if (s.phase === 'open') {
      remember(s);
      return closeQuestion(s);
    }
    s.deadline = null;
  },

  // From a phone (the server adds its teamId, and `at`/`slack` as for a buzz: the press time on the server's
  // clock and how long before arriving it may count). One answer per player, only while the answers are open.
  // `lead` (also from the server) is half the phone's measured round trip: how long the answers took to reach
  // it, so a player far away (or over the internet) isn't scored lower for seeing them later.
  // The answer itself is `option`, `options` or `order` by the question's kind (see answerOf()); for the kinds
  // with a Submit button, the Submit press is the press.
  answer(s, { teamId, option, options, order, now, at, slack, lead }) {
    const q = s.q;
    if (s.phase !== 'open' || !teamById(s, teamId) || q.answers[teamId]) return false;
    const picked = answerOf(q, questionAt(s).options.length, { option, options, order });
    if (!picked) return false;
    const fair = Number.isFinite(at) && Number.isFinite(slack);
    const margin = fair ? Math.min(Math.max(0, slack), MAX_REMOTE_SLACK_MS) : 0;
    // Never later than the arrival, never more than `margin` before it, never before the answers appeared.
    let pressed = fair ? Math.min(now, Math.max(now - margin, at, q.openedAt)) : now;
    // Pressed after time was up (an answer that was still on its way when the clock ran out may count).
    if (s.deadline != null && pressed > s.deadline) return false;
    if (fair && Number.isFinite(lead)) pressed = Math.max(q.openedAt, pressed - Math.min(Math.max(0, lead), MAX_REMOTE_SLACK_MS / 2));
    q.answers[teamId] = { ...picked, at: pressed };
    // Everyone has answered: no need to wait for the clock.
    if (s.teams.every((t) => q.answers[t.id])) {
      remember(s);
      closeQuestion(s);
    }
  },

  // Esc: drop the question (nobody scores) and go on to the next one.
  skip(s, { now }) {
    if (s.phase !== 'ready' && s.phase !== 'open') return false;
    remember(s);
    goOn(s, now);
  },

  // Picking a tile and putting it back are board things.
  cancel: () => false,

  removeTeam(s, { teamId }) {
    if (!teamById(s, teamId)) return false;
    s.teams = s.teams.filter((t) => t.id !== teamId);
    if (s.picker === teamId) s.picker = s.teams[0]?.id ?? null;
    if (s.q) delete s.q.answers[teamId];
  },
};

// The question at s.pos: shown on the TV for `quickReadSeconds` before the answers appear (0 = until Space).
function openQuestion(s, now) {
  const src = questionAt(s);
  const type = typeOf(src);
  // Put in order: `order[p]` is the written option shown at position p, and the right answer is the shown
  // positions in the written order. Only the host sees `order` and `correct` before the result.
  const order = type === 'order' ? shuffledOrder(s, src.options.length) : null;
  const seconds = secondsOf(src, s.set.sections[s.pos.s]);
  s.q = {
    type,
    seconds,
    points: pointsOf(src),
    // A slowly appearing picture (see unveilOf() in game.js): it runs while the answers are open, so it is cut to
    // the question's seconds and is clear by the time the clock runs out (and from the result on whatever happens).
    unveil: unveilOf(src, seconds),
    correct: order ? src.options.map((o, k) => order.indexOf(k)) : rightSet(src), // the right options (one or more), or the right order
    ...(order && { order }),
    openedAt: null, // server time the answers appeared
    answers: {}, // teamId → { option | options | order, at }
    ranksBefore: null, // everyone's place when the answers appeared, for the arrows
    counts: null, // per shown option: how many picked it, ticked it, or put it in its right place (from the result on)
    nRight: null, // how many players got it right (from the result on)
    gained: null, // teamId → points from this question (from the result on)
  };
  s.phase = 'ready';
  const read = s.settings.quickReadSeconds;
  s.deadline = read ? now + read * 1000 : null;
  emit(s, 'quickReady', { s: s.pos.s, i: s.pos.i });
}

function openOptions(s, now) {
  s.q.openedAt = now;
  s.q.ranksBefore = rankMap(s.teams);
  s.phase = 'open';
  s.deadline = now + s.q.seconds * 1000;
  emit(s, 'quickOpen');
}

// Time's up (or everyone answered, or the host stopped it): score the answers.
function closeQuestion(s) {
  const q = s.q;
  const type = typeOf(q);
  q.counts = questionAt(s).options.map(() => 0);
  q.nRight = 0;
  q.gained = {};
  for (const t of s.teams) {
    const a = q.answers[t.id];
    if (a && type === 'multi') for (const p of a.options) q.counts[p] += 1;
    else if (a && type === 'order') a.order.forEach((p, k) => p === q.correct[k] && (q.counts[p] += 1));
    else if (a) q.counts[a.option] += 1;
    const right = isRightAnswer(q, a);
    if (right) q.nRight += 1;
    if (!q.points) continue; // a no-points question: nobody scores, and streaks stay as they were
    const gain = right ? pointsFor(a.at - q.openedAt, q.seconds, q.points, t.streak ?? 0, s.settings.quickStreak) : 0;
    t.score += gain;
    t.streak = right ? (t.streak ?? 0) + 1 : 0;
    q.gained[t.id] = gain;
  }
  s.phase = 'result';
  s.deadline = null;
  emit(s, 'quickResult');
}

// The last question of the whole quiz: its result goes straight to the podium, with no top 5 in between.
export const isLastQuestion = (s) => s.pos.s + 1 >= s.set.sections.length && s.pos.i + 1 >= s.set.sections[s.pos.s].questions.length;

// After the top 5 (or a skipped question, or the last question's result): the next question, the next section's
// title card, or the podium.
function goOn(s, now) {
  const { s: sec, i } = s.pos;
  s.q = null;
  s.deadline = null;
  if (i + 1 < s.set.sections[sec].questions.length) {
    s.pos = { s: sec, i: i + 1 };
    return openQuestion(s, now);
  }
  if (sec + 1 < s.set.sections.length) {
    s.pos = { s: sec + 1, i: 0 };
    s.phase = 'section';
    return emit(s, 'section', { s: sec + 1 });
  }
  s.phase = 'over';
  emit(s, 'over');
}

// Undo back into a question: nobody has answered it yet, and its clock starts again.
export function afterUndo(s, now) {
  if (s.phase === 'open') {
    s.q.answers = {};
    s.q.openedAt = now;
    s.deadline = now + s.q.seconds * 1000;
    if (s.q.unveil) Object.assign(s.q.unveil, { done: 0, since: null }); // the picture starts over with the clock (syncUnveil() starts it)
  } else if (s.phase === 'ready') {
    s.deadline = s.settings.quickReadSeconds ? now + s.settings.quickReadSeconds * 1000 : null;
  }
}

// A saved game that stopped while a question was showing goes back to "get ready" for that question,
// with nobody answered and a fresh clock. Returns a new state.
export function resumeFix(state, now) {
  if (state.mode !== 'quick' || !['ready', 'open'].includes(state.phase) || !state.q) return state;
  const read = state.settings.quickReadSeconds;
  return {
    ...state,
    phase: 'ready',
    q: { ...state.q, answers: {}, openedAt: null, ranksBefore: null, ...(state.q.unveil && { unveil: { ...state.q.unveil, done: 0, since: null } }) },
    deadline: read ? now + read * 1000 : null,
  };
}

// The sound clip of the question being played: it starts when the question shows and plays until the result.
export function quickClip(s) {
  const src = ['ready', 'open', 'result'].includes(s.phase) && questionAt(s);
  return src ? clipOf(src) : null;
}

// ----- views -----

const sectionsList = (s, lang = null) => (s.set.sections ?? []).map((sec) => ({ name: lang ? textOf(sec, lang, 'name') : sec.name, n: sec.questions?.length ?? 0 }));
const asked = (s) => ['ready', 'open', 'result', 'ranks'].includes(s.phase) && s.q;
const shown = (s) => ['open', 'result', 'ranks'].includes(s.phase); // the answer options are on screen
const settled = (s) => ['result', 'ranks'].includes(s.phase); // the right answer is known

// The host laptop: everything, plus the standings worked out.
export function quickHostView(state) {
  const { history, ...rest } = state;
  const all = standings(state);
  const q = rest.q && { ...rest.q, type: typeOf(rest.q), correct: rightOf(rest.q), options: shownOptions(state), fastest: fastestOf(state) };
  const ranks = { top: all.slice(0, TOP), total: all.length };
  if (state.phase === 'ranks') ranks.before = standingsBefore(state).slice(0, TOP);
  return { ...rest, q, canUndo: history.length > 0, clip: quickClip(state), ranks, standings: all };
}

// The TV: the question (and the options once they're open), never the right answer before the result.
// No questions ahead of time, only the current section's picture and clip names so it can load them early.
export function quickDisplayView(state) {
  const s = state;
  const v = {
    v: s.v,
    mode: 'quick',
    setId: s.setId,
    phase: s.phase,
    settings: s.settings,
    teams: s.teams.map(({ id, name, color, avatar, score, streak }) => ({ id, name, color, ...avatarOf({ avatar }), score, streak: streak ?? 0 })),
    pos: s.pos,
    deadline: s.deadline,
    media: s.media,
    clip: quickClip(s),
    event: s.event,
    seq: s.seq,
    set: {
      title: s.set.title,
      ...(s.set.description && { description: s.set.description }),
      ...(s.set.cover && { cover: s.set.cover }),
      kind: 'quick',
      sections: sectionsList(s),
      preload: s.pos
        ? (s.set.sections[s.pos.s]?.questions ?? []).filter((q) => q.image || q.audio).map((q) => ({ ...(q.image && { image: q.image }), ...(q.audio && { audio: q.audio }) }))
        : [],
    },
    q: null,
  };
  if (asked(s)) {
    const src = questionAt(s);
    v.q = {
      type: typeOf(s.q),
      question: src.question,
      image: src.image,
      unveil: s.q.unveil, // how far the slowly appearing picture is (the TV draws it; no picture is clear before the result)
      seconds: s.q.seconds,
      points: s.q.points,
      openedAt: s.q.openedAt,
      n: src.options.length,
      answered: Object.keys(s.q.answers).filter((id) => teamById(s, id)).length,
      total: s.teams.length,
    };
    if (shown(s)) v.q.options = shownOptions(s); // shuffled for "put in order", and never the shuffle itself
    if (settled(s)) {
      Object.assign(v.q, { correct: rightOf(s.q), counts: s.q.counts, nRight: s.q.nRight, fastest: fastestOf(s) });
      const credit = creditFor(s, src.image);
      if (credit) v.q.credit = credit;
      const clipCredit = creditFor(s, src.audio);
      if (clipCredit) v.q.clipCredit = clipCredit;
    }
  }
  const all = standings(s);
  if (['ranks', 'section', 'over'].includes(s.phase)) v.ranks = { top: all.slice(0, TOP), total: all.length };
  if (s.phase === 'ranks') v.ranks.before = standingsBefore(s).slice(0, TOP); // the top 5 animates from these
  if (['section', 'over'].includes(s.phase)) v.standings = all;
  return v;
}

// A player's phone: the shapes to press, their own answer and points. The question and option texts only
// when the host has turned on `quickPhoneText` (for players who can't see the TV), or always, in that language,
// for a player who reads the quiz in another language (wantsText() in game.js): the TV shows the main language,
// so their phone is where they read the question. The translated options follow the same shuffle.
export function quickPhoneView(state, teamId) {
  const s = state;
  const me = teamById(s, teamId) ?? null;
  const ranks = rankMap(s.teams);
  const textLang = wantsText(s, me);
  const view = {
    mode: 'quick',
    phase: s.phase,
    lang: s.settings.lang,
    settings: (({ lang, glass, quickReadSeconds, quickPhoneText, quickReactions }) => ({ lang, glass, quickReadSeconds, quickPhoneText, quickReactions }))(s.settings),
    languages: languageChoice(s),
    textLang,
    teams: s.teams.map(({ id, name, color, avatar, score }) => ({ id, name, color, ...avatarOf({ avatar }), score })),
    you: me && { id: me.id, name: me.name, color: me.color, ...avatarOf(me), ...(me.lang && { lang: me.lang }), score: me.score, streak: me.streak ?? 0 },
    status: me ? quickPhoneStatus(s, teamId) : 'unknown',
    rank: me ? ranks[teamId] : null,
    rankBefore: (me && placesBefore(s)?.[teamId]) ?? null,
    ...(me ? neighbours(s, teamId) : {}),
    total: s.teams.length,
    pos: s.pos,
    sections: sectionsList(s, textLang),
    deadline: s.deadline,
    event: s.event,
    q: null,
  };
  if (asked(s)) {
    const src = questionAt(s);
    const { at, ...mine } = s.q.answers[teamId] ?? {}; // my own answer: { option } / { options } / { order }
    view.q = { type: typeOf(s.q), n: src.options.length, seconds: s.q.seconds, points: s.q.points, mine: at === undefined ? null : mine };
    if (settled(s)) Object.assign(view.q, { correct: rightOf(s.q), gained: s.q.gained?.[teamId] ?? 0, fastest: fastestOf(s)?.id === teamId });
    if (textLang || s.settings.quickPhoneText) {
      view.q.question = textLang ? textOf(src, textLang, 'question') : src.question;
      if (shown(s)) view.q.options = shownOptions(s, textLang);
    }
  }
  return view;
}

export function quickPhoneStatus(s, teamId) {
  switch (s.phase) {
    case 'lobby':
    case 'section':
    case 'ready':
    case 'result':
    case 'ranks':
    case 'over':
      return s.phase;
    case 'open':
      return s.q.answers[teamId] ? 'answered' : 'answer';
    default:
      return 'waiting';
  }
}
