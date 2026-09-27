// Pure game rules. No DOM, no sockets: the server feeds actions in and gets a new state back.
// The same file is loaded by the server, the browser pages and the tests.
//
// Time never comes from Date.now() in here: actions that need it carry `now` (ms),
// and timers are stored as `state.deadline`. The server sends a `timeout` action when it passes.

import { placeSpecials, turboTiles, lastPlace, KINDS, CRAZY_LEVELS, TURBO_COUNT, TURBO_SECONDS } from './crazy.js';
import { AUDIO_NAME } from './validate.js';

// Background music: the moments the host can give their own music file (see public/js/music.js).
export const MUSIC_MOODS = ['lobby', 'board', 'thinking', 'final', 'over'];
export { KINDS, TURBO_COUNT, TURBO_SECONDS } from './crazy.js';

export const COLORS = ['#e53935', '#1e88e5', '#43a047', '#fdd835', '#8e24aa', '#fb8c00', '#00acc1', '#ec407a'];
export const MAX_TEAMS = COLORS.length;
export const MAX_NAME = 20;
export const MAX_FINAL_ANSWER = 100;
const MAX_HISTORY = 30;


export const DEFAULT_SETTINGS = {
  penalty: 'half', // 'none' | 'half' | 'full' — what a wrong answer costs
  allowNegative: true, // may scores drop below zero?
  buzzSeconds: 10, // time to buzz once armed (0 = no timer)
  answerSeconds: 15, // time to answer after buzzing (0 = no timer)
  finalSeconds: 30, // time to type the final answer (0 = no timer)
  earlyLockMs: 500, // buzzing before the host arms locks the phone this long (0 = off)
  finalRound: true, // play the set's final question, if it has one
  sound: true, // sound effects on the TV (or the host laptop when no TV screen is open)
  music: true, // background music, in the same place as the sound effects
  musicVolume: 35, // 0–100, separate from the sound effects
  musicFiles: {}, // mood → the host's own music file, e.g. { lobby: '3fa9c0d1e2b4a6f8.mp3' }
  crazy: 'off', // Kaosmodus: 'off' | 'some' | 'lots' — hidden special tiles (see crazy.js)
  crazyExclude: [], // Kaosmodus: specials the host doesn't want (e.g. ['jackpot'])
  lang: 'en', // 'en' | 'no'
};

export class GameError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function newGame(set, settings = {}, setId = null) {
  return {
    v: 1,
    setId, // which saved quiz `set` came from
    phase: 'lobby', // lobby → board → (special →) reading → armed → answering → revealed → board … → finalWager → finalQuestion → finalJudge → over
    settings: cleanSettings({ ...DEFAULT_SETTINGS, ...settings }),
    set,
    teams: [], // { id, name, color, score }
    used: emptyBoard(set),
    picker: null, // team id that picks the next question
    q: null, // the open question, see pick()
    final: null, // final round, see startFinal()
    deadline: null, // ms timestamp when the running timer ends, or null
    media: null, // { playing, seq } while the open question has a sound clip (seq goes up for "from the start")
    specials: {}, // Kaosmodus: { "c-i": kind } — secret, only the host sees it
    pot: 0, // Kaosmodus: points lost so far, won by whoever answers the jackpot tile right
    turbo: null, // Kaosmodus: { team, queue: [[c, i]], n, total } while a turbo run is on
    rng: 1, // seed for the random choices of Kaosmodus
    event: null, // { seq, type, ... } — the last thing that happened, for sounds and flashes
    seq: 0,
    history: [], // snapshots for undo
  };
}

// Returns a new state; never changes the one passed in. Throws GameError for bad joins, wagers and settings.
// Actions that make no sense right now (a buzz on the board, say) are ignored and the same state is returned.
export function apply(state, action) {
  const handler = handlers[action.type];
  if (!handler) throw new GameError('unknown-action');
  const s = structuredClone(state);
  if (handler(s, action) === false) return state;
  syncMedia(state, s);
  syncUnveil(s, action.now);
  return s;
}

// A picture that starts as big blocks and slowly becomes clear ("unveil", so it isn't mixed up with
// revealing the answer). q.unveil = { ms: time to clear, done: ms already shown, since: server time it
// last started running, or null while paused }. It runs while the buzzers are on (and during a solo
// answer), freezes while a team answers, and is fully clear once the answer is revealed.
function syncUnveil(s, now) {
  const u = s.q?.unveil;
  if (!u) return;
  if (s.phase === 'revealed') {
    u.done = u.ms;
    u.since = null;
    return;
  }
  const running = s.phase === 'armed' || (s.phase === 'answering' && Boolean(s.q.solo));
  if (running && u.since === null && u.done < u.ms) u.since = now ?? 0;
  else if (!running && u.since !== null) {
    u.done = Math.min(u.ms, u.done + Math.max(0, (now ?? u.since) - u.since));
    u.since = null;
  }
}

// How much of the picture's time has passed at server time `now` (0 = all blocks, 1 = clear).
export function unveilProgress(u, now) {
  if (!u) return 1;
  const elapsed = u.done + (u.since !== null ? Math.max(0, now - u.since) : 0);
  return Math.min(1, elapsed / u.ms);
}

// The sound clip of the open question (or the final): { file, start } or null.
export function clipFor(s) {
  let src = null;
  if (s.q) src = s.set.categories[s.q.c].questions[s.q.i];
  else if (s.phase === 'finalQuestion' || s.phase === 'finalJudge') src = s.set.final;
  return src?.audio ? { file: src.audio, start: src.audioStart || 0 } : null;
}

// state.media says whether the clip should be playing on the TV. A new question starts its clip;
// a buzz pauses it, and it plays on when the others may buzz again or the answer is revealed.
function syncMedia(prev, s) {
  const key = (st) => (st.q ? `q${st.q.c}-${st.q.i}` : ['finalQuestion', 'finalJudge'].includes(st.phase) ? 'final' : null);
  const clip = clipFor(s);
  if (s.q?.result?.type === 'boom') {
    s.media = null; // a bomb has no question, so no clip either
    return;
  }
  if (key(prev) !== key(s) || !clip) {
    // During a Kaosmodus reveal the clip waits; it starts with the question.
    s.media = clip ? { playing: s.phase !== 'special', seq: 0 } : null;
    return;
  }
  if (!s.media || prev.phase === s.phase) return;
  if (s.phase === 'answering' || s.phase === 'finalJudge') s.media.playing = false;
  else if (s.phase === 'revealed' || (s.phase === 'armed' && prev.phase === 'answering') || (s.phase === 'reading' && prev.phase === 'special')) s.media.playing = true;
}

export function penaltyFor(value, penalty) {
  if (penalty === 'full') return value;
  if (penalty === 'half') return Math.round(value / 2);
  return 0;
}

export function boardDone(state) {
  return state.used.every((col) => col.every(Boolean));
}

export function maxWager(team) {
  return Math.max(0, team.score);
}

export function ranking(teams) {
  return [...teams].sort((a, b) => b.score - a.score);
}

// ----- views: what each kind of screen is allowed to see -----

// The host laptop sees everything except the undo stack itself.
export function hostView(state) {
  const { history, ...rest } = state;
  return { ...rest, canUndo: history.length > 0, clip: clipFor(state) };
}

// The TV: no answers until they are revealed.
export function displayView(state) {
  const v = hostView(state);
  delete v.canUndo;
  // Kaosmodus secrets: where the specials are, the seed, and the size of the pot.
  delete v.specials;
  delete v.rng;
  delete v.pot;
  v.turbo = state.turbo && { n: state.turbo.n, total: state.turbo.total, team: state.turbo.team };
  v.set = {
    title: state.set.title,
    // Question pictures are listed so the TV can load them early; answer pictures are not.
    categories: state.set.categories.map((c) => ({
      name: c.name,
      questions: c.questions.map((q) => ({ value: q.value, ...(q.image && { image: q.image }), ...(q.audio && { audio: q.audio }) })),
    })),
  };
  v.clip = clipFor(state);
  if (state.q) {
    const src = state.set.categories[state.q.c].questions[state.q.i];
    v.q = { ...state.q, question: src.question, image: src.image };
    if (state.phase === 'revealed') Object.assign(v.q, { answer: src.answer, answerImage: src.answerImage });
  }
  if (state.final) {
    const f = state.set.final;
    const shown = ['finalQuestion', 'finalJudge', 'over'].includes(state.phase);
    // The right answer shows once every team has been judged (or the game is over).
    const allJudged = state.teams.every((t) => t.id in state.final.judged);
    const answerShown = state.phase === 'over' || (state.phase === 'finalJudge' && allJudged);
    v.final = {
      category: f.category,
      question: shown ? f.question : undefined,
      image: shown ? f.image : undefined,
      answer: answerShown ? f.answer : undefined,
      answerImage: answerShown ? f.answerImage : undefined,
      wagered: Object.keys(state.final.wagers),
      answered: Object.keys(state.final.answers),
      judged: state.final.judged,
      // A team's answer and wager appear on the TV once the host has judged it.
      reveal: Object.fromEntries(
        Object.keys(state.final.judged).map((id) => [id, { answer: state.final.answers[id] ?? '', wager: state.final.wagers[id] ?? 0 }]),
      ),
    };
  }
  return v;
}

// A team's phone: no questions or answers at all, only what the buzzer needs.
export function phoneView(state, teamId) {
  const me = state.teams.find((t) => t.id === teamId) || null;
  const view = {
    phase: state.phase,
    lang: state.settings.lang,
    settings: (({ lang, buzzSeconds, answerSeconds, finalSeconds }) => ({ lang, buzzSeconds, answerSeconds, finalSeconds }))(state.settings),
    teams: state.teams.map(({ id, name, color, score }) => ({ id, name, color, score })),
    you: me,
    status: me ? phoneStatus(state, teamId) : 'unknown',
    buzzedTeam: state.q?.buzzedTeam ?? null,
    picker: state.picker,
    special: state.q?.special ?? null, // only once the tile is picked
    solo: state.q?.solo ?? null,
    frozen: state.q?.frozen ?? null,
    turbo: state.turbo && { n: state.turbo.n, total: state.turbo.total },
    deadline: state.deadline,
    event: state.event,
  };
  if (state.final && me) {
    view.final = {
      category: state.set.final.category,
      maxWager: maxWager({ score: state.final.base[teamId] ?? me.score }),
      wager: state.final.wagers[teamId] ?? null,
      answer: state.final.answers[teamId] ?? null,
      judged: state.final.judged[teamId] ?? null,
    };
  }
  return view;
}

export function phoneStatus(state, teamId) {
  const q = state.q;
  if (q && ['reading', 'armed', 'answering'].includes(state.phase)) {
    if (q.frozen === teamId) return 'frozen';
    if (q.solo) {
      if (q.solo !== teamId) return 'standBack';
      return state.phase === 'answering' ? 'solo' : 'soloReady';
    }
  }
  switch (state.phase) {
    case 'lobby':
      return 'lobby';
    case 'special':
      return 'special';
    case 'armed':
      return q.lockedOut.includes(teamId) ? 'locked' : 'armed';
    case 'answering':
      if (q.buzzedTeam === teamId) return 'first';
      return q.lockedOut.includes(teamId) ? 'locked' : 'other';
    case 'finalWager':
      return 'wager';
    case 'finalQuestion':
      return 'finalAnswer';
    case 'finalJudge':
      return 'finalWait';
    case 'over':
      return 'over';
    default:
      return 'waiting'; // board, reading, revealed
  }
}

// ----- the rules -----

const handlers = {
  join(s, { teamId, name, color }) {
    name = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (!name || name.length > MAX_NAME) throw new GameError('bad-name');
    if (!COLORS.includes(color)) throw new GameError('bad-color');
    const team = s.teams.find((t) => t.id === teamId);
    if (!team && s.teams.length >= MAX_TEAMS) throw new GameError('full');
    const others = s.teams.filter((t) => t.id !== teamId);
    if (others.some((t) => t.name.toLowerCase() === name.toLowerCase())) throw new GameError('name-taken');
    if (others.some((t) => t.color === color)) throw new GameError('color-taken');
    if (team) {
      team.name = name;
      team.color = color;
    } else {
      s.teams.push({ id: teamId, name, color, score: 0 });
      if (s.final) s.final.base[teamId] = 0;
      if (s.phase !== 'lobby' && !s.picker) s.picker = teamId;
    }
    emit(s, 'join', { teamId });
  },

  removeTeam(s, { teamId }) {
    if (!s.teams.some((t) => t.id === teamId)) return false;
    s.teams = s.teams.filter((t) => t.id !== teamId);
    if (s.picker === teamId) s.picker = s.teams[0]?.id ?? null;
    if (s.turbo?.team === teamId) s.turbo = null;
    if (s.q?.frozen === teamId) s.q.frozen = null;
    if (s.q?.solo === teamId) {
      // The team answering alone has left: the question ends.
      s.q.solo = null;
      s.q.buzzedTeam = null;
      s.q.result = { type: 'nobody' };
      if (s.phase !== 'board') s.phase = 'revealed';
      s.deadline = null;
    } else if (s.q) {
      s.q.lockedOut = s.q.lockedOut.filter((id) => id !== teamId);
      if (s.q.buzzedTeam === teamId) {
        s.q.buzzedTeam = null;
        s.phase = 'armed';
        s.deadline = null;
      }
    }
  },

  settings(s, { settings }) {
    s.settings = cleanSettings({ ...s.settings, ...settings });
  },

  loadSet(s, { set, setId = null }) {
    if (s.phase !== 'lobby') return false;
    s.set = set;
    s.setId = setId;
    s.used = emptyBoard(set);
  },

  // `seed` (a random number from the server) drives Kaosmodus; tests may pass `specials` directly.
  start(s, { picker, seed, specials }) {
    if (s.phase !== 'lobby' || s.teams.length === 0) return false;
    s.phase = 'board';
    s.picker = s.teams.some((t) => t.id === picker) ? picker : s.teams[0].id;
    s.rng = Number.isInteger(seed) ? seed >>> 0 : 1;
    s.pot = 0;
    s.turbo = null;
    if (specials) {
      s.specials = Object.fromEntries(
        Object.entries(specials).filter(([key, kind]) => KINDS.includes(kind) && s.used[key.split('-')[0]]?.[key.split('-')[1]] === false),
      );
    } else {
      s.specials = s.settings.crazy === 'off' ? {} : placeSpecials(s, s.settings.crazy, s.settings.crazyExclude);
    }
    emit(s, 'start');
  },

  setPicker(s, { teamId }) {
    if (!s.teams.some((t) => t.id === teamId)) return false;
    s.picker = teamId;
  },

  pick(s, { c, i }) {
    if (s.phase !== 'board' || s.used[c]?.[i] !== false) return false;
    openQuestion(s, c, i);
    const kind = s.specials[`${c}-${i}`];
    if (kind) {
      // Kaosmodus: stop for the big reveal first. The host goes on with Space (`next`).
      s.q.special = kind;
      if (kind === 'jackpot') s.q.pot = s.pot;
      s.phase = 'special';
      emit(s, 'special', { kind, teamId: s.picker });
    } else {
      emit(s, 'pick', { c, i });
    }
  },

  // Kaosmodus, freeze: the host clicks the team the picking team chose (again to undo the choice).
  freeze(s, { teamId }) {
    if (s.phase !== 'special' || s.q.special !== 'freeze' || !teamById(s, teamId)) return false;
    s.q.frozen = s.q.frozen === teamId ? null : teamId;
  },

  arm(s, { now }) {
    if (s.phase !== 'reading') return false;
    if (s.q.solo) {
      // One team answers alone: no buzzing, their answer time starts straight away.
      s.q.buzzedTeam = s.q.solo;
      s.phase = 'answering';
      const secs = s.turbo ? TURBO_SECONDS : s.settings.answerSeconds;
      s.deadline = secs ? now + secs * 1000 : null;
      emit(s, 'buzz', { teamId: s.q.solo, solo: true });
      return;
    }
    openBuzzers(s, now);
  },

  buzz(s, { teamId, now }) {
    const q = s.q;
    if (!q || !s.teams.some((t) => t.id === teamId)) return false;
    if (q.solo || q.frozen === teamId) return false; // one team answers alone, or this team is frozen
    if (s.phase === 'reading') {
      if (!s.settings.earlyLockMs) return false;
      q.early[teamId] = now + s.settings.earlyLockMs;
      emit(s, 'early', { teamId });
      return;
    }
    if (s.phase !== 'armed' && s.phase !== 'answering') return false;
    if (q.lockedOut.includes(teamId) || (q.early[teamId] ?? 0) > now) return false;
    if (q.buzzes.some((b) => b.teamId === teamId)) return false;
    q.buzzes.push({ teamId, at: now });
    if (s.phase === 'answering') return; // too late, but the host screen shows how close they were
    q.buzzedTeam = teamId;
    s.phase = 'answering';
    s.deadline = s.settings.answerSeconds ? now + s.settings.answerSeconds * 1000 : null;
    emit(s, 'buzz', { teamId });
  },

  correct(s) {
    if (s.phase !== 'answering') return false;
    remember(s);
    const team = teamById(s, s.q.buzzedTeam);
    const won = s.q.special === 'jackpot' ? s.pot : 0;
    team.score += s.q.value + won;
    if (won) {
      s.q.won = won;
      s.pot = 0;
    }
    if (!s.turbo) s.picker = team.id;
    s.q.result = { type: 'correct', teamId: team.id };
    s.phase = 'revealed';
    s.deadline = null;
    emit(s, 'correct', { teamId: team.id });
  },

  wrong(s, { now }) {
    if (s.phase !== 'answering') return false;
    remember(s);
    judgeWrong(s, now, 'wrong');
  },

  timeout(s, { now }) {
    if (s.deadline === null || now < s.deadline) return false;
    if (s.phase === 'armed') {
      s.q.result = { type: 'timeout' };
      s.phase = 'revealed';
      s.deadline = null;
      emit(s, 'timeup');
    } else if (s.phase === 'answering') {
      remember(s);
      judgeWrong(s, now, 'timeup');
    } else if (s.phase === 'finalQuestion') {
      s.phase = 'finalJudge';
      s.deadline = null;
      emit(s, 'timeup');
    } else {
      s.deadline = null;
    }
  },

  // Show the answer without anyone getting it (the host gives up on the question).
  reveal(s) {
    if (s.phase !== 'reading' && s.phase !== 'armed') return false;
    s.q.result = { type: 'nobody' };
    s.phase = 'revealed';
    s.deadline = null;
    emit(s, 'reveal');
  },

  // Undo picking a tile by mistake. Only before anyone has answered.
  cancel(s) {
    if (!['special', 'reading', 'armed'].includes(s.phase)) return false;
    if (s.q.lockedOut.filter((id) => id !== s.q.frozen).length) return false;
    s.used[s.q.c][s.q.i] = false;
    s.q = null;
    s.turbo = null; // a turbo run stops here; its questions so far stay played
    s.phase = 'board';
    s.deadline = null;
  },

  next(s, { now }) {
    if (s.phase === 'special') {
      startSpecial(s);
    } else if (s.phase === 'revealed' && s.turbo?.queue.length) {
      // Turbo: the next question opens by itself.
      const [c, i] = s.turbo.queue.shift();
      s.turbo.n += 1;
      openQuestion(s, c, i);
      s.q.solo = s.turbo.team;
      s.q.special = 'turbo';
      emit(s, 'pick', { c, i });
    } else if (s.phase === 'revealed') {
      s.q = null;
      s.turbo = null;
      if (boardDone(s)) endBoard(s);
      else s.phase = 'board';
    } else if (s.phase === 'finalWager') {
      s.phase = 'finalQuestion';
      s.deadline = s.settings.finalSeconds ? now + s.settings.finalSeconds * 1000 : null;
      emit(s, 'finalQuestion');
    } else if (s.phase === 'finalQuestion') {
      s.phase = 'finalJudge';
      s.deadline = null;
    } else if (s.phase === 'finalJudge') {
      s.phase = 'over';
      emit(s, 'over');
    } else return false;
  },

  // Finish the board early.
  end(s) {
    if (s.phase !== 'board') return false;
    endBoard(s);
  },

  wager(s, { teamId, amount }) {
    if (s.phase !== 'finalWager') return false;
    const team = teamById(s, teamId);
    if (!team) return false;
    amount = Number(amount);
    if (!Number.isInteger(amount) || amount < 0 || amount > maxWager({ score: s.final.base[teamId] })) {
      throw new GameError('bad-wager');
    }
    s.final.wagers[teamId] = amount;
  },

  finalAnswer(s, { teamId, text }) {
    if (s.phase !== 'finalQuestion' || !teamById(s, teamId)) return false;
    s.final.answers[teamId] = String(text ?? '').trim().slice(0, MAX_FINAL_ANSWER);
  },

  // correct: true / false, or null to take the judgement back.
  judgeFinal(s, { teamId, correct }) {
    if (s.phase !== 'finalJudge') return false;
    const team = teamById(s, teamId);
    if (!team) return false;
    const wager = s.final.wagers[teamId] ?? 0;
    const base = s.final.base[teamId] ?? 0;
    if (correct === null) delete s.final.judged[teamId];
    else s.final.judged[teamId] = Boolean(correct);
    team.score = correct === null ? base : correct ? base + wager : base - wager;
    if (correct !== null) emit(s, correct ? 'correct' : 'wrong', { teamId, final: true });
  },

  // Play or pause the question's sound clip.
  mediaToggle(s) {
    if (!s.media) return false;
    s.media.playing = !s.media.playing;
  },

  // Play the clip again from its start.
  mediaRestart(s) {
    if (!s.media) return false;
    s.media.seq += 1;
    s.media.playing = true;
  },

  // The host fixes a score by hand.
  adjust(s, { teamId, delta }) {
    const team = teamById(s, teamId);
    if (!team || !Number.isInteger(delta) || delta === 0) return false;
    remember(s);
    team.score += delta;
    if (s.final) s.final.base[teamId] = (s.final.base[teamId] ?? 0) + delta;
  },

  undo(s) {
    const snap = s.history.pop();
    if (!snap) return false;
    // Teams that joined after the snapshot stay; everyone else gets their old score back.
    const current = s.teams;
    Object.assign(s, snap, { history: s.history, seq: s.seq, deadline: null });
    s.teams = current.map((t) => ({ ...t, score: snap.teams.find((o) => o.id === t.id)?.score ?? t.score }));
    emit(s, 'undo');
  },

  // Same teams, scores back to zero, board reset, back to the lobby.
  restart(s) {
    Object.assign(s, {
      phase: 'lobby',
      used: emptyBoard(s.set),
      q: null,
      final: null,
      deadline: null,
      media: null,
      specials: {},
      pot: 0,
      turbo: null,
      history: [],
    });
    for (const t of s.teams) t.score = 0;
    emit(s, 'restart');
  },
};

function openQuestion(s, c, i) {
  const src = s.set.categories[c].questions[i];
  s.used[c][i] = true;
  s.q = {
    c,
    i,
    value: s.set.categories[c].questions[i].value,
    lockedOut: [], // teams that answered wrong (they can't buzz again on this question)
    early: {}, // teamId → ms until which an early buzz keeps them locked
    buzzes: [], // { teamId, at } in the order they reached the server, for this attempt
    buzzedTeam: null,
    result: null, // { type: 'correct' | 'boom', teamId } | { type: 'nobody' } | { type: 'timeout' }
    unveil: src.image && Number(src.unveil) > 0 ? { ms: Number(src.unveil) * 1000, done: 0, since: null } : null,
    // Kaosmodus: special (kind), solo (the only team that may answer), noPenalty, frozen, baseValue, pot, won
  };
  s.phase = 'reading';
}

// Kaosmodus: after the reveal, set the question up for its special.
function startSpecial(s) {
  const q = s.q;
  const picker = s.picker && teamById(s, s.picker) ? s.picker : s.teams[0]?.id;
  switch (q.special) {
    case 'triple':
      q.baseValue = q.value;
      q.value *= 3;
      break;
    case 'bomb': {
      remember(s);
      const team = teamById(s, picker);
      const before = team.score;
      team.score -= q.value;
      if (!s.settings.allowNegative) team.score = Math.max(0, team.score);
      s.pot += before - team.score;
      q.result = { type: 'boom', teamId: team.id, amount: before - team.score };
      s.phase = 'revealed';
      emit(s, 'boom', { teamId: team.id, amount: before - team.score });
      return;
    }
    case 'hotseat':
      q.solo = picker;
      break;
    case 'rescue':
      q.solo = lastPlace(s.teams).id;
      q.noPenalty = true;
      break;
    case 'turbo': {
      const more = turboTiles(s, TURBO_COUNT - 1);
      s.turbo = { team: picker, queue: more, n: 1, total: 1 + more.length };
      q.solo = picker;
      break;
    }
    case 'jackpot':
      q.pot = s.pot;
      break;
    case 'freeze':
      if (q.frozen) q.lockedOut.push(q.frozen);
      break;
  }
  s.phase = 'reading';
  emit(s, 'specialGo', { kind: q.special });
}

function openBuzzers(s, now) {
  s.q.buzzes = [];
  s.q.buzzedTeam = null;
  s.phase = 'armed';
  // With a slowly appearing picture, the buzz time starts counting once the picture is clear.
  const u = s.q.unveil;
  const wait = u ? Math.max(0, u.ms - u.done) : 0;
  s.deadline = s.settings.buzzSeconds ? now + wait + s.settings.buzzSeconds * 1000 : null;
  emit(s, 'armed');
}

function judgeWrong(s, now, reason) {
  const q = s.q;
  const team = teamById(s, q.buzzedTeam);
  const before = team.score;
  // Turbo and rescue cost nothing when wrong.
  const free = q.noPenalty || s.turbo;
  team.score -= free ? 0 : penaltyFor(q.value, s.settings.penalty);
  if (!s.settings.allowNegative) team.score = Math.max(0, team.score);
  if (Object.keys(s.specials).length) s.pot += before - team.score; // Kaosmodus: lost points go into the jackpot
  q.lockedOut.push(team.id);
  emit(s, reason === 'timeup' ? 'timeup' : 'wrong', { teamId: team.id });
  if (!q.solo && s.teams.some((t) => !q.lockedOut.includes(t.id))) {
    const event = s.event;
    openBuzzers(s, now);
    s.event = { ...event, reopened: true }; // one sound for "wrong, others may try"
  } else {
    q.buzzedTeam = null;
    q.result = { type: 'nobody' };
    s.phase = 'revealed';
    s.deadline = null;
  }
}

function endBoard(s) {
  s.q = null;
  s.deadline = null;
  if (s.settings.finalRound && s.set.final) {
    s.phase = 'finalWager';
    s.final = {
      base: Object.fromEntries(s.teams.map((t) => [t.id, t.score])), // scores before the final
      wagers: {},
      answers: {},
      judged: {},
    };
    emit(s, 'finalWager');
  } else {
    s.phase = 'over';
    emit(s, 'over');
  }
}

function remember(s) {
  const { history, set, ...snap } = s; // the set can't change mid-game, so it isn't copied
  s.history = [...history, structuredClone(snap)].slice(-MAX_HISTORY);
}

function emit(s, type, extra = {}) {
  s.seq += 1;
  s.event = { seq: s.seq, type, ...extra };
}

function teamById(s, id) {
  return s.teams.find((t) => t.id === id);
}

function emptyBoard(set) {
  return set.categories.map((c) => c.questions.map(() => false));
}

function cleanMusicFiles(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) bad();
  const out = {};
  for (const [mood, name] of Object.entries(files)) {
    if (!MUSIC_MOODS.includes(mood) || typeof name !== 'string' || !AUDIO_NAME.test(name)) bad();
    out[mood] = name;
  }
  return out;
}

function bad() {
  throw new GameError('bad-settings');
}

function cleanSettings(x) {
  const secs = (v, max) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > max) throw new GameError('bad-settings');
    return n;
  };
  if (!['none', 'half', 'full'].includes(x.penalty)) throw new GameError('bad-settings');
  if (!['en', 'no'].includes(x.lang)) throw new GameError('bad-settings');
  return {
    penalty: x.penalty,
    allowNegative: Boolean(x.allowNegative),
    buzzSeconds: secs(x.buzzSeconds, 120),
    answerSeconds: secs(x.answerSeconds, 120),
    finalSeconds: secs(x.finalSeconds, 300),
    earlyLockMs: secs(x.earlyLockMs, 5000),
    finalRound: Boolean(x.finalRound),
    sound: Boolean(x.sound),
    music: Boolean(x.music),
    musicVolume: secs(x.musicVolume, 100),
    musicFiles: cleanMusicFiles(x.musicFiles),
    crazy: CRAZY_LEVELS.includes(x.crazy) ? x.crazy : bad(),
    crazyExclude:
      Array.isArray(x.crazyExclude) && x.crazyExclude.every((k) => KINDS.includes(k)) ? KINDS.filter((k) => x.crazyExclude.includes(k)) : bad(),
    lang: x.lang,
  };
}
