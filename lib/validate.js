// Checks a question set before it's used or saved. Shared by the server and the editor.
// Returns a list of problems ({ code, c?, i?, r? }); an empty list means the set is fine. `r: 2` marks a problem on round 2's board.
//
// Shape: { v: 1, title, categories: [{ name, questions: [{ value, question, answer, image?, answerImage?, audio?, audioStart? }] }],
//          round2?: { categories: [...same as categories...] },
//          final?: { category, question, answer, image?, answerImage?, audio?, audioStart? } }
// `round2` is an optional second board (its own questions, usually worth double), played before the final.
// `unveil` (seconds, 1–120) makes the question picture start as big blocks that slowly become clear.
// `image` shows with the question, `answerImage` only when the answer is revealed, `audio` plays on the TV
// (from `audioStart` seconds). All three are file names in the files folder.
// `special` (one of KINDS in crazy.js) makes the tile a Kaosmodus special placed by hand. Not on the final.
// `credits` (optional, any kind of quiz): who made the pictures found with "Find a free picture", by file name
// (see cleanCredits() below).
//
// A Quick quiz (multiple choice, `kind: "quick"`) has sections instead of a board:
//   { v: 1, kind: 'quick', title, sections: [{ name, seconds?, questions: [{ question, options: [2–4 texts], correct,
//     seconds?, points?, image?, audio?, audioStart? }] }] }
// `type` says what kind of question it is (QUESTION_TYPES, see typeOf()):
//   'choice' (the default, left out of the file): a player picks one option. `correct` is the index of the right
//            option, or a list of indices when several are right (any right one counts). Not every option may be right.
//   'multi':  "tick all that are right": `correct` is a list of 1+ indices (every option may be right), and a player
//            must tick exactly these.
//   'order':  "put in order": the options are stored in the right order (3–4 of them) and shuffled when played; a
//            player must put them back in this order. No `correct`.
// See rightSet().
// `seconds` falls back to the section's, then DEFAULT_SECONDS. `points` is 1000 (normal, the default), 2000 (double)
// or 0 (nobody scores). Problems use `c` for the section and `i` for the question, like a board's category and tile.
import { KINDS } from './crazy.js';

export const MAX_CATEGORIES = 6;
export const MAX_QUESTIONS = 6;
export const MAX_UNVEIL = 120; // seconds for a slowly appearing picture (question field `unveil`)
// Pictures and sound clips are files in the files folder, named like "3fa9c0d1e2.jpg".
export const IMAGE_NAME = /^[\w-]{1,80}\.(png|jpe?g|gif|webp|svg)$/i;
export const AUDIO_NAME = /^[\w-]{1,80}\.(mp3|m4a|aac|ogg|oga|opus|wav|webm)$/i;
export const FILE_NAME = { test: (name) => IMAGE_NAME.test(name) || AUDIO_NAME.test(name) };

// Quick quiz limits.
export const MAX_SECTIONS = 10;
export const MAX_SECTION_QUESTIONS = 30;
export const MAX_OPTIONS = 4;
export const MAX_OPTION = 80; // letters in one answer option
export const MIN_SECONDS = 5;
export const MAX_SECONDS = 120;
export const DEFAULT_SECONDS = 20;
export const QUICK_POINTS = [0, 1000, 2000]; // no points, normal, double
export const QUESTION_TYPES = ['choice', 'multi', 'order'];
export const MIN_ORDER_OPTIONS = 3; // a "put in order" question with 2 answers would be a coin toss

// The kind of a Quick quiz question (or of `state.q`): 'choice' when the field is missing (every older quiz).
export const typeOf = (q) => (q?.type === undefined || q.type === null || q.type === '' ? 'choice' : q.type);

// The right options of a Quick quiz question (or of `state.q`), as a sorted list of indices. `correct` is one
// index (one right answer, as older quizzes are saved) or a list (several right answers). Anything else gives [].
export function rightSet(q) {
  const c = q?.correct;
  const list = Array.isArray(c) ? c : c === undefined || c === null ? [] : [c];
  return [...new Set(list.filter(Number.isInteger))].sort((a, b) => a - b);
}

// Which kind of game a quiz is: 'quick' (multiple choice in sections) or 'board' (Jeopardy, the default).
export const modeOf = (set) => (set?.kind === 'quick' ? 'quick' : 'board');

export function validateSet(set) {
  const problems = [];
  const add = (code, c, i, r) => problems.push({ code, ...(c !== undefined && { c }), ...(i !== undefined && { i }), ...(r && { r }) });

  if (!set || typeof set !== 'object') return [{ code: 'not-a-set' }];
  if (!text(set.title)) add('no-title');
  if (modeOf(set) === 'quick') {
    checkQuick(set.sections, add);
    return problems;
  }
  if (!checkBoard(set.categories, add)) return problems;
  if (set.round2 !== undefined && set.round2 !== null) {
    checkBoard(set.round2?.categories, (code, c, i) => add(code, c, i, 2));
  }

  if (set.final !== undefined && set.final !== null) {
    const f = set.final;
    if (!text(f.category)) add('no-final-category');
    if (!text(f.question) && !f.image && !f.audio) add('no-final-question');
    if (!text(f.answer)) add('no-final-answer');
    if (!imageOk(f.image) || !imageOk(f.answerImage)) add('bad-image');
    if (!audioOk(f)) add('bad-audio');
  }
  return problems;
}

const text = (x) => typeof x === 'string' && x.trim() !== '';

// One board's categories and questions. Returns false when there is no board at all.
function checkBoard(categories, add) {
  if (!Array.isArray(categories) || categories.length === 0) {
    add('no-categories');
    return false;
  }
  if (categories.length > MAX_CATEGORIES) add('too-many-categories');

  categories.forEach((cat, c) => {
    if (!text(cat?.name)) add('no-category-name', c);
    if (!Array.isArray(cat?.questions) || cat.questions.length === 0) {
      add('no-questions', c);
      return;
    }
    if (cat.questions.length > MAX_QUESTIONS) add('too-many-questions', c);
    cat.questions.forEach((q, i) => {
      if (!Number.isInteger(q?.value) || q.value <= 0) add('bad-value', c, i);
      if (!text(q?.question) && !q?.image && !q?.audio) add('no-question', c, i); // a picture or a clip on its own is a question too
      if (!text(q?.answer)) add('no-answer', c, i);
      if (!imageOk(q?.image) || !imageOk(q?.answerImage)) add('bad-image', c, i);
      if (!audioOk(q)) add('bad-audio', c, i);
      if (q?.special !== undefined && q.special !== null && q.special !== '' && !KINDS.includes(q.special)) add('bad-special', c, i);
      if (q?.image && q.unveil !== undefined && q.unveil !== null && !(typeof q.unveil === 'number' && q.unveil >= 1 && q.unveil <= MAX_UNVEIL)) add('bad-unveil', c, i);
    });
  });
  return true;
}

// A Quick quiz's sections and their multiple-choice questions.
function checkQuick(sections, add) {
  const secondsOk = (x) => x === undefined || x === null || (Number.isInteger(x) && x >= MIN_SECONDS && x <= MAX_SECONDS);
  if (!Array.isArray(sections) || sections.length === 0) return add('no-sections');
  if (sections.length > MAX_SECTIONS) add('too-many-sections');
  sections.forEach((sec, c) => {
    if (!text(sec?.name)) add('no-section-name', c);
    if (!secondsOk(sec?.seconds)) add('bad-seconds', c);
    if (!Array.isArray(sec?.questions) || sec.questions.length === 0) return add('no-questions', c);
    if (sec.questions.length > MAX_SECTION_QUESTIONS) add('too-many-section-questions', c);
    sec.questions.forEach((q, i) => {
      if (!text(q?.question) && !q?.image && !q?.audio) add('no-question', c, i);
      const options = Array.isArray(q?.options) ? q.options : [];
      if (options.length < 2 || options.length > MAX_OPTIONS || !options.every(text)) add('bad-options', c, i);
      const type = typeOf(q);
      if (!QUESTION_TYPES.includes(type)) add('bad-type', c, i);
      if (type === 'order') {
        // The options themselves are the answer, in the order they're written: just enough of them.
        if (options.length < MIN_ORDER_OPTIONS) add('order-options', c, i);
      } else {
        // At least one right option, all of them real options, and (when a player picks one) not all of them,
        // since then nobody could be wrong. "Tick all" may have every option right.
        const marked = Array.isArray(q?.correct) ? q.correct : [q?.correct];
        const inRange = (n) => Number.isInteger(n) && n >= 0 && n < options.length;
        if (marked.length === 0 || !marked.every(inRange) || new Set(marked).size !== marked.length) add('bad-correct', c, i);
        else if (type === 'choice' && options.length >= 2 && marked.length >= options.length) add('all-correct', c, i);
      }
      if (!secondsOk(q?.seconds)) add('bad-seconds', c, i);
      if (q?.points !== undefined && q.points !== null && !QUICK_POINTS.includes(q.points)) add('bad-points', c, i);
      if (!imageOk(q?.image)) add('bad-image', c, i);
      if (!audioOk(q)) add('bad-audio', c, i);
    });
  });
}

function audioOk(q) {
  const name = q?.audio;
  if (name !== undefined && name !== null && name !== '' && !(typeof name === 'string' && AUDIO_NAME.test(name))) return false;
  const start = q?.audioStart;
  return start === undefined || start === null || (typeof start === 'number' && start >= 0 && start < 36000);
}

function imageOk(name) {
  return name === undefined || name === null || name === '' || (typeof name === 'string' && IMAGE_NAME.test(name));
}

// ----- picture credits -----
// Pictures found with the editor's "Find a free picture" (pictures.js) keep who made them and their licence, in the
// quiz as `credits: { "<file name>": { title, author, license, licenseUrl, source, sourceUrl } }`. Credits can never
// make a quiz unplayable, so they are tidied (cleanCredits), never reported as problems.
export const PICTURE_SOURCES = ['openverse', 'wikimedia'];
const CREDIT_TEXT = { title: 200, author: 120, license: 60 };
const MAX_CREDIT_URL = 500;

// Every picture and clip a quiz uses (both boards, a Quick quiz's sections and the final).
export function usedFiles(set) {
  const names = new Set();
  const add = (q) => {
    for (const k of ['image', 'answerImage', 'audio']) if (q?.[k]) names.add(q[k]);
  };
  for (const c of [...(set?.categories ?? []), ...(set?.round2?.categories ?? []), ...(set?.sections ?? [])]) for (const q of c?.questions ?? []) add(q);
  add(set?.final);
  return [...names];
}

const creditText = (s, max) =>
  typeof s === 'string'
    ? s
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : '';
const httpsUrl = (s) => {
  if (typeof s !== 'string' || s.length > MAX_CREDIT_URL) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
};

// Only credits of pictures the quiz still uses, with short texts and https links (anything else is dropped).
export function cleanCredits(credits, used = []) {
  const out = {};
  if (!credits || typeof credits !== 'object' || Array.isArray(credits)) return out;
  const keep = new Set(used);
  for (const [name, c] of Object.entries(credits)) {
    if (!IMAGE_NAME.test(name) || !keep.has(name) || !c || typeof c !== 'object') continue;
    const e = {};
    for (const [k, max] of Object.entries(CREDIT_TEXT)) {
      const v = creditText(c[k], max);
      if (v) e[k] = v;
    }
    if (!e.title && !e.author && !e.license) continue;
    if (PICTURE_SOURCES.includes(c.source)) e.source = c.source;
    for (const k of ['licenseUrl', 'sourceUrl']) {
      const u = httpsUrl(c[k]);
      if (u) e[k] = u;
    }
    out[name] = e;
  }
  return out;
}
