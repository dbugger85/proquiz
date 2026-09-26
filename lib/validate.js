// Checks a question set before it's used or saved. Shared by the server and the editor.
// Returns a list of problems ({ code, c?, i? }); an empty list means the set is fine.
//
// Shape: { v: 1, title, categories: [{ name, questions: [{ value, question, answer }] }], final?: { category, question, answer } }

export const MAX_CATEGORIES = 6;
export const MAX_QUESTIONS = 6;

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
      if (!text(q?.question)) add('no-question', c, i);
      if (!text(q?.answer)) add('no-answer', c, i);
    });
  });

  if (set.final !== undefined && set.final !== null) {
    const f = set.final;
    if (!text(f.category)) add('no-final-category');
    if (!text(f.question)) add('no-final-question');
    if (!text(f.answer)) add('no-final-answer');
  }
  return problems;
}
