// Checks a question set before it's used or saved. Shared by the server and the editor.
// Returns a list of problems ({ code, c?, i? }); an empty list means the set is fine.
//
// Shape: { v: 1, title, categories: [{ name, questions: [{ value, question, answer, image?, answerImage?, audio?, audioStart? }] }],
//          final?: { category, question, answer, image?, answerImage?, audio?, audioStart? } }
// `image` shows with the question, `answerImage` only when the answer is revealed, `audio` plays on the TV
// (from `audioStart` seconds). All three are file names in the files folder.

export const MAX_CATEGORIES = 6;
export const MAX_QUESTIONS = 6;
// Pictures and sound clips are files in the files folder, named like "3fa9c0d1e2.jpg".
export const IMAGE_NAME = /^[\w-]{1,80}\.(png|jpe?g|gif|webp|svg)$/i;
export const AUDIO_NAME = /^[\w-]{1,80}\.(mp3|m4a|aac|ogg|oga|opus|wav|webm)$/i;
export const FILE_NAME = { test: (name) => IMAGE_NAME.test(name) || AUDIO_NAME.test(name) };

export function validateSet(set) {
  const problems = [];
  const add = (code, c, i) => problems.push({ code, ...(c !== undefined && { c }), ...(i !== undefined && { i }) });
  const text = (x) => typeof x === 'string' && x.trim() !== '';

  if (!set || typeof set !== 'object') return [{ code: 'not-a-set' }];
  if (!text(set.title)) add('no-title');
  if (!Array.isArray(set.categories) || set.categories.length === 0) {
    add('no-categories');
    return problems;
  }
  if (set.categories.length > MAX_CATEGORIES) add('too-many-categories');

  set.categories.forEach((cat, c) => {
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
    });
  });

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

function audioOk(q) {
  const name = q?.audio;
  if (name !== undefined && name !== null && name !== '' && !(typeof name === 'string' && AUDIO_NAME.test(name))) return false;
  const start = q?.audioStart;
  return start === undefined || start === null || (typeof start === 'number' && start >= 0 && start < 36000);
}

function imageOk(name) {
  return name === undefined || name === null || name === '' || (typeof name === 'string' && IMAGE_NAME.test(name));
}
