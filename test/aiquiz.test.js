// Making a quiz with AI: the request text, and reading messy pasted answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, parseReply, repairJson, splitTopics, AiQuizError, AI_ERRORS, DIFFICULTIES } from '../lib/aiquiz.js';
import { validateSet } from '../lib/validate.js';
import { STRINGS } from '../public/js/i18n.js';

// A full 5×5 quiz with a final, as an AI would send it.
function quiz({ cats = 5, rows = 5, final = true } = {}) {
  const q = {
    title: 'Quiz night',
    categories: Array.from({ length: cats }, (_, c) => ({
      name: `Topic ${c + 1}`,
      questions: Array.from({ length: rows }, (_, i) => ({ value: (i + 1) * 100, question: `Question ${c}-${i}?`, answer: `Answer ${c}-${i}` })),
    })),
  };
  if (final) q.final = { category: 'Rivers', question: 'Longest river?', answer: 'The Nile' };
  return q;
}

const fails = (text, code) => assert.throws(() => parseReply(text), (e) => e instanceof AiQuizError && e.code === code);

test('the request asks for the right board, topics, level and language', () => {
  const text = buildRequest({ topics: 'Norwegian football\n\n  80s music  \nAnimals', difficulty: 'hard', categories: 5, rows: 5, final: true, lang: 'en' });
  assert.match(text, /Exactly 5 categories with exactly 5 questions each/);
  assert.match(text, /100, 200, 300, 400, 500/);
  assert.match(text, /"Norwegian football", "80s music", "Animals"/);
  assert.match(text, /add 2 more categories/);
  assert.match(text, /Hard: for keen quiz players/);
  assert.match(text, /one final question/);
  assert.match(text, /in English\./);
  assert.match(text, /no pictures/);
  assert.match(text, /1 to 5 words/);
  assert.doesNotMatch(text, /EXAMPLES OF THE KIND/);
  // The format example in the request is valid JSON with a final.
  const example = JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.deepEqual(validateSet(example), []);
  assert.ok(example.final);
});

test('the request: a 3×3 board without a final, in Norwegian, with the host’s own examples', () => {
  const text = buildRequest({ topics: '', examples: 'Hva heter Norges hovedstad? – Oslo', difficulty: 'kids', categories: 3, rows: 3, final: false, lang: 'no' });
  assert.match(text, /Exactly 3 categories with exactly 3 questions each/);
  assert.match(text, /100, 200, 300\. The 100 question/);
  assert.match(text, /Choose 3 varied, fun categories yourself/);
  assert.match(text, /children aged 5 to 9/);
  assert.match(text, /No final question/);
  assert.match(text, /Norwegian \(bokmål\)/);
  assert.match(text, /Hva heter Norges hovedstad\? – Oslo/);
  const example = JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.equal(example.final, undefined);
  assert.equal(example.categories[0].name, 'Dyr');
});

test('more topics than categories: only the first ones are used', () => {
  const text = buildRequest({ topics: 'A\nB\nC\nD\nE', categories: 3, rows: 3 });
  assert.match(text, /"A", "B", "C"\./);
  assert.doesNotMatch(text, /"D"/);
  assert.doesNotMatch(text, /more categor/);
  assert.deepEqual(splitTopics(' x \n\n y, z '), ['x', 'y, z']);
});

test('a clean reply becomes a ready quiz', () => {
  const { set, problems, duplicates } = parseReply('```json\n' + JSON.stringify(quiz(), null, 2) + '\n```');
  assert.deepEqual(problems, []);
  assert.deepEqual(duplicates, []);
  assert.equal(set.v, 1);
  assert.equal(set.title, 'Quiz night');
  assert.equal(set.categories.length, 5);
  assert.equal(set.categories[4].questions[4].value, 500);
  assert.equal(set.final.answer, 'The Nile');
});

test('messy replies still work: chat around it, no fence language, curly quotes, trailing commas, comments, text values', () => {
  const body = JSON.stringify(quiz({ cats: 3, rows: 3 }), null, 2)
    .replace('"title"', '“title”')
    .replace('"Quiz night"', '“Quiz night”')
    .replace(/("answer": "Answer 0-0")/, '$1,')
    .replace(/"value": 200/g, '"value": "200 points"')
    .replace('"categories": [', '"categories": [ // the board');
  const reply = `Sure! Here is your quiz:\n\n\`\`\`\n${body}\n\`\`\`\n\nLet me know if you want {more} questions!`;
  const { set, problems } = parseReply(reply);
  assert.deepEqual(problems, []);
  assert.equal(set.title, 'Quiz night');
  assert.equal(set.categories[1].questions[1].value, 200);
});

test('a reply copied without the code block marks (e.g. "json" and "Copy code" above it)', () => {
  const { problems } = parseReply(`json\nCopy code\n${JSON.stringify(quiz())}`);
  assert.deepEqual(problems, []);
});

test('missing or wrong parts are filled in or dropped, and the rest is kept as a draft', () => {
  const data = quiz({ cats: 4, rows: 3 });
  delete data.title;
  for (const q of data.categories[0].questions) delete q.value;
  Object.assign(data.categories[1].questions[0], { image: 'x.png', audio: 'y.mp3', hint: 'secret', explanation: 'long text' });
  data.categories[2].questions[1].answer = '';
  data.categories[3].name = 'Æ, ø og å';
  const { set, problems } = parseReply(JSON.stringify(data), { title: 'AI-quiz' });
  assert.equal(set.title, 'AI-quiz');
  assert.deepEqual(set.categories[0].questions.map((q) => q.value), [100, 200, 300]);
  assert.deepEqual(Object.keys(set.categories[1].questions[0]).sort(), ['answer', 'question', 'value']);
  assert.equal(set.categories[3].name, 'Æ, ø og å');
  assert.deepEqual(problems, [{ code: 'no-answer', c: 2, i: 1 }]);
});

test('the final is left out when it wasn’t wanted, and long texts are cut to what the editor allows', () => {
  const data = quiz({ cats: 3, rows: 3 });
  data.categories[0].name = 'x'.repeat(100);
  data.categories[0].questions[0].answer = 'y'.repeat(500);
  const { set } = parseReply(JSON.stringify(data), { final: false });
  assert.equal(set.final, undefined);
  assert.equal(set.categories[0].name.length, 40);
  assert.equal(set.categories[0].questions[0].answer.length, 120);
});

test('repeated answers are reported', () => {
  const data = quiz({ cats: 3, rows: 3 });
  data.categories[0].questions[0].answer = 'Oslo';
  data.categories[2].questions[2].answer = 'oslo';
  data.final.answer = 'Nile';
  data.categories[1].questions[0].answer = 'The Nile';
  assert.deepEqual(parseReply(JSON.stringify(data)).duplicates, ['Oslo', 'The Nile']); // "Nile" and "The Nile" count as the same
});

test('replies that can’t be used say why', () => {
  fails('', 'empty');
  fails('   \n ', 'empty');
  fails('Sorry, I can’t help with that.', 'no-json');
  fails('{"title": "x", "categories": [ {"name": "A", "questions": [', 'no-json'); // cut off: no closing brace
  fails('{"title": "x", "categories": [ {"name": "A" "questions": []} ]}', 'broken-json');
  fails('{"foo": 1}', 'not-a-quiz');
  fails('{"title": "x", "categories": []}', 'not-a-quiz');
});

test('repairJson only touches quotes that are part of the JSON', () => {
  assert.equal(repairJson('{“a”: “He said “hi””,}'), '{"a": "He said “hi”"}');
  assert.deepEqual(JSON.parse(repairJson('{"a": "http://x.no", // note\n"b": [1, 2,],}')), { a: 'http://x.no', b: [1, 2] });
});

test('every difficulty and every error has a text in both languages', () => {
  for (const lang of ['en', 'no']) {
    for (const d of DIFFICULTIES) assert.ok(STRINGS[lang][`aiLevel-${d}`], `${lang} aiLevel-${d}`);
    for (const code of AI_ERRORS) assert.ok(STRINGS[lang][`ai-${code}`], `${lang} ai-${code}`);
  }
});
