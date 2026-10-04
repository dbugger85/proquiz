// Making a quiz with AI by copy and paste. ProQuiz never talks to the internet: the editor shows the request
// from buildRequest(), the host pastes it into Claude or ChatGPT, and parseReply() turns the pasted answer
// into a quiz. Shared by the editor and the tests (no DOM).
import { validateSet, MAX_CATEGORIES, MAX_QUESTIONS } from './validate.js';

export const DIFFICULTIES = ['kids', 'easy', 'medium', 'hard', 'expert'];
export const MIN_SIZE = 3;
export const AI_ERRORS = ['empty', 'no-json', 'broken-json', 'not-a-quiz'];

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
export function buildRequest({ topics = '', examples = '', difficulty = 'medium', categories = 5, rows = 5, final = true, lang = 'en' } = {}) {
  const wanted = splitTopics(topics).slice(0, categories);
  const extra = categories - wanted.length;
  const values = valuesFor(rows);
  const example = structuredClone(EXAMPLE[lang] ?? EXAMPLE.en);
  if (!final) delete example.final;
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
    '',
    'DIFFICULTY',
    `- ${LEVELS[difficulty] ?? LEVELS.medium}`,
    '',
    'QUESTIONS AND ANSWERS',
    '- Every answer is short (1 to 5 words) with one clear right answer, so the host can judge it at once.',
    '- Every question is clear and has only one possible answer. No multiple choice and no true or false.',
    '- The answer must not appear in the question.',
    '- No two questions may have the same answer or ask about the same fact.',
    '- Only use facts you are sure are true. If you are unsure, choose another question.',
    '- Text only: no pictures, sounds or links.',
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

function toValue(x, i) {
  const n = Number.parseInt(String(x ?? ''), 10);
  return Number.isInteger(n) && n > 0 ? n : (i + 1) * 100;
}

// Turns a pasted AI answer into a quiz. Throws AiQuizError for text that can't be used at all; otherwise
// returns the quiz and its problems (a draft with problems is still fine: the editor shows them).
// `duplicates` lists answers that appear more than once.
export function parseReply(text, { final = true, title = 'AI quiz' } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new AiQuizError('empty');
  const part = jsonPart(raw);
  if (!part) throw new AiQuizError('no-json');
  const data = tryParse(part) ?? tryParse(repairJson(part));
  if (data === undefined) throw new AiQuizError('broken-json');
  if (!data || typeof data !== 'object' || !Array.isArray(data.categories) || data.categories.length === 0) throw new AiQuizError('not-a-quiz');

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
  const f = data.final;
  if (final && f && typeof f === 'object') {
    set.final = { category: str(f.category ?? f.name, MAX_NAME), question: str(f.question, MAX_QUESTION), answer: str(f.answer, MAX_ANSWER) };
  }

  const seen = new Map();
  for (const q of [...set.categories.flatMap((c) => c.questions), ...(set.final ? [set.final] : [])]) {
    const key = q.answer.toLowerCase().replace(/^(the|a|an|en|et|ei)\s+/, '');
    if (key) seen.set(key, [...(seen.get(key) ?? []), q.answer]);
  }
  const duplicates = [...seen.values()].filter((list) => list.length > 1).map((list) => list[0]);
  return { set, problems: validateSet(set), duplicates };
}
