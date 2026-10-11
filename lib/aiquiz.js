// Making a quiz with AI by copy and paste. ProQuiz never talks to the internet: the editor shows the request
// from buildRequest(), the host pastes it into Claude or ChatGPT, and parseReply() turns the pasted answer
// into a quiz. Shared by the editor and the tests (no DOM).
import { validateSet, rightSet, typeOf, MAX_CATEGORIES, MAX_QUESTIONS, MAX_SECTIONS, MAX_SECTION_QUESTIONS, MAX_OPTIONS, MAX_OPTION, MIN_ORDER_OPTIONS } from './validate.js';
import { mainLang, languageName, missingTranslations, translationSlots, slotTranslation, setSlotTranslation } from './languages.js';

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

// The format example for a Quick quiz. Every question says its "type" (since 2026-10-11: the owner's first AI quiz
// came back without types, and its "tick all" and "put in order" questions were read as ordinary ones): "choice"
// (pick one), "multi" (tick all that are right, "answer" lists every right option), "order" (the options written in
// the right order, no "answer") or the rare "any" (pick one, but any of several right options counts). The right
// option is given by its text ("answer"), which AIs copy more reliably than a position; parseReply() turns it into
// `correct`. No question says how many options are right.
const EXAMPLE_QUICK = {
  en: {
    title: 'Friday quick quiz',
    sections: [
      {
        name: 'Animals',
        questions: [
          { question: 'Which animal says moo?', type: 'choice', options: ['Horse', 'Cow', 'Sheep', 'Pig'], answer: 'Cow' },
          { question: 'How many legs does a spider have?', type: 'choice', options: ['Six', 'Ten', 'Twelve', 'Eight'], answer: 'Eight' },
          { question: 'Which of these are mammals?', type: 'multi', options: ['Whale', 'Shark', 'Bat', 'Frog'], answer: ['Whale', 'Bat'] },
        ],
      },
      {
        name: 'Space and time',
        questions: [
          { question: 'True or false: the Sun is a star.', type: 'choice', options: ['True', 'False'], answer: 'True' },
          { question: 'Which planet is closest to the Sun?', type: 'choice', options: ['Venus', 'Earth', 'Mercury', 'Mars'], answer: 'Mercury' },
          { question: 'Put these in order, oldest to newest.', type: 'order', options: ['Pyramids of Giza', 'Colosseum', 'Eiffel Tower', 'Sydney Opera House'] },
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
          { question: 'Hvilket dyr sier mø?', type: 'choice', options: ['Hest', 'Ku', 'Sau', 'Gris'], answer: 'Ku' },
          { question: 'Hvor mange bein har en edderkopp?', type: 'choice', options: ['Seks', 'Ti', 'Tolv', 'Åtte'], answer: 'Åtte' },
          { question: 'Hvilke av disse er pattedyr?', type: 'multi', options: ['Hval', 'Hai', 'Flaggermus', 'Frosk'], answer: ['Hval', 'Flaggermus'] },
        ],
      },
      {
        name: 'Rom og tid',
        questions: [
          { question: 'Sant eller usant: Sola er en stjerne.', type: 'choice', options: ['Sant', 'Usant'], answer: 'Sant' },
          { question: 'Hvilken planet er nærmest sola?', type: 'choice', options: ['Venus', 'Jorda', 'Merkur', 'Mars'], answer: 'Merkur' },
          { question: 'Sett disse i rekkefølge, fra eldst til nyest.', type: 'order', options: ['Pyramidene i Giza', 'Colosseum', 'Eiffeltårnet', 'Operaen i Oslo'] },
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

// The rules for a Quick quiz's questions and options, shared by the request for a new quiz and the one that fills
// the empty spots. `trueFalse` is the two options of a true-or-false question in the quiz's language.
const quickRules = (trueFalse) => [
  '- EVERY question has a "type": "choice", "multi", "order" or "any". Never leave it out. The game plays each type differently, so a question with the wrong type (or none) is played wrong.',
  '- "choice" (most questions): exactly 4 options and exactly one of them is right. Players pick one option. "answer" is the right option, copied exactly from "options".',
  `- A "choice" question may also be a true-or-false question (at most 1 in 5), with exactly the 2 options ${trueFalse}.`,
  '- "multi" (at most 1 in 5 questions): "tick all that are right". "answer" is a list of every right option (2 or more; every option may be right), each copied exactly from "options". Players must tick exactly these. Use "multi" whenever the question asks for several things ("Which of these are…").',
  '- "order" (at most 1 in 5 questions): "put in order". The question says which way to sort (for example "oldest to newest" or "smallest to largest"), "options" are 3 or 4 items written in the right order, and there is no "answer". The game shuffles them for the players. Use "order" whenever the question asks to sort, rank or arrange.',
  '- "any" (rare, at most 1 in 10 questions): like "choice", but 2 or 3 options are right and picking any one of them counts. Players still pick just one option. "answer" is a list of all the right options, each copied exactly from "options". Never make every option right.',
  '- Never say in the question how many options are right (not "two are right", not "pick two"). The screens tell the players what kind of question it is.',
  '- Put the right option in a different place from question to question, spread evenly over the four places.',
  '- The wrong options are believable but clearly wrong. Never "all of the above" or "none of the above".',
  '- Every option is short: 1 to 5 words, at most 60 characters.',
  '- Every question is short enough to read in a few seconds: at most 120 characters.',
  '- The right answer must not appear in the question.',
  '- No two questions may ask about the same fact.',
  '- Only use facts you are sure are true. If you are unsure, choose another question.',
  '- Text only: no pictures, sounds or links.',
];

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
    ...quickRules(trueFalse),
    lang === 'no'
      ? '- Write the title, the section names, the questions and the options in Norwegian (bokmål).'
      : '- Write the title, the section names, the questions and the options in English.',
    ...(ownExamples ? ['', 'EXAMPLES OF THE KIND OF QUESTIONS I WANT (do not reuse them)', ownExamples] : []),
    '',
    'HOW TO REPLY',
    '- Reply with one JSON code block and nothing else, in exactly this format. This example is smaller than the quiz you must make, and its questions must not be reused:',
    '```json',
    // One question per line keeps the example short ("type" and "answer" are there only when the question has them).
    JSON.stringify(example, null, 2).replace(
      /\{\s+("question": ".*")(,\s+"type": "\w+")?,\s+"options": \[\s+([^\]]*?)\s+\](?:,\s+"answer": (".*"|\[[^\]]*?\]))?\s+\}/g,
      (_, q, type, opts, a) => {
        const list = (x) => `[${x.trim().split(/,\s+/).join(', ')}]`;
        return `{ ${q}${type ? `, ${type.trim().slice(1).trim()}` : ''}, "options": ${list(opts)}${a ? `, "answer": ${a.startsWith('[') ? list(a.slice(1, -1)) : a}` : ''} }`;
      },
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

// The JSON part of a reply: the code block if there is one, otherwise the text from the first { to the last }
// (or, with `list`, from the first [ to the last ] when the reply is a bare list).
function jsonPart(text, { list = false } = {}) {
  const fenced = [...text.matchAll(/```[\w-]*\s*\n?([\s\S]*?)```/g)].map((m) => m[1]).find((block) => block.includes('{') || (list && block.includes('[')));
  const from = fenced ?? text;
  const cut = (open, close) => {
    const start = from.indexOf(open);
    const end = from.lastIndexOf(close);
    return start >= 0 && end > start ? from.slice(start, end + 1) : null;
  };
  const obj = cut('{', '}');
  if (!list) return obj;
  const arr = cut('[', ']');
  // A bare list, or a list that starts before the first object in it.
  return arr && (!obj || from.indexOf('[') < from.indexOf('{')) ? arr : obj;
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
// The JSON in a pasted reply (an object, or with `list` a bare list too), or an AiQuizError.
function readJson(text, opts) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new AiQuizError('empty');
  const part = jsonPart(raw, opts);
  if (!part) throw new AiQuizError('no-json');
  const data = tryParse(part) ?? tryParse(repairJson(part));
  if (data === undefined) throw new AiQuizError('broken-json');
  return data;
}

// The quiz object in a pasted reply, or an AiQuizError.
function readQuiz(text) {
  const data = readJson(text);
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

// The kind of a question in a reply: "type" (or "kind"/"style") as 'choice', 'multi', 'order' or their common other
// names, with "any"/"either" (pick one, any of several right options counts) read as 'choice' too. Null when the
// reply gives no type, or one that isn't known: then guessType() reads the question's wording.
const TYPE_NAMES = {
  choice: ['choice', 'single', 'single choice', 'single-choice', 'one', 'pick one', 'pickone', 'pick-one', 'multiple choice', 'multiple-choice', 'multiplechoice', 'mc', 'normal', 'standard', 'default', 'true/false', 'true or false', 'truefalse', 'boolean'],
  any: ['any', 'either', 'any of', 'anyof', 'any-of', 'any of these', 'any counts', 'several'],
  multi: ['multi', 'multiple', 'tickall', 'tick-all', 'tick_all', 'tick all', 'checkbox', 'checkboxes', 'multiselect', 'multi-select', 'multi_select', 'select all', 'select-all', 'selectall', 'all that apply'],
  order: ['order', 'ordering', 'ranking', 'rank', 'sort', 'sorting', 'sequence', 'arrange', 'chronological'],
};
function typeIn(q) {
  const raw = String(q?.type ?? q?.kind ?? q?.style ?? '').trim().toLowerCase();
  const found = Object.keys(TYPE_NAMES).find((k) => TYPE_NAMES[k].includes(raw));
  return found === 'any' ? 'choice' : found ?? null;
}

// What a question's wording says about its kind, for a reply that left the type out (and for the editor's check of
// one that says "choice" but reads like something else).
// Sorting words: sort, order, rank, arrange, "oldest to newest", "smallest to largest" … in English and Norwegian
// (sorter, rekkefølge, ranger, "fra eldst til nyest" …).
const ORDER_WORDS = /\b(sort|sorts|sorted|sorting|arrange|arranged|rank|ranked|ranking|order|ordering|chronological|chronologically|sequence|sorter|sortere|sortér|sorterte|ranger|rangere|rangér|rekkefølge|rekkefølgen|kronologisk|ordne)\b/i;
// "from oldest to newest", "fra minst til størst", "first to last", "eldst til nyest" (superlatives end in -st/-ste).
const RANGE_WORDS = /\b(from |fra )?(\w{3,}st|\w{3,}ste|first|last|først|førstemann|sist)\s+(to|til)\s+(the\s+|det\s+|den\s+|de\s+)?(\w{3,}st|\w{3,}ste|first|last|først|sist)\b/i;
// Plural wording: "which of these are", "which … are/were", "select all", "tick all", "all that apply", "which ones";
// Norwegian "hvilke" is the plural of "hvilken/hvilket" on its own.
const PLURAL_WORDS = /\b(which|what)\b[^?]*\b(are|were)\b|\b(select|tick|choose|mark|pick|check|name|find) (all|every|each)\b|\ball that apply\b|\bwhich ones\b|\bhvilke\b|\b(kryss av|velg|merk|finn) alle\b|\balle som\b/i;
export const looksLikeOrder = (question) => ORDER_WORDS.test(String(question ?? '')) || RANGE_WORDS.test(String(question ?? ''));
export const looksLikeMulti = (question) => PLURAL_WORDS.test(String(question ?? ''));

// A reply without a type: sorting words make it "put in order"; a list of 2 or more right options with plural wording
// makes it "tick all"; otherwise it is an ordinary question (a list of right options stays "any of them counts").
function guessType(question, nRight) {
  if (looksLikeOrder(question)) return 'order';
  if (nRight >= 2 && looksLikeMulti(question)) return 'multi';
  return 'choice';
}

// A Quick quiz from a reply: section names, and question/type/options/right answer only (cut to the editor's
// lengths). A "put in order" question whose reply lists the right order (as "answer" or "order", by text) gets its
// options put in that order.
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
        questions: list(sec.questions).slice(0, MAX_SECTION_QUESTIONS).map(readQuickQuestion),
      })),
  };
  return { set, problems: validateSet(set), duplicates: duplicatesIn(set), summary: summarizeQuick(set) };
}

// What was read, for the editor's note after a paste: how many questions of each kind (`any` = pick one with several
// right options), and `suspects`: the pick-one questions whose wording sounds like "tick all" or "put in order" but
// were not read as one (the reply said "choice", or had no type and only one right option), so the host checks them.
// `only(c, i)` limits it to some questions (the ones a fill touched).
export function summarizeQuick(set, only = () => true) {
  const out = { questions: 0, choice: 0, multi: 0, order: 0, any: 0, suspects: [] };
  (set.sections ?? []).forEach((sec, c) => {
    (sec.questions ?? []).forEach((q, i) => {
      if (!only(c, i)) return;
      out.questions++;
      const type = typeOf(q);
      if (type !== 'choice') out[type]++;
      else if (rightSet(q).length > 1) out.any++;
      else out.choice++;
      if (type !== 'choice') return;
      const looks = looksLikeOrder(q.question) ? 'order' : looksLikeMulti(q.question) ? 'multi' : null;
      if (looks) out.suspects.push({ c, i, looks, question: q.question });
    });
  });
  return out;
}

// The options of a question in a reply: texts (or {text}), empty ones dropped, at most MAX_OPTIONS.
const replyOptions = (q) =>
  (Array.isArray(q?.options) ? q.options : Array.isArray(q?.choices) ? q.choices : [])
    .map((o) => str(o && typeof o === 'object' ? o.text : o, MAX_OPTION))
    .filter(Boolean)
    .slice(0, MAX_OPTIONS);

// One Quick quiz question from a reply: question, type (only multi/order), options and `correct`. A missing type is
// guessed from the wording (see guessType()); a type the reply gives is always kept.
function readQuickQuestion(q) {
  const options = replyOptions(q);
  const given = typeIn(q);
  const type = given ?? guessType(q.question, rightOptions(q, options).length);
  const out = { question: str(q.question, MAX_QUESTION), ...(type !== 'choice' && { type }), options };
  if (type === 'order') {
    const given = [q.answer, q.answers, q.order, q.correct].find((x) => Array.isArray(x) && x.length === options.length);
    const by = given?.map((x) => options.findIndex((o) => o.toLowerCase() === String(x ?? '').trim().toLowerCase()));
    if (by && new Set(by).size === options.length && !by.includes(-1)) out.options = by.map((n) => options[n]);
    return out;
  }
  const right = rightOptions(q, options);
  if (right.length) out.correct = right.length === 1 && type !== 'multi' ? right[0] : right; // a list when several are right, and always for "tick all"
  return out;
}

// Answers that appear more than once ("the", "a", "en" … in front don't count). In a Quick quiz these are
// the right options, except on true-or-false questions and "put in order" questions (every option is part of the answer).
const quickAnswers = (set) =>
  (set.sections ?? []).flatMap((sec) => sec.questions.filter((q) => q.options.length > 2 && typeOf(q) !== 'order').flatMap((q) => rightSet(q).map((n) => ({ answer: q.options[n] }))));
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
// A Quick quiz gives the shape of quickGapsOf() instead (`opts.target` = fill every section up to that many questions).
export function gapsOf(set, opts = {}) {
  return set.kind === 'quick' ? quickGapsOf(set, opts) : boardGapsOf(set);
}

function boardGapsOf(set) {
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
  const parts =
    set.kind === 'quick'
      ? [set.title, ...(set.sections ?? []).flatMap((s) => [s.name, ...s.questions.flatMap((q) => [q.question, ...(q.options ?? [])])])]
      : [set.title, ...allCategories(set).flatMap((c) => [c.name, ...c.questions.flatMap((q) => [q.question, q.answer])]), set.final?.question, set.final?.answer];
  const text = parts
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
// A Quick quiz gets its own request (see buildQuickFillRequest(); `target` fills every section up to that many questions).
export function buildFillRequest(set, opts = {}) {
  return set.kind === 'quick' ? buildQuickFillRequest(set, opts) : buildBoardFillRequest(set, opts);
}

function buildBoardFillRequest(set, { difficulty = 'match', topics = '', lang = guessLanguage(set) ?? 'en' } = {}) {
  const gaps = boardGapsOf(set);
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
function matchBoard(cats, reply, nameOf = (rc) => rc.name ?? rc.category) {
  const norm = (x) => String(x ?? '').trim().toLowerCase();
  const replyCats = (Array.isArray(reply) ? reply : []).filter((cat) => cat && typeof cat === 'object');
  const matched = cats.map((cat) => (has(cat.name) ? replyCats.find((rc) => norm(nameOf(rc)) === norm(cat.name)) : undefined));
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
// A Quick quiz goes to parseQuickFill() (`opts.target` as in buildFillRequest()).
export function parseFill(text, set, opts = {}) {
  return set.kind === 'quick' ? parseQuickFill(text, set, opts) : parseBoardFill(text, set);
}

function parseBoardFill(text, set) {
  const data = readQuiz(text);
  const out = structuredClone(set);
  const gaps = boardGapsOf(set);
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

// ----- filling the empty spots of a Quick quiz -----

export const MIN_FILL_TARGET = 1;
const TRUE_FALSE_WORDS = ['true', 'false', 'sant', 'usant', 'yes', 'no', 'ja', 'nei', 'rett', 'galt', 'riktig', 'feil', 'right', 'wrong'];
const quickOptions = (q) => (Array.isArray(q.options) ? q.options : []).map((o) => (typeof o === 'string' ? o.trim() : ''));
const writtenOptions = (q) => quickOptions(q).filter(Boolean);

// A true-or-false question is complete with its 2 options: both are yes/no words, or the question says so.
export function isTrueFalse(q) {
  const options = writtenOptions(q);
  if (options.length !== 2) return false;
  if (options.every((o) => TRUE_FALSE_WORDS.includes(o.toLowerCase()))) return true;
  return /^(true or false|sant eller usant|rett eller galt|riktig eller galt)\b/i.test(String(q.question ?? '').trim());
}

// How many options a question should have: 2 for a true-or-false question, otherwise 4; and the fewest it can do
// with (a "put in order" question is fine with 3).
const wantedOptions = (q) => (isTrueFalse(q) ? 2 : MAX_OPTIONS);
const minOptions = (q) => (isTrueFalse(q) ? 2 : typeOf(q) === 'order' ? MIN_ORDER_OPTIONS : MAX_OPTIONS);

// What a Quick quiz is missing. Every question is listed with what it needs: 'question' (no text), 'options' (fewer
// than 4 written, unless it is a true-or-false question with its 2) and 'correct' (no right option marked; never for
// "put in order"). A picture or clip question without text can't be seen by the AI, so it is left alone (`skipped`).
// `target` (the editor's "fill each section up to N questions") adds `toAdd` new questions at the end of the sections
// that have fewer; `count` is everything together.
export function quickGapsOf(set, { target = 0 } = {}) {
  const questions = [];
  const names = [];
  const toAdd = [];
  let skipped = 0;
  const upTo = Math.min(MAX_SECTION_QUESTIONS, Math.max(0, Number(target) || 0));
  (set.sections ?? []).forEach((sec, c) => {
    if (!has(sec.name)) names.push(c);
    sec.questions.forEach((q, i) => {
      const need = [];
      const text = has(q.question);
      const media = Boolean(q.image || q.audio);
      if (!text) need.push('question');
      if (writtenOptions(q).length < minOptions(q)) need.push('options');
      if (typeOf(q) !== 'order' && !rightSet(q).some((n) => has(quickOptions(q)[n]))) need.push('correct');
      if (!need.length) return;
      if (!text && media) skipped++;
      else questions.push({ c, i, need });
    });
    const n = upTo - sec.questions.length;
    if (n > 0) toAdd.push({ c, n });
  });
  const extra = toAdd.reduce((sum, x) => sum + x.n, 0);
  return { questions, names, toAdd, extra, skipped, count: questions.length + names.length + extra };
}

// The most questions any section has, at least 5 and at most 30: the editor's starting value for "fill up to".
export const suggestedTarget = (set) => Math.min(MAX_SECTION_QUESTIONS, Math.max(5, ...(set.sections ?? []).map((s) => s.questions.length)));

// The Quick quiz as the AI sees it: "" for what is missing (options padded to 4, or 2 for true or false), "answer" the
// right option(s) by text, "[picture]"/"[sound clip]" for a question it can't see (with "[keep]" as its answer), and
// the sections topped up with empty questions to `target`.
function quickSketch(set, target) {
  const blank = { question: '', type: '', options: ['', '', '', ''], answer: '' };
  const one = (q) => {
    const type = typeOf(q);
    const options = quickOptions(q);
    const media = q.image ? '[picture]' : q.audio ? '[sound clip]' : '';
    const hidden = !has(q.question) && media;
    const written = options.filter(Boolean);
    const pad = !hidden && written.length < minOptions(q) ? wantedOptions(q) - written.length : 0;
    const shown = [...written, ...Array(pad).fill('')];
    const right = rightSet(q).map((n) => options[n]).filter(Boolean);
    // Every question carries its type: "any" is a pick-one question where any of several right options counts.
    const out = { question: has(q.question) ? q.question.trim() : media, type: blankQuick(q) ? '' : type === 'choice' && right.length > 1 ? 'any' : type, options: shown };
    if (type !== 'order') out.answer = right.length > 1 || (right.length && type === 'multi') ? right : right[0] ?? (hidden ? KEEP : '');
    return out;
  };
  const upTo = Math.min(MAX_SECTION_QUESTIONS, Math.max(0, Number(target) || 0));
  return {
    title: set.title ?? '',
    sections: (set.sections ?? []).map((sec) => ({
      name: has(sec.name) ? sec.name.trim() : '',
      questions: [...sec.questions.map(one), ...Array(Math.max(0, upTo - sec.questions.length)).fill(blank)],
    })),
  };
}

const blankQuick = (q) => !has(q.question) && !writtenOptions(q).length && !q.image && !q.audio;

// Which section of the reply belongs to each section of the quiz: named sections by name, nameless ones by a question
// they share with the reply (the AI may have named and moved them), and the rest take the leftover sections by place.
function matchSections(secs, reply) {
  const norm = (x) => String(x ?? '').trim().toLowerCase();
  const replySecs = (Array.isArray(reply) ? reply : []).filter((rs) => rs && typeof rs === 'object');
  const nameOf = (rs) => rs.name ?? rs.section ?? rs.title;
  const texts = (rs) => (Array.isArray(rs.questions) ? rs.questions : []).map((q) => norm(q?.question)).filter(Boolean);
  const matched = secs.map((sec) => (has(sec.name) ? replySecs.find((rs) => norm(nameOf(rs)) === norm(sec.name)) : undefined));
  const taken = new Set(matched.filter(Boolean));
  const take = (c, rs) => rs && ((matched[c] = rs), taken.add(rs));
  secs.forEach((sec, c) => {
    if (matched[c]) return;
    const mine = sec.questions.map((q) => norm(q.question)).filter(Boolean);
    if (mine.length) take(c, replySecs.find((rs) => !taken.has(rs) && texts(rs).some((x) => mine.includes(x))));
  });
  secs.forEach((sec, c) => {
    if (!matched[c]) take(c, [...replySecs.slice(c), ...replySecs.slice(0, c)].find((rs) => !taken.has(rs)));
  });
  return matched;
}

// The request for filling a Quick quiz's gaps: the quiz so far as JSON, what to fill, and the same rules as a new quiz.
function buildQuickFillRequest(set, { difficulty = 'match', topics = '', target = 0, lang = guessLanguage(set) ?? 'en' } = {}) {
  const gaps = quickGapsOf(set, { target });
  const all = (set.sections ?? []).flatMap((s) => s.questions);
  const written = all.filter((q) => has(q.question) && writtenOptions(q).length >= 2).length;
  const level = difficulty === 'match' && written === 0 ? 'medium' : difficulty;
  const whole = gaps.questions.filter((g) => g.need.includes('question')).length;
  const options = gaps.questions.filter((g) => !g.need.includes('question') && g.need.includes('options')).length;
  const answers = gaps.questions.filter((g) => !g.need.includes('question') && !g.need.includes('options') && g.need.includes('correct')).length;
  const nameless = gaps.names.map((c) => set.sections[c]);
  const emptySecs = nameless.filter((sec) => sec.questions.every(blankQuick));
  const namedFromQuestions = nameless.length - emptySecs.length;
  const wanted = splitTopics(topics).slice(0, emptySecs.length);
  const languageName = lang === 'no' ? 'Norwegian (bokmål)' : 'English';
  const trueFalse = lang === 'no' ? '["Sant", "Usant"]' : '["True", "False"]';
  const hasMedia = all.some((q) => q.image || q.audio);
  const sketch = JSON.stringify(quickSketch(set, target), null, 2).replace(
    /\{\s+("question": ".*")(,\s+"type": "\w*")?,\s+"options": \[\s*([^\]]*?)\s*\](?:,\s+"answer": (".*"|\[[^\]]*?\]))?\s+\}/g,
    (_, q, type, opts, a) => {
      const list = (x) => `[${x.trim() ? x.trim().split(/,\s+/).join(', ') : ''}]`;
      return `{ ${q}${type ? `, ${type.trim().slice(1).trim()}` : ''}, "options": ${list(opts)}${a ? `, "answer": ${a.startsWith('[') ? list(a.slice(1, -1)) : a}` : ''} }`;
    },
  );

  const lines = [
    'I am making a multiple-choice quiz for ProQuiz. The question and its options are shown on a TV, and every player picks an option on their phone. The faster a right answer, the more points.',
    'Part of the quiz is already written. Fill in ONLY the parts that are missing, so the new questions fit in with the ones that are there.',
    '',
    'THE QUIZ SO FAR (every "" is missing)',
    '```json',
    sketch,
    '```',
    '',
    'WHAT TO FILL IN',
    whole + gaps.extra ? `- ${plural(whole + gaps.extra, 'empty question needs', 'empty questions need')} a question, its "type", its options and the "answer".` : null,
    gaps.extra ? `- ${plural(gaps.extra, 'of them is a new question', 'of them are new questions')} at the end of ${gaps.toAdd.length === 1 ? 'a section' : 'their sections'}: write ${gaps.extra === 1 ? 'it' : 'them'} after the questions that are there, a little harder than the ones before.` : null,
    options ? `- ${plural(options, 'question needs', 'questions need')} the missing options (every ""): fill in only the empty places, and keep the options that are there exactly where they are. The question and its "answer" stay as they are.` : null,
    gaps.questions.some((g) => g.need.includes('options') && typeOf(set.sections[g.c].questions[g.i]) === 'order')
      ? '- For a "put in order" question with empty places, write all its options in the right order, 3 or 4 in all: the ones that are there may move to their right places, but keep their words.'
      : null,
    answers ? `- ${plural(answers, 'question needs its', 'questions need their')} "answer": the right option, copied exactly from its "options" (a list when several are right). Do not change the question or the options.` : null,
    namedFromQuestions ? `- ${plural(namedFromQuestions, 'section has', 'sections have')} questions but no name: give ${namedFromQuestions === 1 ? 'it' : 'each'} a short, catchy name that sums up its questions.` : null,
    emptySecs.length && wanted.length
      ? `- ${plural(emptySecs.length, 'section is', 'sections are')} completely empty. Use these topics for them, in order: ${wanted.map((x) => `"${x}"`).join(', ')}${wanted.length < emptySecs.length ? ', then choose new topics yourself for the rest' : ''}. Give each a short, catchy name.`
      : emptySecs.length
        ? `- ${plural(emptySecs.length, 'section is', 'sections are')} completely empty: choose ${emptySecs.length === 1 ? 'a new topic' : 'new topics'} that suit the same players as the rest of the quiz and are clearly different from the other sections. Give each a short, catchy name and fill all its questions.`
        : null,
    has(set.title) ? null : '- The quiz needs a short, fun "title".',
    '',
    'KEEP WHAT IS THERE',
    '- Do not change, reword, move or remove anything that is already filled in: not a question, not an option, not an "answer" and not a "type". Keep the sections, the questions and the options in the same order and the same places.',
    hasMedia ? `- "[picture]" and "[sound clip]" are questions with a picture or a sound you can't see, and "${KEEP}" is an answer to leave alone. Copy them exactly as they are.` : null,
    '',
    'MATCH THE QUIZ',
    '- Every new question must fit the topic of its section.',
    level === 'match'
      ? '- Difficulty: match the questions that are already there, in how hard they are, how long they are and their style. Within a section, later questions are a little harder.'
      : `- Difficulty: ${LEVELS[level] ?? LEVELS.medium} Within a section, later questions are a little harder.`,
    `- Write everything new in ${languageName}, like the rest of the quiz.`,
    '- No new question may ask about the same fact as any other question in the quiz, including the ones already there.',
    '',
    'QUESTIONS AND OPTIONS',
    ...quickRules(trueFalse),
    '',
    'HOW TO REPLY',
    '- Reply with one JSON code block and nothing else: the whole quiz in exactly the same format as above, with every "" filled in.',
    '- Straight double quotes, no comments, no trailing commas and no other fields.',
  ];
  return lines.filter((line) => line !== null).join('\n');
}

// Fills a Quick quiz's gaps from a pasted reply, never changing what was there: sections are matched by name (the
// rest by place), questions by place; a question's text only when it had none, options only into its empty places
// (reply options it already has are skipped), the right answer only when none was marked, and the kind never. The
// reply's extra questions at the end of a section are added, up to `target` and the 30 a section may have.
// Returns { set, filled: ["c-i", …] (the added ones too), added, names, left, duplicates }; throws 'nothing-filled'.
function parseQuickFill(text, set, { target = 0 } = {}) {
  const data = readQuiz(text);
  if (!Array.isArray(data.sections) || !data.sections.length) throw new AiQuizError('not-a-quiz');
  const out = structuredClone(set);
  const gaps = quickGapsOf(set, { target });
  const matched = matchSections(set.sections, data.sections);
  const replyQuestion = (c, i) => {
    const list = Array.isArray(matched[c]?.questions) ? matched[c].questions : [];
    const rq = list[i];
    return rq && typeof rq === 'object' ? rq : null;
  };
  const norm = (x) => String(x ?? '').trim().toLowerCase();

  const filled = [];
  for (const g of gaps.questions) {
    const rq = replyQuestion(g.c, g.i);
    if (!rq) continue;
    const q = out.sections[g.c].questions[g.i];
    let done = false;
    const question = usable(rq.question, MAX_QUESTION);
    if (g.need.includes('question') && question) (q.question = question), (done = true);
    const fromReply = replyOptions(rq);
    if (g.need.includes('options')) {
      const options = quickOptions(q);
      const fresh = fromReply.filter((o) => !options.some((x) => norm(x) === norm(o)) && !/^\[(picture|sound clip)\]$|^\[keep\]$/i.test(o));
      const slots = Array.from({ length: wantedOptions(q) }, (_, n) => n).filter((n) => !options[n]);
      const mine = options.filter(Boolean);
      const inOrder = typeOf(q) === 'order' && fromReply.length >= 3 && mine.every((x) => fromReply.some((o) => norm(o) === norm(x))) && new Set(fromReply.map(norm)).size === fromReply.length;
      if (inOrder && fresh.length) {
        // The written order is the answer, so the whole list comes from the reply (the words that were there kept as written).
        q.options = fromReply.map((o) => mine.find((x) => norm(x) === norm(o)) ?? o);
        done = true;
      } else {
        for (const n of slots) {
          const o = fresh.shift();
          if (!o) break;
          q.options ??= [];
          while (q.options.length < n) q.options.push('');
          q.options[n] = o;
          done = true;
        }
      }
    }
    if (g.need.includes('correct') && typeOf(q) !== 'order') {
      const right = rightOptions(rq, fromReply)
        .map((n) => quickOptions(q).findIndex((o) => o && norm(o) === norm(fromReply[n])))
        .filter((n) => n >= 0);
      const unique = [...new Set(right)].sort((a, b) => a - b);
      if (unique.length && !(typeOf(q) === 'choice' && unique.length >= writtenOptions(q).length && writtenOptions(q).length > 1)) {
        q.correct = unique.length === 1 && typeOf(q) !== 'multi' ? unique[0] : unique;
        done = true;
      }
    }
    if (done) filled.push(`${g.c}-${g.i}`);
  }

  let added = 0;
  for (const { c, n } of gaps.toAdd) {
    const sec = out.sections[c];
    for (let k = 0; k < n && sec.questions.length < MAX_SECTION_QUESTIONS; k++) {
      const rq = replyQuestion(c, set.sections[c].questions.length + k);
      if (!rq) break;
      const q = readQuickQuestion(rq);
      q.question = usable(q.question, MAX_QUESTION);
      if (!q.question || q.options.length < (typeOf(q) === 'order' ? 3 : 2)) break;
      sec.questions.push(q);
      filled.push(`${c}-${sec.questions.length - 1}`);
      added++;
    }
  }

  let names = 0;
  for (const c of gaps.names) {
    const rs = matched[c];
    const name = usable(rs?.name ?? rs?.section ?? rs?.title, MAX_NAME);
    if (name) (out.sections[c].name = name), names++;
  }
  if (!has(out.title) && usable(data.title, MAX_TITLE)) out.title = usable(data.title, MAX_TITLE);
  if (!filled.length && !names) throw new AiQuizError('nothing-filled');
  const touched = new Set(filled);
  return { set: out, filled, added, names, left: quickGapsOf(out, { target }).count, duplicates: duplicatesIn(out), summary: summarizeQuick(out, (c, i) => touched.has(`${c}-${i}`)) };
}

// ----- translating a quiz into one of its extra languages (lib/languages.js) -----

// The request for the texts still missing in `lang`: only those, as { id, text } pairs, so a long quiz with a few gaps
// asks for a few lines. The ids are the stable ones from translationItems(), and the reply uses the same ids.
export function buildTranslateRequest(set, lang) {
  const from = languageName(mainLang(set));
  const to = languageName(lang);
  const missing = missingTranslations(set, lang);
  const quick = set.kind === 'quick';
  const kinds = new Set(missing.map((m) => m.kind));
  const lines = [
    `I am making a quiz for ProQuiz, a quiz game played on a TV with phones. The quiz is written in ${from}. Some players will read the questions in ${to} on their phones, so I need the texts below translated into ${to}.`,
    '',
    'THE TEXTS',
    '```json',
    JSON.stringify({ translations: missing.map(({ id, text }) => ({ id, text })) }, null, 2).replace(/\{\s+("id": "[^"]*"),\s+("text": ".*")\s+\}/g, '{ $1, $2 }'),
    '```',
    '',
    'HOW TO TRANSLATE',
    `- Translate every "text" into natural ${to}, the way a quiz host would say it. Keep every "id" exactly as it is, and keep the list complete and in the same order.`,
    '- Keep the meaning exactly: a translated question must still have the same answer, and a translated answer must still be the right answer to its question.',
    `- Keep names, numbers, years and units as they are. Translate the title of a film, book or song only when it has a well-known ${to} title; otherwise keep it.`,
    kinds.has('answer') ? '- Ids that start with "a" (and "f-a") are answers: keep them as short as the original.' : null,
    kinds.has('option') ? '- Ids that start with "o" are answer options shown on buttons: 1 to 5 words, at most 60 characters.' : null,
    kinds.has('category') || kinds.has('section') ? `- Ids that start with "c", "s" or "f-c" are ${quick ? 'section' : 'category'} names: short and catchy.` : null,
    kinds.has('title') ? '- "t" is the quiz\'s title and "d" its description.' : null,
    '- Do not add, drop or explain anything, and do not answer the questions.',
    '',
    'HOW TO REPLY',
    '- Reply with one JSON code block and nothing else: the same { "translations": [ { "id", "text" } ] } with every "text" translated.',
    '- Straight double quotes, no comments, no trailing commas and no other fields.',
  ];
  return lines.filter((line) => line !== null).join('\n');
}

// Reads a pasted translation reply into the quiz: only the texts still empty in `lang` are filled, by id (a text that
// is already translated is never overwritten, and unknown ids are ignored). The reply may be the object asked for, a
// bare list of { id, text }, or an object of id → text. Returns { set, filled, left } or throws 'nothing-filled'.
export function parseTranslation(text, set, lang) {
  const data = readJson(text, { list: true });
  let pairs = [];
  const list = Array.isArray(data) ? data : Array.isArray(data?.translations) ? data.translations : Array.isArray(data?.items) ? data.items : Array.isArray(data?.texts) ? data.texts : null;
  if (list) pairs = list.filter((x) => x && typeof x === 'object').map((x) => [x.id, x.text ?? x.translation ?? x.translated]);
  else if (data && typeof data === 'object') pairs = Object.entries(data).filter(([, v]) => typeof v === 'string');
  else throw new AiQuizError('not-a-quiz');
  const out = structuredClone(set);
  const slots = new Map(translationSlots(out).map((slot) => [slot.id, slot]));
  let filled = 0;
  for (const [id, value] of pairs) {
    const slot = slots.get(String(id ?? '').trim());
    const translated = str(value, slot?.kind === 'option' ? MAX_OPTION : slot?.kind === 'answer' ? MAX_ANSWER : slot?.kind === 'question' ? MAX_QUESTION : MAX_DESCRIPTION_TEXT);
    if (!slot || !translated || slotTranslation(slot, lang)) continue; // unknown, empty, or already translated: left alone
    setSlotTranslation(slot, lang, translated);
    filled++;
  }
  if (!filled) throw new AiQuizError('nothing-filled');
  return { set: out, filled, left: missingTranslations(out, lang).length };
}
const MAX_DESCRIPTION_TEXT = 300;
