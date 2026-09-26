// Pure game rules. No DOM, no sockets: the server feeds actions in and gets a new state back.
// The same file is loaded by the server, the browser pages and the tests.
//
// Time never comes from Date.now() in here: actions that need it carry `now` (ms),
// and timers are stored as `state.deadline`. The server sends a `timeout` action when it passes.

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
  lang: 'en', // 'en' | 'no'
};

export class GameError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function newGame(set, settings = {}) {
  return {
    v: 1,
    phase: 'lobby', // lobby → board → reading → armed → answering → revealed → board … → finalWager → finalQuestion → finalJudge → over
    settings: cleanSettings({ ...DEFAULT_SETTINGS, ...settings }),
    set,
    teams: [], // { id, name, color, score }
    used: emptyBoard(set),
    picker: null, // team id that picks the next question
    q: null, // the open question, see pick()
    final: null, // final round, see startFinal()
    deadline: null, // ms timestamp when the running timer ends, or null
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
  return handler(s, action) === false ? state : s;
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
  return { ...rest, canUndo: history.length > 0 };
}

// The TV: no answers until they are revealed.
export function displayView(state) {
  const v = hostView(state);
  delete v.canUndo;
  v.set = {
    title: state.set.title,
    // Question pictures are listed so the TV can load them early; answer pictures are not.
    categories: state.set.categories.map((c) => ({
      name: c.name,
      questions: c.questions.map((q) => ({ value: q.value, ...(q.image && { image: q.image }) })),
    })),
  };
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
  switch (state.phase) {
    case 'lobby':
      return 'lobby';
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
    if (s.q) {
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

  loadSet(s, { set }) {
    if (s.phase !== 'lobby') return false;
    s.set = set;
    s.used = emptyBoard(set);
  },

  start(s, { picker }) {
    if (s.phase !== 'lobby' || s.teams.length === 0) return false;
    s.phase = 'board';
    s.picker = s.teams.some((t) => t.id === picker) ? picker : s.teams[0].id;
    emit(s, 'start');
  },

  setPicker(s, { teamId }) {
    if (!s.teams.some((t) => t.id === teamId)) return false;
    s.picker = teamId;
  },

  pick(s, { c, i }) {
    if (s.phase !== 'board' || s.used[c]?.[i] !== false) return false;
    s.used[c][i] = true;
    s.q = {
      c,
      i,
      value: s.set.categories[c].questions[i].value,
      lockedOut: [], // teams that answered wrong (they can't buzz again on this question)
      early: {}, // teamId → ms until which an early buzz keeps them locked
      buzzes: [], // { teamId, at } in the order they reached the server, for this attempt
      buzzedTeam: null,
      result: null, // { type: 'correct', teamId } | { type: 'nobody' } | { type: 'timeout' }
    };
    s.phase = 'reading';
    emit(s, 'pick', { c, i });
  },

  arm(s, { now }) {
    if (s.phase !== 'reading') return false;
    openBuzzers(s, now);
  },

  buzz(s, { teamId, now }) {
    const q = s.q;
    if (!q || !s.teams.some((t) => t.id === teamId)) return false;
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
    team.score += s.q.value;
    s.picker = team.id;
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
    if (s.phase !== 'reading' && s.phase !== 'armed') return false;
    if (s.q.lockedOut.length) return false;
    s.used[s.q.c][s.q.i] = false;
    s.q = null;
    s.phase = 'board';
    s.deadline = null;
  },

  next(s, { now }) {
    if (s.phase === 'revealed') {
      s.q = null;
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
      history: [],
    });
    for (const t of s.teams) t.score = 0;
    emit(s, 'restart');
  },
};

function openBuzzers(s, now) {
  s.q.buzzes = [];
  s.q.buzzedTeam = null;
  s.phase = 'armed';
  s.deadline = s.settings.buzzSeconds ? now + s.settings.buzzSeconds * 1000 : null;
  emit(s, 'armed');
}

function judgeWrong(s, now, reason) {
  const q = s.q;
  const team = teamById(s, q.buzzedTeam);
  team.score -= penaltyFor(q.value, s.settings.penalty);
  if (!s.settings.allowNegative) team.score = Math.max(0, team.score);
  q.lockedOut.push(team.id);
  emit(s, reason === 'timeup' ? 'timeup' : 'wrong', { teamId: team.id });
  if (s.teams.some((t) => !q.lockedOut.includes(t.id))) {
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
    lang: x.lang,
  };
}
