// Quick quiz (multiple choice, `set.kind === 'quick'`): the rules and the views. game.js sends every action
// here while `state.mode === 'quick'` (see handlerFor() there), so the board rules stay as they are.
//
//   lobby → section (title card with the standings) → ready (the question, no answers yet) → open (answer now)
//         → result (the right answer and who picked what) → ranks (top 5) → ready … → section … → over (podium)
//
// Each phone is a player. A question may have several right options (`correct` is then a list); picking any
// of them counts as right. A right answer is worth 1000 at once and 500 at the last moment (double for a
// double-points question, nothing for a no-points one), plus a streak bonus when the setting is on.
// Like game.js this is pure: time comes from the action's `now`, and timers are `state.deadline`.
//
// game.js and this file import each other; the imports are only used inside functions, never while loading.

import { remember, emit, teamById, MAX_REMOTE_SLACK_MS, creditFor } from './game.js';
import { DEFAULT_SECONDS, rightSet } from './validate.js';
import { avatarOf } from './avatar.js';

export const MAX_PLAYERS = 30;
// The answer shapes and their colours, in the same order on the TV and the phones
// (red, blue, yellow, green: COLORS[0], [1], [3] and [2] in game.js).
export const SHAPES = ['triangle', 'diamond', 'circle', 'square'];
export const OPTION_COLORS = ['#ff453a', '#0a84ff', '#ffd60a', '#30d158'];
export const TOP = 5; // players on the leaderboard after each question
export const STREAK_BONUS = 100; // per right answer in a row before this one (setting quickStreak)
export const MAX_STREAK_BONUS = 5; // so at most +500

// Actions both kinds of game share (game.js runs its own version of these).
export const SHARED = ['join', 'settings', 'loadSet', 'adjust', 'undo', 'restart', 'mediaToggle', 'mediaRestart'];

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
    if (!isRight(q, a?.option)) continue;
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
    else if (s.phase === 'result') {
      s.phase = 'ranks';
      emit(s, 'ranks');
    } else goOn(s, now);
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
  answer(s, { teamId, option, now, at, slack, lead }) {
    const q = s.q;
    if (s.phase !== 'open' || !teamById(s, teamId) || q.answers[teamId]) return false;
    if (!Number.isInteger(option) || option < 0 || option >= questionAt(s).options.length) return false;
    const fair = Number.isFinite(at) && Number.isFinite(slack);
    const margin = fair ? Math.min(Math.max(0, slack), MAX_REMOTE_SLACK_MS) : 0;
    // Never later than the arrival, never more than `margin` before it, never before the answers appeared.
    let pressed = fair ? Math.min(now, Math.max(now - margin, at, q.openedAt)) : now;
    // Pressed after time was up (an answer that was still on its way when the clock ran out may count).
    if (s.deadline != null && pressed > s.deadline) return false;
    if (fair && Number.isFinite(lead)) pressed = Math.max(q.openedAt, pressed - Math.min(Math.max(0, lead), MAX_REMOTE_SLACK_MS / 2));
    q.answers[teamId] = { option, at: pressed };
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
  s.q = {
    seconds: secondsOf(src, s.set.sections[s.pos.s]),
    points: pointsOf(src),
    correct: rightSet(src), // the right options (one or more); only the host sees them before the result
    openedAt: null, // server time the answers appeared
    answers: {}, // teamId → { option, at }
    ranksBefore: null, // everyone's place when the answers appeared, for the arrows
    counts: null, // how many picked each option (from the result on)
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
  q.counts = questionAt(s).options.map(() => 0);
  q.gained = {};
  for (const t of s.teams) {
    const a = q.answers[t.id];
    if (a) q.counts[a.option] += 1;
    if (!q.points) continue; // a no-points question: nobody scores, and streaks stay as they were
    const right = isRight(q, a?.option);
    const gain = right ? pointsFor(a.at - q.openedAt, q.seconds, q.points, t.streak ?? 0, s.settings.quickStreak) : 0;
    t.score += gain;
    t.streak = right ? (t.streak ?? 0) + 1 : 0;
    q.gained[t.id] = gain;
  }
  s.phase = 'result';
  s.deadline = null;
  emit(s, 'quickResult');
}

// After the top 5 (or a skipped question): the next question, the next section's title card, or the podium.
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
    q: { ...state.q, answers: {}, openedAt: null, ranksBefore: null },
    deadline: read ? now + read * 1000 : null,
  };
}

// The sound clip of the question being played: it starts when the question shows and plays until the result.
export function quickClip(s) {
  const src = ['ready', 'open', 'result'].includes(s.phase) && questionAt(s);
  return src?.audio ? { file: src.audio, start: src.audioStart || 0 } : null;
}

// ----- views -----

const sectionsList = (s) => (s.set.sections ?? []).map((sec) => ({ name: sec.name, n: sec.questions?.length ?? 0 }));
const asked = (s) => ['ready', 'open', 'result', 'ranks'].includes(s.phase) && s.q;
const shown = (s) => ['open', 'result', 'ranks'].includes(s.phase); // the answer options are on screen
const settled = (s) => ['result', 'ranks'].includes(s.phase); // the right answer is known

// The host laptop: everything, plus the standings worked out.
export function quickHostView(state) {
  const { history, ...rest } = state;
  const all = standings(state);
  const q = rest.q && { ...rest.q, correct: rightSet(rest.q), fastest: fastestOf(state) };
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
      question: src.question,
      image: src.image,
      seconds: s.q.seconds,
      points: s.q.points,
      openedAt: s.q.openedAt,
      n: src.options.length,
      answered: Object.keys(s.q.answers).filter((id) => teamById(s, id)).length,
      total: s.teams.length,
    };
    if (shown(s)) v.q.options = src.options;
    if (settled(s)) {
      Object.assign(v.q, { correct: rightSet(s.q), counts: s.q.counts, fastest: fastestOf(s) });
      const credit = creditFor(s, src.image);
      if (credit) v.q.credit = credit;
    }
  }
  const all = standings(s);
  if (['ranks', 'section', 'over'].includes(s.phase)) v.ranks = { top: all.slice(0, TOP), total: all.length };
  if (s.phase === 'ranks') v.ranks.before = standingsBefore(s).slice(0, TOP); // the top 5 animates from these
  if (['section', 'over'].includes(s.phase)) v.standings = all;
  return v;
}

// A player's phone: the shapes to press, their own answer and points. The question and option texts only
// when the host has turned on `quickPhoneText` (for players who can't see the TV).
export function quickPhoneView(state, teamId) {
  const s = state;
  const me = teamById(s, teamId) ?? null;
  const ranks = rankMap(s.teams);
  const view = {
    mode: 'quick',
    phase: s.phase,
    lang: s.settings.lang,
    settings: (({ lang, glass, quickReadSeconds, quickPhoneText }) => ({ lang, glass, quickReadSeconds, quickPhoneText }))(s.settings),
    teams: s.teams.map(({ id, name, color, avatar, score }) => ({ id, name, color, ...avatarOf({ avatar }), score })),
    you: me && { id: me.id, name: me.name, color: me.color, ...avatarOf(me), score: me.score, streak: me.streak ?? 0 },
    status: me ? quickPhoneStatus(s, teamId) : 'unknown',
    rank: me ? ranks[teamId] : null,
    rankBefore: (me && placesBefore(s)?.[teamId]) ?? null,
    ...(me ? neighbours(s, teamId) : {}),
    total: s.teams.length,
    pos: s.pos,
    sections: sectionsList(s),
    deadline: s.deadline,
    event: s.event,
    q: null,
  };
  if (asked(s)) {
    const src = questionAt(s);
    const mine = s.q.answers[teamId]?.option;
    view.q = { n: src.options.length, seconds: s.q.seconds, points: s.q.points, mine: mine ?? null };
    if (settled(s)) Object.assign(view.q, { correct: rightSet(s.q), gained: s.q.gained?.[teamId] ?? 0, fastest: fastestOf(s)?.id === teamId });
    if (s.settings.quickPhoneText) {
      view.q.question = src.question;
      if (shown(s)) view.q.options = src.options;
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
