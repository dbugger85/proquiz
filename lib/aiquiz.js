// Making a quiz with AI by copy and paste. ProQuiz never talks to the internet: the editor shows the request
// from buildRequest(), the host pastes it into Claude or ChatGPT, and parseReply() turns the pasted answer
// into a quiz. Shared by the editor and the tests (no DOM).
import { validateSet, rightSet, MAX_CATEGORIES, MAX_QUESTIONS, MAX_SECTIONS, MAX_SECTION_QUESTIONS, MAX_OPTIONS, MAX_OPTION } from './validate.js';

export const DIFFICULTIES = ['kids', 'easy', 'medium', 'hard', 'expert'];
export const MIN_SIZE = 3;
export const AI_ERRORS = ['empty', 'no-json', 'broken-json', 'not-a-quiz', 'nothing-filled'];
export const FILL_DIFFICULTIES = ['match', ...DIFFICULTIES];
export const KINDS = ['board', 'quick']; // a Jeopardy board, or a Quick quiz (multiple choice in sections)
export const QUICK_SECTIONS = [1, 2, 3, 4, 5, 6]; // the choices in the editor's AI dialog
export const QUICK_PER_SECTION = [3, 4, 5, 6, 8, 10, 12, 15];

// The same limits the editor's text boxes have.
const MAX_NAME = 40;
const MAX_TITLE = 80;
const MAX_QUESTION = 300;
const MAX_ANSWER = 120;

const LEVELS = {
  kids: 'For children aged 5 to 9. Simple words and short sentences, about things children know from school, cartoons, animals, food and everyday life. Answers of 1 to 3 easy words.',
  easy: 'Easy: things most adults know. A relaxed family quiz where nearly every question gets answered.',
  medium: 'Medium: a normal pub quiz. A typical team knows about half of the answers.',
  hard: 'Hard: for keen quiz players. Specific facts, but still fair and not obscure trivia.',
  expert: 'Expert: for quiz fanatics. Detailed knowledge that only real enthusiasts of each topic will know.',
};

const EXAMPLE = {
  en: {
    title: 'Friday quiz',
    categories: [
      { name: 'Animals', questions: [{ value: 100, question: 'Which animal says moo?', answer: 'A cow' }, { value: 200, question: 'How many legs does a spider have?', answer: 'Eight' }] },
      { name: 'Space', questions: [{ value: 100, question: 'Which planet do we live on?', answer: 'Earth' }, { value: 200, question: 'What is the closest star to Earth?', answer: 'The Sun' }] },
    ],
    final: { category: 'Rivers', question: 'Which river flows through Cairo?', answer: 'The Nile' },
  },
  no: {
    title: 'Fredagsquiz',
    categories: [
      { name: 'Dyr', questions: [{ value: 100, question: 'Hvilket dyr sier mø?', answer: 'En ku' }, { value: 200, question: 'Hvor mange bein har en edderkopp?', answer: 'Åtte' }] },
      { name: 'Verdensrommet', questions: [{ value: 100, question: 'Hvilken planet bor vi på?', answer: 'Jorda' }, { value: 200, question: 'Hva heter stjernen nærmest jorda?', answer: 'Sola' }] },
    ],
    final: { category: 'Elver', question: 'Hvilken elv renner gjennom Kairo?', answer: 'Nilen' },
  },
};

// Round 2's part of the format example (points start at double).
const EXAMPLE_ROUND2 = {
  en: {
    categories: [
      { name: 'Music', questions: [{ value: 200, question: 'How many strings does a standard guitar have?', answer: 'Six' }, { value: 400, question: 'Who composed the Moonlight Sonata?', answer: 'Beethoven' }] },
    ],
  },
  no: {
    categories: [
      { name: 'Musikk', questions: [{ value: 200, question: 'Hvor mange strenger har en vanlig gitar?', answer: 'Seks' }, { value: 400, question: 'Hvem komponerte Måneskinnssonaten?', answer: 'Beethoven' }] },
    ],
  },
};

// The format example for a Quick quiz. The right option is given by its text ("answer"), which AIs copy more
// reliably than a position; parseReply() turns it into `correct`. A question where several options are right
// (any of them counts) has a list of them as "answer".
const EXAMPLE_QUICK = {
  en: {
    title: 'Friday quick quiz',
    sections: [
      {
        name: 'Animals',
        questions: [
          { question: 'Which animal says moo?', options: ['Horse', 'Cow', 'Sheep', 'Pig'], answer: 'Cow' },
          { question: 'How many legs does a spider have?', options: ['Six', 'Ten', 'Twelve', 'Eight'], answer: 'Eight' },
          { question: 'Which of these is a mammal?', options: ['Whale', 'Shark', 'Bat', 'Frog'], answer: ['Whale', 'Bat'] },
        ],
      },
      {
        name: 'Space',
        questions: [
          { question: 'True or false: the Sun is a star.', options: ['True', 'False'], answer: 'True' },
          { question: 'Which planet is closest to the Sun?', options: ['Venus', 'Earth', 'Mercury', 'Mars'], answer: 'Mercury' },
        ],
      },
    ],
  },
  no: {
    title: 'Fredagens lynquiz',
    sections: [
      {
        name: 'Dyr',
        questions: [
          { question: 'Hvilket dyr sier mø?', options: ['Hest', 'Ku', 'Sau', 'Gris'], answer: 'Ku' },
          { question: 'Hvor mange bein har en edderkopp?', options: ['Seks', 'Ti', 'Tolv', 'Åtte'], answer: 'Åtte' },
          { question: 'Hvilket av disse er et pattedyr?', options: ['Hval', 'Hai', 'Flaggermus', 'Frosk'], answer: ['Hval', 'Flaggermus'] },
        ],
      },
      {
        name: 'Verdensrommet',
        questions: [
          { question: 'Sant eller usant: Sola er en stjerne.', options: ['Sant', 'Usant'], answer: 'Sant' },
          { question: 'Hvilken planet er nærmest sola?', options: ['Venus', 'Jorda', 'Merkur', 'Mars'], answer: 'Merkur' },
        ],
      },
    ],
  },
};

const RULES = [
  '- Every answer is short (1 to 5 words) with one clear right answer, so the host can judge it at once.',
  '- Every question is clear and has only one possible answer. No multiple choice and no true or false.',
  '- The answer must not appear in the question.',
  '- No two questions may have the same answer or ask about the same fact.',
  '- Only use facts you are sure are true. If you are unsure, choose another question.',
  '- Text only: no pictures, sounds or links.',
];

export class AiQuizError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// One topic per line (commas inside a line are part of the topic).
export function splitTopics(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export const valuesFor = (rows) => Array.from({ length: rows }, (_, i) => (i + 1) * 100);

// The text the host copies to the AI. Always in English (AIs follow English instructions best);
// the quiz itself is written in `lang`.
// With `round2`, it also asks for a second board with double points (`round2Topics`, one per line, optional).
// With `kind: 'quick'` it asks for a Quick quiz instead (see buildQuickRequest()).
export function buildRequest(opts = {}) {
  if (opts.kind === 'quick') return buildQuickRequest(opts);
  return buildBoardRequest(opts);
}

function buildBoardRequest({ topics = '', examples = '', difficulty = 'medium', categories = 5, rows = 5, final = true, round2 = false, round2Topics = '', lang = 'en' } = {}) {
  const wanted = splitTopics(topics).slice(0, categories);
  const extra = categories - wanted.length;
  const values = valuesFor(rows);
  const wanted2 = splitTopics(round2Topics).slice(0, categories);
  const extra2 = categories - wanted2.length;
  const base = structuredClone(EXAMPLE[lang] ?? EXAMPLE.en);
  const example = { title: base.title, categories: base.categories };
  if (round2) example.round2 = structuredClone(EXAMPLE_ROUND2[lang] ?? EXAMPLE_ROUND2.en);
  if (final) example.final = base.final;
  const ownExamples = String(examples ?? '').trim();
  const lines = [
    'Make a quiz for ProQuiz, a Jeopardy-style quiz game. Teams buzz in on their phones and say their answer out loud to the host.',
    '',
    'THE BOARD',
    `- Exactly ${categories} categories with exactly ${rows} questions each.`,
    `- The points in every category are ${values.join(', ')}. The ${values[0]} question is the easiest in its category and the ${values.at(-1)} question is the hardest.`,
    wanted.length
      ? `- Use these topics as the categories, in this order: ${wanted.map((x) => `"${x}"`).join(', ')}. You may give a category a short, catchy name, but keep its topic.`
      : `- Choose ${categories} varied, fun categories yourself.`,
    wanted.length && extra > 0 ? `- Then add ${extra} more ${extra === 1 ? 'category' : 'categories'} of your own that suit the same players.` : null,
    final
      ? '- Also make one final question in its own category, a little harder than the rest. Teams bet points on it and type their answer.'
      : '- No final question.',
    ...(round2
      ? [
          '',
          'ROUND 2',
          `- Also make a second board, "round2", played after the first one: exactly ${categories} new categories with exactly ${rows} questions each.`,
          `- The points in every round 2 category are ${values.map((v) => v * 2).join(', ')}, from the easiest to the hardest.`,
          wanted2.length
            ? `- Use these topics for round 2, in this order: ${wanted2.map((x) => `"${x}"`).join(', ')}.${extra2 > 0 ? ` Then add ${extra2} more of your own.` : ''}`
            : `- Choose ${categories} new categories yourself, clearly different from the first board's.`,
          '- Round 2 is a step harder than the first board.',
          '- No question in round 2 may ask about the same fact, or have the same answer, as a question on the first board.',
        ]
      : []),
    '',
    'DIFFICULTY',
    `- ${LEVELS[difficulty] ?? LEVELS.medium}`,
    '',
    'QUESTIONS AND ANSWERS',
    ...RULES,
    lang === 'no'
      ? '- Write the title, the category names, the questions and the answers in Norwegian (bokmål).'
      : '- Write the title, the category names, the questions and the answers in English.',
    ...(ownExamples ? ['', 'EXAMPLES OF THE KIND OF QUESTIONS I WANT (do not reuse them)', ownExamples] : []),
    '',
    'HOW TO REPLY',
    '- Reply with one JSON code block and nothing else, in exactly this format. This example is smaller than the board you must make, and its questions must not be reused:',
    '```json',
    // One question per line keeps the example short.
    JSON.stringify(example, null, 2).replace(/\{\s+("value": \d+),\s+("question": ".*"),\s+("answer": ".*")\s+\}/g, '{ $1, $2, $3 }'),
    '```',
    '- Give the quiz a short, fun "title". "value" is a whole number.',
    '- Straight double quotes, no comments, no trailing commas and no other fields.',
  ];
  return lines.filter((line) => line !== null).join('\n');
}

// The request for a Quick quiz: `sections` named groups of `perSection` multiple-choice questions each.
// Topics (one per line) become the sections.
export function buildQuickRequest({ topics = '', examples = '', difficulty = 'medium', sections = 3, perSection = 5, lang = 'en' } = {}) {
  const wanted = splitTopics(topics).slice(0, sections);
  const extra = sections - wanted.length;
  const example = structuredClone(EXAMPLE_QUICK[lang] ?? EXAMPLE_QUICK.en);
  const ownExamples = String(examples ?? '').trim();
  const trueFalse = lang === 'no' ? '["Sant", "Usant"]' : '["True", "False"]';
  const lines = [
    'Make a multiple-choice quiz for ProQuiz. The question and its options are shown on a TV, and every player picks an option on their phone. The faster a right answer, the more points.',
    '',
    'THE QUIZ',
    `- Exactly ${sections} ${sections === 1 ? 'section' : 'sections'} with exactly ${perSection} questions each. A section is a named group of questions, like a round in a pub quiz.`,
    wanted.length
      ? `- Use these topics for the sections, in this order: ${wanted.map((x) => `"${x}"`).join(', ')}. You may give a section a short, catchy name, but keep its topic.`
      : `- Choose ${sections === 1 ? 'a fun topic' : `${sections} varied, fun topics`} for the ${sections === 1 ? 'section' : 'sections'} yourself.`,
    wanted.length && extra > 0 ? `- Then add ${extra} more ${extra === 1 ? 'section' : 'sections'} of your own that suit the same players.` : null,
    '- Within a section, start easy and get a little harder.',
    '',
    'DIFFICULTY',
    `- ${LEVELS[difficulty] ?? LEVELS.medium}`,
    '',
    'QUESTIONS AND OPTIONS',
    '- Every question has exactly 4 options, and usually exactly one of them is right.',
    '- "answer" is the right option, copied exactly from "options".',
    '- At most 1 in 5 questions may instead have 2 or 3 right options, where any of them counts (for example "Which of these is a mammal?"). Players still pick just one option. Then "answer" is a list of all the right options, each copied exactly from "options". Never make every option right.',
    `- At most 1 in 5 questions may be a true-or-false question instead, with exactly the 2 options ${trueFalse}.`,
    '- Put the right option in a different place from question to question, spread evenly over the four places.',
    '- The wrong options are believable but clearly wrong. Never "all of the above" or "none of the above".',
    '- Every option is short: 1 to 5 words, at most 60 characters.',
    '- Every question is short enough to read in a few seconds: at most 120 characters.',
    '- The right answer must not appear in the question.',
    '- No two questions may ask about the same fact.',
    '- Only use facts you are sure are true. If you are unsure, choose another question.',
    '- Text only: no pictures, sounds or links.',
    lang === 'no'
      ? '- Write the title, the section names, the questions and the options in Norwegian (bokmål).'
      : '- Write the title, the section names, the questions and the options in English.',
    ...(ownExamples ? ['', 'EXAMPLES OF THE KIND OF QUESTIONS I WANT (do not reuse them)', ownExamples] : []),
    '',
    'HOW TO REPLY',
    '- Reply with one JSON code block and nothing else, in exactly this format. This example is smaller than the quiz you must make, and its questions must not be reused:',
    '```json',
    // One question per line keeps the example short.
    JSON.stringify(example, null, 2).replace(
      /\{\s+("question": ".*"),\s+"options": \[\s+([^\]]*?)\s+\],\s+"answer": (".*"|\[[^\]]*?\])\s+\}/g,
      (_, q, opts, a) => `{ ${q}, "options": [${opts.split(/,\s+/).join(', ')}], "answer": ${a.startsWith('[') ? `[${a.slice(1, -1).trim().split(/,\s+/).join(', ')}]` : a} }`,
    ),
    '```',
    '- Give the quiz a short, fun "title".',
    '- Straight double quotes, no comments, no trailing commas and no other fields.',
  ];
  return lines.filter((line) => line !== null).join('\n');
}

// Small, common mistakes in AI replies: curly quotes around keys and values, commas before } or ],
// and // comments on their own line or after a value.
export function repairJson(text) {
  return String(text)
    .replace(/([{[,:]\s*)[“”„‟]/g, '$1"')
    .replace(/[“”„‟](\s*[:,}\]])/g, '"$1')
    .replace(/^\s*\/\/[^\n]*$/gm, '')
    .replace(/([,{[]\s*)\/\/[^\n]*$/gm, '$1')
    .replace(/,(\s*[}\]])/g, '$1');
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// The JSON part of a reply: the code block if there is one, otherwise the text from the first { to the last }.
function jsonPart(text) {
  const fenced = [...text.matchAll(/```[\w-]*\s*\n?([\s\S]*?)```/g)].map((m) => m[1]).find((block) => block.includes('{'));
  const from = fenced ?? text;
  const start = from.indexOf('{');
  const end = from.lastIndexOf('}');
  return start >= 0 && end > start ? from.slice(start, end + 1) : null;
}

const str = (x, max) => (typeof x === 'string' || typeof x === 'number' ? String(x).trim().slice(0, max) : '');

function toValue(x, i, step = 100) {
  const n = Number.parseInt(String(x ?? ''), 10);
  return Number.isInteger(n) && n > 0 ? n : (i + 1) * step;
}

// A board from a reply: names, and value/question/answer only (cut to the editor's lengths).
function readBoard(cats, step) {
  return cats
    .filter((cat) => cat && typeof cat === 'object')
    .slice(0, MAX_CATEGORIES)
    .map((cat) => ({
      name: str(cat.name ?? cat.category, MAX_NAME),
      questions: (Array.isArray(cat.questions) ? cat.questions : []).slice(0, MAX_QUESTIONS).map((q, i) => ({
        value: toValue(q?.value, i, step),
        question: str(q?.question, MAX_QUESTION),
        answer: str(q?.answer, MAX_ANSWER),
      })),
    }));
}

// Turns a pasted AI answer into a quiz. Throws AiQuizError for text that can't be used at all; otherwise
// returns the quiz and its problems (a draft with problems is still fine: the editor shows them).
// `duplicates` lists answers that appear more than once.
// The quiz object in a pasted reply, or an AiQuizError.
function readQuiz(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new AiQuizError('empty');
  const part = jsonPart(raw);
  if (!part) throw new AiQuizError('no-json');
  const data = tryParse(part) ?? tryParse(repairJson(part));
  if (data === undefined) throw new AiQuizError('broken-json');
  const some = (x) => Array.isArray(x) && x.length > 0;
  if (!data || typeof data !== 'object' || !(some(data.categories) || some(data.sections))) throw new AiQuizError('not-a-quiz');
  return data;
}

// A reply with `sections` (and no board, or `kind: 'quick'` asked for) becomes a Quick quiz.
export function parseReply(text, { final = true, round2 = true, title = 'AI quiz', kind } = {}) {
  const data = readQuiz(text);
  const hasBoard = Array.isArray(data.categories) && data.categories.length > 0;
  const hasSections = Array.isArray(data.sections) && data.sections.length > 0;
  if (hasSections && (kind === 'quick' || !hasBoard)) return parseQuick(data, title);
  if (!hasBoard) throw new AiQuizError('not-a-quiz');

  const set = {
    v: 1,
    title: str(data.title, MAX_TITLE) || title,
    categories: data.categories.slice(0, MAX_CATEGORIES).map((cat) => ({
      name: str(cat?.name ?? cat?.category, MAX_NAME),
      questions: (Array.isArray(cat?.questions) ? cat.questions : []).slice(0, MAX_QUESTIONS).map((q, i) => ({
        value: toValue(q?.value, i),
        question: str(q?.question, MAX_QUESTION),
        answer: str(q?.answer, MAX_ANSWER),
      })),
    })),
  };
  const r2 = Array.isArray(data.round2?.categories) ? readBoard(data.round2.categories, 200) : [];
  if (round2 && r2.length) set.round2 = { categories: r2 };
  const f = data.final;
  if (final && f && typeof f === 'object') {
    set.final = { category: str(f.category ?? f.name, MAX_NAME), question: str(f.question, MAX_QUESTION), answer: str(f.answer, MAX_ANSWER) };
  }

  return { set, problems: validateSet(set), duplicates: duplicatesIn(set) };
}

// Which options are right: "answer" (or "answers", "correct", "right") as an option's text, its position counting
// from 0, or a letter A–D, or a list of those when several are right. Returns the indices found (sorted; empty when
// it can't be told, and the editor then asks to mark it).
function rightOptions(q, options) {
  const norm = (x) => String(x ?? '').trim().toLowerCase();
  const one = (x) => {
    if (x === undefined || x === null || x === '' || typeof x === 'object') return -1;
    const byText = options.findIndex((o) => norm(o) === norm(x));
    if (byText >= 0) return byText;
    if (Number.isInteger(x) && x >= 0 && x < options.length) return x;
    const letter = /^[a-d]$/i.test(String(x).trim()) ? String(x).trim().toLowerCase().charCodeAt(0) - 97 : -1;
    return letter < options.length ? letter : -1;
  };
  for (const x of [q?.answer, q?.answers, q?.correct, q?.right]) {
    const found = (Array.isArray(x) ? x : [x]).map(one).filter((n) => n >= 0);
    if (found.length) return [...new Set(found)].sort((a, b) => a - b);
  }
  return [];
}

// A Quick quiz from a reply: section names, and question/options/right answer only (cut to the editor's lengths).
function parseQuick(data, title) {
  const list = (x) => (Array.isArray(x) ? x.filter((y) => y && typeof y === 'object') : []);
  const set = {
    v: 1,
    kind: 'quick',
    title: str(data.title, MAX_TITLE) || title,
    sections: list(data.sections)
      .slice(0, MAX_SECTIONS)
      .map((sec) => ({
        name: str(sec.name ?? sec.section ?? sec.title, MAX_NAME),
        questions: list(sec.questions)
          .slice(0, MAX_SECTION_QUESTIONS)
          .map((q) => {
            const options = (Array.isArray(q.options) ? q.options : Array.isArray(q.choices) ? q.choices : [])
              .map((o) => str(o && typeof o === 'object' ? o.text : o, MAX_OPTION))
              .filter(Boolean)
              .slice(0, MAX_OPTIONS);
            const out = { question: str(q.question, MAX_QUESTION), options };
            const right = rightOptions(q, options);
            if (right.length) out.correct = right.length === 1 ? right[0] : right; // a list only when several are right
            return out;
          }),
      })),
  };
  return { set, problems: validateSet(set), duplicates: duplicatesIn(set) };
}

// Answers that appear more than once ("the", "a", "en" … in front don't count). In a Quick quiz these are
// the right options, except on true-or-false questions.
const quickAnswers = (set) =>
  (set.sections ?? []).flatMap((sec) => sec.questions.filter((q) => q.options.length > 2).flatMap((q) => rightSet(q).map((n) => ({ answer: q.options[n] }))));
function duplicatesIn(set) {
  const seen = new Map();
  const all = set.kind === 'quick' ? quickAnswers(set) : [...allCategories(set).flatMap((c) => c.questions), ...(set.final ? [set.final] : [])];
  for (const q of all) {
    const answer = String(q.answer ?? '').trim();
    const key = answer.toLowerCase().replace(/^(the|a|an|en|et|ei)\s+/, '');
    if (key) seen.set(key, [...(seen.get(key) ?? []), answer]);
  }
  return [...seen.values()].filter((list) => list.length > 1).map((list) => list[0]);
}

// ----- filling only the empty spots of a quiz that is already started -----

const has = (x) => typeof x === 'string' && x.trim() !== '';
const KEEP = '[keep]';
const allCategories = (set) => [...set.categories, ...(set.round2?.categories ?? [])];
const boardOf = (set, r) => (r === 2 ? (set.round2?.categories ?? []) : set.categories);

// What is missing. A tile with no text at all needs both; a question without an answer needs the answer;
// an answer without a question needs the question. A picture or clip question without text can't be
// seen by the AI, so it is left alone (`skipped`).
// Round 2's tiles have `r: 2`, and its nameless categories are in `names2`.
export function gapsOf(set) {
  const tiles = [];
  const names = [];
  const names2 = [];
  let skipped = 0;
  for (const r of [1, 2]) {
    boardOf(set, r).forEach((cat, c) => {
      const at = (x) => (r === 2 ? { ...x, r } : x);
      if (!has(cat.name)) (r === 2 ? names2 : names).push(c);
      cat.questions.forEach((q, i) => {
        const media = Boolean(q.image || q.audio);
        const text = has(q.question);
        const answer = has(q.answer);
        if (!text && !answer && !media) tiles.push(at({ c, i, need: 'both' }));
        else if (text && !answer) tiles.push(at({ c, i, need: 'answer' }));
        else if (!text && answer && !media) tiles.push(at({ c, i, need: 'question' }));
        else if (!answer) skipped++;
      });
    });
  }
  let final = null;
  const f = set.final;
  if (f) {
    const need = [];
    if (!has(f.category)) need.push('category');
    const media = Boolean(f.image || f.audio);
    if (!has(f.question) && !media) need.push('question');
    if (!has(f.answer) && (has(f.question) || !media)) need.push('answer');
    else if (!has(f.answer)) skipped++;
    if (need.length) final = need;
  }
  const count = tiles.length + names.length + names2.length + (final ? 1 : 0);
  return { tiles, names, names2, final, skipped, count };
}

// Which language the quiz is written in: 'no' for Norwegian, 'en' for English, null with no text yet.
export function guessLanguage(set) {
  const text = [set.title, ...allCategories(set).flatMap((c) => [c.name, ...c.questions.flatMap((q) => [q.question, q.answer])]), set.final?.question, set.final?.answer]
    .filter(has)
    .join(' ')
    .toLowerCase();
  if (!text.replace(/[^a-zæøå]/g, '')) return null;
  const words = text.split(/[^a-zæøå]+/);
  const norwegian = /[æøå]/.test(text) ? 3 : 0;
  const count = (list) => words.filter((w) => list.includes(w)).length;
  const no = norwegian + count(['og', 'hva', 'hvilken', 'hvilket', 'hvilke', 'hvem', 'hvor', 'hvordan', 'er', 'det', 'en', 'et', 'som', 'heter', 'av', 'på', 'ikke', 'mange']);
  const en = count(['and', 'what', 'which', 'who', 'where', 'how', 'is', 'the', 'a', 'of', 'in', 'does', 'many', 'called', 'name']);
  return no > en ? 'no' : 'en';
}

// The quiz as the AI sees it: only text, with "" for what is missing and [keep] for what it must leave.
function sketch(set) {
  const q = (x, final = false) => {
    const media = x.image ? '[picture]' : x.audio ? '[sound clip]' : '';
    const question = has(x.question) ? x.question.trim() : media;
    const answer = has(x.answer) ? x.answer.trim() : media && !has(x.question) ? KEEP : '';
    return final ? { category: has(x.category) ? x.category.trim() : '', question, answer } : { value: x.value, question, answer };
  };
  const board = (cats) => cats.map((cat) => ({ name: has(cat.name) ? cat.name.trim() : '', questions: cat.questions.map((x) => q(x)) }));
  const out = { title: set.title ?? '', categories: board(set.categories) };
  if (set.round2) out.round2 = { categories: board(set.round2.categories ?? []) };
  if (set.final) out.final = q(set.final, true);
  return out;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The request for filling the gaps. `difficulty` is 'match' (like the questions already there) or a level,
// `topics` (one per line) are used for categories that are completely empty.
export function buildFillRequest(set, { difficulty = 'match', topics = '', lang = guessLanguage(set) ?? 'en' } = {}) {
  const gaps = gapsOf(set);
  const written = allCategories(set).flatMap((c) => c.questions).filter((x) => has(x.question) && has(x.answer)).length;
  const level = difficulty === 'match' && written === 0 ? 'medium' : difficulty;
  const both = gaps.tiles.filter((g) => g.need === 'both').length;
  const answers = gaps.tiles.filter((g) => g.need === 'answer').length;
  const questions = gaps.tiles.filter((g) => g.need === 'question').length;
  const nameless = [...gaps.names.map((c) => set.categories[c]), ...gaps.names2.map((c) => set.round2.categories[c])];
  const emptyCats = nameless.filter((cat) => cat.questions.every((x) => !has(x.question) && !has(x.answer) && !x.image && !x.audio));
  const namedFromQuestions = nameless.length - emptyCats.length;
  const wanted = splitTopics(topics).slice(0, emptyCats.length);
  const values = [...new Set(set.categories.flatMap((c) => c.questions.map((x) => x.value)))].filter((v) => v > 0).sort((a, b) => a - b);
  const languageName = lang === 'no' ? 'Norwegian (bokmål)' : 'English';
  const hasMedia = allCategories(set).some((c) => c.questions.some((x) => x.image || x.audio)) || Boolean(set.final?.image || set.final?.audio);

  const lines = [
    'I am making a quiz for ProQuiz, a Jeopardy-style quiz game. Teams buzz in on their phones and say their answer out loud to the host.',
    'Part of the quiz is already written. Fill in ONLY the parts that are missing, so the new questions fit in with the ones that are there.',
    '',
    'THE QUIZ SO FAR (every "" is missing)',
    '```json',
    JSON.stringify(sketch(set), null, 2).replace(/\{\s+("value": \d+),\s+("question": ".*"),\s+("answer": ".*")\s+\}/g, '{ $1, $2, $3 }'),
    '```',
    '',
    'WHAT TO FILL IN',
    set.round2
      ? '- The quiz has two boards: "categories" is played first, then "round2", with more points and a step harder. Fill the gaps on both.'
      : null,
    both ? `- ${plural(both, 'empty tile needs', 'empty tiles need')} a question and an answer.` : null,
    answers ? `- ${plural(answers, 'question needs its', 'questions need their')} answer: write the right answer to exactly that question, and do not change the question.` : null,
    questions ? `- ${plural(questions, 'answer needs a question', 'answers need a question')}: write a question whose right answer is exactly that answer, and do not change the answer.` : null,
    namedFromQuestions ? `- ${plural(namedFromQuestions, 'category has', 'categories have')} questions but no name: give ${namedFromQuestions === 1 ? 'it' : 'each'} a short, catchy name that sums up its questions.` : null,
    emptyCats.length && wanted.length
      ? `- ${plural(emptyCats.length, 'category is', 'categories are')} completely empty. Use these topics for them, in order: ${wanted.map((x) => `"${x}"`).join(', ')}${wanted.length < emptyCats.length ? ', then choose new topics yourself for the rest' : ''}. Give each a short, catchy name.`
      : emptyCats.length
        ? `- ${plural(emptyCats.length, 'category is', 'categories are')} completely empty: choose ${emptyCats.length === 1 ? 'a new topic' : 'new topics'} that suit the same players as the rest of the quiz and are clearly different from the other categories. Give each a short, catchy name and fill all its questions.`
        : null,
    gaps.final?.includes('category') ? '- The final question needs a category.' : null,
    gaps.final?.includes('question') && gaps.final?.includes('answer')
      ? '- The final question needs a question and an answer, a little harder than the rest. Teams bet points on it and type their answer.'
      : gaps.final?.includes('question')
        ? '- The final question needs a question whose right answer is exactly its answer.'
        : gaps.final?.includes('answer')
          ? '- The final question needs the right answer to its question.'
          : null,
    has(set.title) ? null : '- The quiz needs a short, fun "title".',
    '',
    'KEEP WHAT IS THERE',
    '- Do not change, reword, move or remove anything that is already filled in, including every "value". Keep the categories and questions in the same order.',
    hasMedia ? `- "[picture]" and "[sound clip]" are questions with a picture or a sound you can't see, and "${KEEP}" is an answer to leave alone. Copy them exactly as they are.` : null,
    '',
    'MATCH THE QUIZ',
    '- Every new question must fit the topic of its category.',
    level === 'match'
      ? `- Difficulty: match the questions that are already there, in how hard they are, how long they are and their style. Within a category, more points means harder${values.length > 1 ? `: ${values[0]} is the easiest and ${values.at(-1)} the hardest` : ''}.`
      : `- Difficulty: ${LEVELS[level] ?? LEVELS.medium} Within a category, more points means harder${values.length > 1 ? `: ${values[0]} is the easiest and ${values.at(-1)} the hardest` : ''}.`,
    `- Write everything new in ${languageName}, like the rest of the quiz.`,
    '- No new question may ask about the same fact, or have the same answer, as any other question in the quiz, including the ones already there.',
    '',
    'QUESTIONS AND ANSWERS',
    ...RULES,
    '',
    'HOW TO REPLY',
    '- Reply with one JSON code block and nothing else: the whole quiz in exactly the same format as above, with every "" filled in.',
    '- Straight double quotes, no comments, no trailing commas and no other fields.',
  ];
  return lines.filter((line) => line !== null).join('\n');
}

// Which category of the reply belongs to each category of the quiz. Named categories are found by name;
// the others take the reply's leftover categories, at the same place if it is free, otherwise the next free one.
function matchBoard(cats, reply) {
  const norm = (x) => String(x ?? '').trim().toLowerCase();
  const replyCats = (Array.isArray(reply) ? reply : []).filter((cat) => cat && typeof cat === 'object');
  const matched = cats.map((cat) => (has(cat.name) ? replyCats.find((rc) => norm(rc.name ?? rc.category) === norm(cat.name)) : undefined));
  const taken = new Set(matched.filter(Boolean));
  cats.forEach((cat, c) => {
    if (matched[c]) return;
    const free = [...replyCats.slice(c), ...replyCats.slice(0, c)].find((rc) => !taken.has(rc));
    if (free) (matched[c] = free), taken.add(free);
  });
  return matched;
}

const usable = (x, max) => {
  const text = str(x, max);
  return text && text !== KEEP && !/^\[(picture|sound clip)\]$/i.test(text) ? text : '';
};

// Fills the gaps of `set` from a pasted reply, without ever changing what was already there.
// Categories are matched by name when the AI moved them, questions by points when it moved those.
// Returns { set, filled: ["c-i", …], names, final, left, duplicates }; throws AiQuizError when nothing could be used.
export function parseFill(text, set) {
  const data = readQuiz(text);
  const out = structuredClone(set);
  const gaps = gapsOf(set);
  const matched = { 1: matchBoard(set.categories, data.categories), 2: matchBoard(set.round2?.categories ?? [], data.round2?.categories) };
  const questionFor = (r, c, i) => {
    const list = Array.isArray(matched[r][c]?.questions) ? matched[r][c].questions : [];
    const value = boardOf(set, r)[c].questions[i].value;
    const at = list[i];
    if (at && (at.value === undefined || toValue(at.value, i, r * 100) === value)) return at;
    return list.find((q) => q && toValue(q.value, -1) === value) ?? at;
  };

  const filled = [];
  for (const g of gaps.tiles) {
    const r = g.r ?? 1;
    const rq = questionFor(r, g.c, g.i);
    const q = boardOf(out, r)[g.c].questions[g.i];
    const question = usable(rq?.question, MAX_QUESTION);
    const answer = usable(rq?.answer, MAX_ANSWER);
    let done = false;
    if (g.need !== 'answer' && question) (q.question = question), (done = true);
    if (g.need !== 'question' && answer) (q.answer = answer), (done = true);
    if (done) filled.push(r === 2 ? `2:${g.c}-${g.i}` : `${g.c}-${g.i}`);
  }
  let names = 0;
  for (const [r, list] of [[1, gaps.names], [2, gaps.names2]]) {
    for (const c of list) {
      const name = usable(matched[r][c]?.name ?? matched[r][c]?.category, MAX_NAME);
      if (name) (boardOf(out, r)[c].name = name), names++;
    }
  }
  let final = false;
  if (gaps.final && data.final && typeof data.final === 'object') {
    const f = out.final;
    const take = (key, max, from = key) => {
      const value = usable(data.final[from], max);
      if (gaps.final.includes(key) && value) (f[key] = value), (final = true);
    };
    take('category', MAX_NAME);
    if (!usable(data.final.category, MAX_NAME)) take('category', MAX_NAME, 'name');
    take('question', MAX_QUESTION);
    take('answer', MAX_ANSWER);
  }
  if (!has(out.title) && usable(data.title, MAX_TITLE)) out.title = usable(data.title, MAX_TITLE);
  if (!filled.length && !names && !final) throw new AiQuizError('nothing-filled');
  return { set: out, filled, names, final, left: gapsOf(out).count, duplicates: duplicatesIn(out) };
}
