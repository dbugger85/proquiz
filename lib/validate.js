// Checks a question set before it's used or saved. Shared by the server and the editor.
// Returns a list of problems ({ code, c?, i? }); an empty list means the set is fine.
//
// Shape: { v: 1, title, categories: [{ name, questions: [{ value, question, answer, image?, answerImage? }] }], final?: { category, question, answer, image?, answerImage? } }
// `image` shows with the question, `answerImage` only when the answer is revealed. Both are file names in the images folder.

export const MAX_CATEGORIES = 6;
export const MAX_QUESTIONS = 6;
// Pictures are files in the images folder, named like "3fa9c0d1e2.jpg".
export const IMAGE_NAME = /^[\w-]{1,80}\.(png|jpe?g|gif|webp|svg)$/i;

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
      if (!text(q?.question) && !q?.image) add('no-question', c, i); // a picture on its own is a question too
      if (!text(q?.answer)) add('no-answer', c, i);
      if (!imageOk(q?.image) || !imageOk(q?.answerImage)) add('bad-image', c, i);
    });
  });

  if (set.final !== undefined && set.final !== null) {
    const f = set.final;
    if (!text(f.category)) add('no-final-category');
    if (!text(f.question) && !f.image) add('no-final-question');
    if (!text(f.answer)) add('no-final-answer');
    if (!imageOk(f.image) || !imageOk(f.answerImage)) add('bad-image');
  }
  return problems;
}

function imageOk(name) {
  return name === undefined || name === null || name === '' || (typeof name === 'string' && IMAGE_NAME.test(name));
}
