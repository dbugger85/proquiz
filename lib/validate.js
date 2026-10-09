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
import { KINDS } from './crazy.js';

export const MAX_CATEGORIES = 6;
export const MAX_QUESTIONS = 6;
export const MAX_UNVEIL = 120; // seconds for a slowly appearing picture (question field `unveil`)
// Pictures and sound clips are files in the files folder, named like "3fa9c0d1e2.jpg".
export const IMAGE_NAME = /^[\w-]{1,80}\.(png|jpe?g|gif|webp|svg)$/i;
export const AUDIO_NAME = /^[\w-]{1,80}\.(mp3|m4a|aac|ogg|oga|opus|wav|webm)$/i;
export const FILE_NAME = { test: (name) => IMAGE_NAME.test(name) || AUDIO_NAME.test(name) };

export function validateSet(set) {
  const problems = [];
  const add = (code, c, i, r) => problems.push({ code, ...(c !== undefined && { c }), ...(i !== undefined && { i }), ...(r && { r }) });

  if (!set || typeof set !== 'object') return [{ code: 'not-a-set' }];
  if (!text(set.title)) add('no-title');
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

function audioOk(q) {
  const name = q?.audio;
  if (name !== undefined && name !== null && name !== '' && !(typeof name === 'string' && AUDIO_NAME.test(name))) return false;
  const start = q?.audioStart;
  return start === undefined || start === null || (typeof start === 'number' && start >= 0 && start < 36000);
}

function imageOk(name) {
  return name === undefined || name === null || name === '' || (typeof name === 'string' && IMAGE_NAME.test(name));
}
