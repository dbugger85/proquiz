// Making a quiz with AI: the request text, and reading messy pasted answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, parseReply, repairJson, splitTopics, AiQuizError, AI_ERRORS, DIFFICULTIES, gapsOf, guessLanguage, buildFillRequest, parseFill, quickGapsOf, suggestedTarget, isTrueFalse, summarizeQuick, looksLikeOrder, looksLikeMulti } from '../lib/aiquiz.js';
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

// ----- filling only the empty spots -----

// A Norwegian quiz that is partly written: an empty tile, an answer without a question, a question without an
// answer, a nameless category, an empty category, a picture question without text, and an empty final.
function started() {
  return {
    v: 1,
    title: 'Fredagsquiz',
    categories: [
      { name: 'Dyr', questions: [{ value: 100, question: 'Hvilket dyr sier mø?', answer: 'En ku', special: 'double' }, { value: 200, question: '', answer: '' }] },
      { name: '', questions: [{ value: 100, question: '', answer: 'Oslo' }, { value: 200, question: 'Hva heter Norges konge?', answer: '' }] },
      { name: '', questions: [{ value: 100, question: '', answer: '' }, { value: 200, question: '', answer: '' }] },
      { name: 'Bilder', questions: [{ value: 100, question: '', answer: '', image: 'abc.png' }, { value: 200, question: 'Hvor mange bein har en edderkopp?', answer: 'Åtte' }] },
    ],
    final: { category: '', question: '', answer: '' },
  };
}

test('fill: finds what is missing, and leaves picture questions it cannot see alone', () => {
  const gaps = gapsOf(started());
  assert.deepEqual(gaps.tiles, [
    { c: 0, i: 1, need: 'both' },
    { c: 1, i: 0, need: 'question' },
    { c: 1, i: 1, need: 'answer' },
    { c: 2, i: 0, need: 'both' },
    { c: 2, i: 1, need: 'both' },
  ]);
  assert.deepEqual(gaps.names, [1, 2]);
  assert.deepEqual(gaps.final, ['category', 'question', 'answer']);
  assert.equal(gaps.skipped, 1);
  assert.equal(gaps.count, 8);
  assert.equal(guessLanguage(started()), 'no');
  assert.equal(guessLanguage(quiz()), 'en');
  assert.equal(guessLanguage({ title: '', categories: [{ name: '', questions: [] }] }), null);
});

test('fill: the request shows the quiz so far and adjusts to it', () => {
  const text = buildFillRequest(started(), { topics: 'Fotball' });
  assert.match(text, /"question": "Hvilket dyr sier mø\?"/); // what is there
  assert.match(text, /"question": "\[picture\]", "answer": "\[keep\]"/);
  assert.ok(!text.includes('special')); // specials are not the AI's business
  assert.match(text, /1 empty tile need|3 empty tiles need a question and an answer/);
  assert.match(text, /1 answer needs a question/);
  assert.match(text, /1 question needs its answer/);
  assert.match(text, /1 category has questions but no name: give it/);
  assert.match(text, /1 category is completely empty. Use these topics for them, in order: "Fotball"/);
  assert.match(text, /Norwegian \(bokmål\), like the rest/);
  assert.match(text, /match the questions that are already there/);
  assert.match(text, /100 is the easiest and 200 the hardest/);
  assert.match(text, /final question needs a question and an answer/);
  assert.ok(!text.includes('needs a short, fun "title"'));
  // A chosen level and language win; with nothing written yet, "match" falls back to medium.
  assert.match(buildFillRequest(started(), { difficulty: 'kids', lang: 'en' }), /children aged 5 to 9[\s\S]*in English/);
  const blank = { title: '', categories: [{ name: '', questions: [{ value: 100, question: '', answer: '' }] }] };
  assert.match(buildFillRequest(blank), /a normal pub quiz/);
  assert.match(buildFillRequest(blank), /needs a short, fun "title"/);
});

test('fill: only the gaps are filled, and nothing that was there changes', () => {
  const set = started();
  const reply = {
    title: 'Ny tittel',
    categories: [
      // The AI moved "Bilder" to the front and changed things it shouldn't: those are ignored.
      { name: 'Bilder', questions: [{ value: 100, question: 'Hva er dette?', answer: 'En katt' }, { value: 200, question: 'Hvor mange bein har en edderkopp?', answer: 'Åtte' }] },
      { name: 'Dyr', questions: [{ value: 100, question: 'Endret!', answer: 'Endret' }, { value: 200, question: 'Hvilket dyr har snabel?', answer: 'Elefant' }] },
      { name: 'Byer', questions: [{ value: 100, question: 'Hva heter Norges hovedstad?', answer: 'Feil' }, { value: 200, question: 'Endret', answer: 'Harald' }] },
      { name: 'Fotball', questions: [{ value: 100, question: 'Hvor mange spillere har et lag på banen?', answer: 'Elleve' }, { value: 200, question: '', answer: '' }] },
    ],
    final: { category: 'Elver', question: 'Hvilken elv renner gjennom Kairo?', answer: 'Nilen' },
  };
  const made = parseFill('Here you go:\n```json\n' + JSON.stringify(reply) + '\n```', set);
  const out = made.set;
  assert.equal(out.title, 'Fredagsquiz');
  assert.deepEqual(out.categories[0].questions[0], set.categories[0].questions[0]); // untouched, special and all
  assert.equal(out.categories[0].questions[1].question, 'Hvilket dyr har snabel?'); // found "Dyr" by name
  assert.equal(out.categories[1].questions[0].question, 'Hva heter Norges hovedstad?');
  assert.equal(out.categories[1].questions[0].answer, 'Oslo'); // the answer that was there stays
  assert.equal(out.categories[1].questions[1].question, 'Hva heter Norges konge?');
  assert.equal(out.categories[1].questions[1].answer, 'Harald');
  assert.equal(out.categories[1].name, 'Byer');
  assert.equal(out.categories[2].name, 'Fotball');
  assert.equal(out.categories[2].questions[0].answer, 'Elleve');
  assert.deepEqual(out.categories[3].questions[0], set.categories[3].questions[0]); // the picture question is left alone
  assert.deepEqual(out.final, { category: 'Elver', question: 'Hvilken elv renner gjennom Kairo?', answer: 'Nilen' });
  assert.deepEqual(made.filled, ['0-1', '1-0', '1-1', '2-0']);
  assert.equal(made.names, 2);
  assert.equal(made.final, true);
  assert.equal(made.left, 1); // 2-1 came back empty
  assert.deepEqual(started(), set); // the quiz passed in is not changed
});

test('fill: an answer with nothing usable is refused, and duplicates are listed', () => {
  assert.throws(() => parseFill('{"categories": [{"name": "", "questions": []}]}', started()), (e) => e instanceof AiQuizError && e.code === 'nothing-filled');
  assert.throws(() => parseFill('nothing here', started()), { code: 'no-json' });
  const copy = structuredClone(started());
  copy.categories = copy.categories.map((c) => ({ ...c, questions: c.questions.map((q) => ({ ...q, answer: q.answer || '[keep]', question: q.question || '[picture]' })) }));
  copy.categories[0].questions[1] = { value: 200, question: 'Hvilket dyr sier mø?', answer: 'En ku' };
  const made = parseFill(JSON.stringify(copy), started());
  assert.deepEqual(made.filled, ['0-1']);
  assert.deepEqual(made.duplicates, ['En ku']);
  assert.ok(STRINGS.en['ai-nothing-filled'] && STRINGS.no['ai-nothing-filled']);
});

// ----- round 2 -----

test('round 2: the request asks for a second board with double points and its own topics', () => {
  const text = buildRequest({ categories: 3, rows: 3, round2: true, round2Topics: 'Music\nFilm' });
  assert.match(text, /ROUND 2/);
  assert.match(text, /exactly 3 new categories with exactly 3 questions each/);
  assert.match(text, /200, 400, 600/);
  assert.match(text, /"Music", "Film"\. Then add 1 more of your own/);
  assert.match(text, /"round2": \{/);
  assert.ok(text.indexOf('"round2"') < text.indexOf('"final"')); // the example is in playing order
  assert.ok(!buildRequest({}).includes('round2'));
});

test('round 2: a reply with a round 2 board becomes a quiz with one', () => {
  const data = quiz({ cats: 3, rows: 3 });
  data.round2 = { categories: quiz({ cats: 3, rows: 3 }).categories.map((cat, c) => ({ ...cat, name: `Round 2 topic ${c}` })) };
  for (const cat of data.round2.categories) for (const q of cat.questions) (q.answer += ' (2)'), delete q.value;
  const { set, problems, duplicates } = parseReply(JSON.stringify(data));
  assert.deepEqual(problems, []);
  assert.deepEqual(duplicates, []);
  assert.equal(set.round2.categories.length, 3);
  assert.deepEqual(set.round2.categories[0].questions.map((q) => q.value), [200, 400, 600]); // missing values start at double
  assert.equal(parseReply(JSON.stringify(data), { round2: false }).set.round2, undefined);
  // The same answer on both boards is reported.
  data.round2.categories[0].questions[0].answer = 'Answer 0-0';
  assert.deepEqual(parseReply(JSON.stringify(data)).duplicates, ['Answer 0-0']);
});

test('round 2: filling finds and fills the gaps on both boards, without touching the rest', () => {
  const set = {
    title: 'Quiz',
    categories: [{ name: 'Animals', questions: [{ value: 100, question: 'Which animal says moo?', answer: 'A cow' }, { value: 200, question: '', answer: '' }] }],
    round2: {
      categories: [
        { name: 'Space', questions: [{ value: 200, question: 'Which planet is red?', answer: 'Mars' }, { value: 400, question: 'Which planet has the most moons?', answer: '' }] },
        { name: '', questions: [{ value: 200, question: '', answer: '' }, { value: 400, question: '', answer: '' }] },
      ],
    },
  };
  const gaps = gapsOf(set);
  assert.deepEqual(gaps.tiles, [
    { c: 0, i: 1, need: 'both' },
    { c: 0, i: 1, need: 'answer', r: 2 },
    { c: 1, i: 0, need: 'both', r: 2 },
    { c: 1, i: 1, need: 'both', r: 2 },
  ]);
  assert.deepEqual(gaps.names2, [1]);
  assert.equal(gaps.count, 5);
  const text = buildFillRequest(set, { topics: 'Rivers' });
  assert.match(text, /"round2": \{/);
  assert.match(text, /two boards/);
  assert.match(text, /1 category is completely empty. Use these topics for them, in order: "Rivers"/);
  const reply = {
    title: 'Quiz',
    categories: [{ name: 'Animals', questions: [{ value: 100, question: 'Changed', answer: 'Changed' }, { value: 200, question: 'How many legs has a spider?', answer: 'Eight' }] }],
    round2: {
      categories: [
        { name: 'Space', questions: [{ value: 200, question: 'Changed', answer: 'Changed' }, { value: 400, question: 'Changed', answer: 'Saturn' }] },
        { name: 'Rivers', questions: [{ value: 200, question: 'Which river flows through Cairo?', answer: 'The Nile' }, { value: 400, question: 'Which river flows through London?', answer: 'The Thames' }] },
      ],
    },
  };
  const made = parseFill(JSON.stringify(reply), set);
  assert.deepEqual(made.filled, ['0-1', '2:0-1', '2:1-0', '2:1-1']);
  assert.equal(made.names, 1);
  assert.equal(made.left, 0);
  assert.equal(made.set.categories[0].questions[0].question, 'Which animal says moo?');
  assert.deepEqual(made.set.round2.categories[0].questions[1], { value: 400, question: 'Which planet has the most moons?', answer: 'Saturn' });
  assert.equal(made.set.round2.categories[1].name, 'Rivers');
  assert.deepEqual(validateSet(made.set), []);
});

// ----- a Quick quiz (multiple choice in sections) -----

test('the Quick quiz request asks for sections, options, the topics, level and language', () => {
  const text = buildRequest({ kind: 'quick', topics: 'Film\nMusikk', sections: 3, perSection: 8, difficulty: 'easy', lang: 'no' });
  assert.match(text, /multiple-choice quiz/);
  assert.match(text, /Exactly 3 sections with exactly 8 questions each/);
  assert.match(text, /"Film", "Musikk"/);
  assert.match(text, /add 1 more section of your own/);
  // Every question must say its type (the owner's first AI quiz came back without, 2026-10-11).
  assert.match(text, /EVERY question has a "type": "choice", "multi", "order" or "any"\. Never leave it out/);
  assert.match(text, /"choice" \(most questions\): exactly 4 options and exactly one of them is right/);
  assert.match(text, /"any" \(rare, at most 1 in 10 questions\)[^\n]*"answer" is a list of all the right options/);
  assert.match(text, /"multi" \(at most 1 in 5 questions\): "tick all that are right"/);
  assert.match(text, /"order" \(at most 1 in 5 questions\): "put in order"/);
  assert.match(text, /Never say in the question how many options are right/);
  assert.match(text, /\["Sant", "Usant"\]/);
  assert.match(text, /Easy: things most adults know/);
  assert.match(text, /Norwegian \(bokmål\)/);
  assert.doesNotMatch(text, /THE BOARD|final question/);
  // The format example reads back as a valid Quick quiz in the chosen language.
  const example = text.match(/```json\n([\s\S]*?)\n```/)[1];
  const { set, problems, summary } = parseReply('```json\n' + example + '\n```');
  assert.deepEqual(problems, []);
  assert.equal(set.kind, 'quick');
  assert.equal(set.sections[0].name, 'Dyr');
  // Every question in the example carries a type, and the summary counts them.
  assert.ok(JSON.parse(example).sections.every((sec) => sec.questions.every((q) => ['choice', 'multi', 'order', 'any'].includes(q.type))));
  assert.deepEqual(summary, { questions: 6, choice: 4, multi: 1, order: 1, any: 0, suspects: [] });
  assert.match(example, /"type": "choice", "options": \["Hest", "Ku", "Sau", "Gris"\], "answer": "Ku" \}/);
  assert.equal(set.sections[0].questions[0].correct, 1); // "Ku"
  assert.equal(set.sections[0].questions[0].type, undefined);
  assert.deepEqual(set.sections[0].questions[2], { question: 'Hvilke av disse er pattedyr?', type: 'multi', options: ['Hval', 'Hai', 'Flaggermus', 'Frosk'], correct: [0, 2] });
  assert.deepEqual(set.sections[1].questions[2], { question: 'Sett disse i rekkefølge, fra eldst til nyest.', type: 'order', options: ['Pyramidene i Giza', 'Colosseum', 'Eiffeltårnet', 'Operaen i Oslo'] });
  assert.match(example, /"type": "multi", "options": \["Hval", "Hai", "Flaggermus", "Frosk"\], "answer": \["Hval", "Flaggermus"\] \}/); // kept on one line like the others
  assert.match(example, /"type": "order", "options": \["Pyramidene i Giza", "Colosseum", "Eiffeltårnet", "Operaen i Oslo"\] \}/);
  // No question in the example says how many are right.
  assert.doesNotMatch(example, /er riktige|are right|To av|Two of/i);
  const en = buildRequest({ kind: 'quick', sections: 1, perSection: 5 });
  assert.match(en, /Exactly 1 section with exactly 5 questions each/);
  assert.match(en, /Choose a fun topic for the section yourself/);
  assert.match(en, /\["True", "False"\]/);
});

test('a Quick quiz reply: the right answer by text, position or letter, and messy options', () => {
  const reply = {
    title: 'Movie night',
    sections: [
      {
        name: 'Films',
        questions: [
          { question: 'Who directed Jaws?', options: ['Lucas', 'Spielberg', 'Scorsese', 'Coppola'], answer: ' spielberg ' },
          { question: 'Which year was Titanic released?', options: ['1995', '1997', '1999', '2001'], correct: 1 },
          { question: 'Which film has Neo?', options: [{ text: 'Alien' }, { text: 'Heat' }, { text: 'The Matrix' }, { text: 'Up' }], answer: 'C' },
          { question: 'True or false: Shrek is green.', options: ['True', 'False'], answer: 'True' },
          { question: 'Too many options?', options: ['A1', 'B1', 'C1', 'D1', 'E1'], answer: 'E1' },
          { question: 'Name the hobbit.', options: ['Frodo', 'Gandalf', '', 'Legolas'], answer: 'Frodo' },
        ],
      },
      { section: 'Music', questions: [{ question: 'Who sang Thriller?', options: ['Prince', 'Michael Jackson', 'Madonna', 'Sting'], answer: 'Michael Jackson' }] },
    ],
  };
  const { set, problems } = parseReply('Here you go!\n```json\n' + JSON.stringify(reply) + ',\n```');
  assert.equal(set.kind, 'quick');
  assert.equal(set.title, 'Movie night');
  const qs = set.sections[0].questions;
  assert.deepEqual(qs.map((q) => q.correct), [1, 1, 2, 0, undefined, 0]);
  assert.deepEqual(qs[2].options, ['Alien', 'Heat', 'The Matrix', 'Up']);
  assert.deepEqual(qs[4].options, ['A1', 'B1', 'C1', 'D1']); // at most 4, and the answer was cut off: none marked
  assert.deepEqual(qs[5].options, ['Frodo', 'Gandalf', 'Legolas']); // empty options are dropped
  assert.equal(set.sections[1].name, 'Music');
  assert.deepEqual(problems, [{ code: 'bad-correct', c: 0, i: 4 }]);
});

test('a Quick quiz reply with several right answers: a list of texts, positions or letters', () => {
  const reply = {
    title: 'Animals',
    sections: [
      {
        name: 'Mammals',
        questions: [
          { question: 'Which are mammals?', options: ['Whale', 'Shark', 'Bat', 'Frog'], answer: ['whale ', 'Bat'] },
          { question: 'Which are birds?', options: ['Owl', 'Cat', 'Penguin', 'Eel'], answer: ['A', 'C'] },
          { question: 'Which are fish?', options: ['Cod', 'Seal', 'Trout', 'Crab'], correct: [2, 0] },
          { question: 'Just one in a list?', options: ['x', 'y', 'z', 'w'], answers: ['y'] },
          { question: 'One known, one not', options: ['x', 'y', 'z', 'w'], answer: ['z', 'nope'] },
          { question: 'All of them?', options: ['x', 'y', 'z', 'w'], answer: ['x', 'y', 'z', 'w'] },
          { question: 'None known', options: ['x', 'y', 'z', 'w'], answer: ['q'] },
        ],
      },
    ],
  };
  const { set, problems } = parseReply(JSON.stringify(reply), { kind: 'quick' });
  assert.deepEqual(set.sections[0].questions.map((q) => q.correct), [[0, 2], [0, 2], [0, 2], 1, 2, [0, 1, 2, 3], undefined]);
  assert.deepEqual(problems, [{ code: 'all-correct', c: 0, i: 5 }, { code: 'bad-correct', c: 0, i: 6 }]);
});

test('a Quick quiz reply with "tick all" and "put in order" questions: types and their other names, the order by text', () => {
  const reply = {
    title: 'Kinds',
    sections: [
      {
        name: 'S',
        questions: [
          { question: 'Which are mammals?', type: 'multi', options: ['Whale', 'Shark', 'Bat', 'Frog'], answer: ['Whale', 'Bat'] },
          { question: 'Tick the primes', type: 'Tick all', options: ['2', '4', '7', '9'], answer: ['2', '7'] },
          { question: 'Only one, but tick all', type: 'checkbox', options: ['p', 'q', 'r', 's'], answer: 'q' }, // one right answer: still a list
          { question: 'All of them', kind: 'multiple', options: ['e', 'f', 'g', 'k'], answer: ['e', 'f', 'g', 'k'] }, // every option right is fine here
          { question: 'Oldest to newest', type: 'order', options: ['Pyramids', 'Colosseum', 'Eiffel Tower'] },
          { question: 'Smallest first', type: 'ranking', options: ['Large', 'Small', 'Medium'], answer: ['Small', 'Medium', 'Large'] }, // the right order given: options put in it
          { question: 'Order given as "order"', type: 'sort', options: ['b', 'c', 'a'], order: ['a', 'b', 'c'] },
          { question: 'Order given but unknown item', type: 'order', options: ['b', 'c', 'a'], answer: ['a', 'b', 'q'] }, // left as written
          { question: 'Too few to order', type: 'order', options: ['b', 'a'] },
          { question: 'Unknown type is ordinary', type: 'essay', options: ['m', 'n', 'o', 'u'], answer: 'o' },
          { question: 'A list without a type stays "any of them counts"', options: ['v', 'w', 'x', 'y'], answer: ['v', 'w'] },
        ],
      },
    ],
  };
  const { set, problems, duplicates } = parseReply(JSON.stringify(reply), { kind: 'quick' });
  const qs = set.sections[0].questions;
  assert.deepEqual(qs.map((q) => [q.type, q.correct]), [
    ['multi', [0, 2]],
    ['multi', [0, 2]],
    ['multi', [1]],
    ['multi', [0, 1, 2, 3]],
    ['order', undefined],
    ['order', undefined],
    ['order', undefined],
    ['order', undefined],
    ['order', undefined],
    [undefined, 2],
    [undefined, [0, 1]],
  ]);
  assert.deepEqual(qs[5].options, ['Small', 'Medium', 'Large']);
  assert.deepEqual(qs[6].options, ['a', 'b', 'c']);
  assert.deepEqual(qs[7].options, ['b', 'c', 'a']);
  assert.deepEqual(problems, [{ code: 'order-options', c: 0, i: 8 }]);
  assert.deepEqual(duplicates, []); // the items of an order question aren't answers that can repeat
});

// The owner's first real AI quiz (2026-10-11): ChatGPT left "type" out of every question, so the "tick all" questions
// came in as pick-one with several right answers and the "put in order" question as pick-one with the first option
// right. Without a type, the wording decides.
test('a Quick quiz reply without types (the owner\'s case, Norwegian): "hvilke av disse" lists become "tick all", "sorter" becomes "put in order"', () => {
  const reply = {
    title: 'AI quiz',
    sections: [
      {
        name: 'Barndommens helter',
        questions: [
          { question: 'Hvem skrev «Folk og røvere i Kardemomme by»?', options: ['Alf Prøysen', 'Thorbjørn Egner', 'Anne-Cath. Vestly', 'Astrid Lindgren'], answer: 'Thorbjørn Egner' },
          { question: 'Teskjekjerringa ble skapt av Alf Prøysen.', options: ['Sant', 'Usant'], answer: 'Sant' },
          { question: 'Sorter disse Disney-filmene fra eldst til nyest.', options: ['Snøhvit og de syv dvergene', 'Den lille havfruen', 'Løvenes konge', 'Frost'], answer: 'Snøhvit og de syv dvergene' },
          { question: 'Hva heter hunden til Tintin?', options: ['Pluto', 'Milou', 'Snoopy', 'Terry'], answer: ['Milou', 'Terry'] }, // the AI's mistake: two right, no plural wording → any counts, as before
        ],
      },
      {
        name: 'Ut i det fri',
        questions: [
          { question: 'Hvilke av disse dyrene er pattedyr?', options: ['Hval', 'Pingvin', 'Flaggermus', 'Hai'], answer: ['Hval', 'Flaggermus'] },
          { question: 'Hvilke av disse landene grenser til Brasil?', options: ['Argentina', 'Chile', 'Peru', 'Ecuador'], answer: ['Argentina', 'Peru'] },
          { question: 'Hvilken fugl ble kåret til Norges nasjonalfugl?', options: ['Fossekall', 'Kongeørn', 'Lirype', 'Havørn'], answer: 'Fossekall' },
          { question: 'Sett disse elvene i rekkefølge, fra lengst til kortest.', options: ['Glomma', 'Tana', 'Numedalslågen'], answer: ['Glomma', 'Tana', 'Numedalslågen'] },
          { question: 'Ranger planetene fra minst til størst.', options: ['Jorda', 'Mars', 'Merkur'], answer: ['Merkur', 'Mars', 'Jorda'] }, // the order given: options put in it
          { question: 'Hvilke av disse er hovedsteder?', options: ['Oslo', 'Bergen', 'Stockholm', 'Göteborg'], answer: 'Oslo' }, // plural wording but one right: stays pick one, flagged
        ],
      },
    ],
  };
  const { set, problems, summary } = parseReply(JSON.stringify(reply), { kind: 'quick' });
  const [a, b] = set.sections;
  assert.deepEqual(a.questions.map((q) => [q.type, q.correct]), [[undefined, 1], [undefined, 0], ['order', undefined], [undefined, [1, 3]]]);
  assert.deepEqual(a.questions[2].options, ['Snøhvit og de syv dvergene', 'Den lille havfruen', 'Løvenes konge', 'Frost']); // as written
  assert.deepEqual(b.questions.map((q) => [q.type, q.correct]), [['multi', [0, 2]], ['multi', [0, 2]], [undefined, 0], ['order', undefined], ['order', undefined], [undefined, 0]]);
  assert.deepEqual(b.questions[4].options, ['Merkur', 'Mars', 'Jorda']);
  assert.deepEqual(problems, []);
  assert.deepEqual(summary, { questions: 10, choice: 4, multi: 2, order: 3, any: 1, suspects: [{ c: 1, i: 5, looks: 'multi', question: 'Hvilke av disse er hovedsteder?' }] });
});

test('a Quick quiz reply without types (English): sorting words, plural lists, "any"/"either", and explicit types are never changed', () => {
  const reply = {
    title: 'No types',
    sections: [
      {
        name: 'S',
        questions: [
          { question: 'Which of these are mammals?', options: ['Whale', 'Shark', 'Bat', 'Frog'], answer: ['Whale', 'Bat'] },
          { question: 'Which animals were on the Ark?', options: ['Lions', 'Dragons', 'Doves', 'Unicorns'], answers: ['Lions', 'Doves'] },
          { question: 'Select all the prime numbers.', options: ['2', '4', '7', '9'], answer: ['2', '7'] },
          { question: 'Put these in order, oldest to newest.', options: ['Colosseum', 'Pyramids', 'Eiffel Tower'], answer: ['Pyramids', 'Colosseum', 'Eiffel Tower'] },
          { question: 'Arrange the planets from smallest to largest.', options: ['Mercury', 'Mars', 'Earth'] },
          { question: 'Rank these mountains by height, highest first.', options: ['Everest', 'K2', 'Kilimanjaro'], answer: 'Everest' }, // one answer: still order, options as written
          { question: 'Which river flows from west to east?', options: ['Nile', 'Thames', 'Amazon', 'Rhine'], answer: 'Amazon' }, // "from … to" alone isn't sorting
          { question: 'Which is a colour?', options: ['Red', 'Table', 'Green', 'Chair'], answer: ['Red', 'Green'] }, // a list without plural wording: any counts
          { question: 'Either works here', type: 'any', options: ['a', 'b', 'c', 'd'], answer: ['a', 'b'] },
          { question: 'Either works here too', type: 'either', options: ['e', 'f', 'g', 'k'], answer: ['e', 'k'] },
          { question: 'Which of these are mammals? (but the AI said choice)', type: 'choice', options: ['Cat', 'Shark', 'Dog', 'Frog'], answer: ['Cat', 'Dog'] },
          { question: 'Sort these, but the AI said multi', type: 'multi', options: ['x', 'y', 'z', 'w'], answer: ['x', 'y'] },
          { question: 'Just a normal question?', type: 'single choice', options: ['p', 'q', 'r', 's'], answer: 'q' },
        ],
      },
    ],
  };
  const { set, summary } = parseReply(JSON.stringify(reply), { kind: 'quick' });
  const qs = set.sections[0].questions;
  assert.deepEqual(qs.map((q) => [q.type, q.correct]), [
    ['multi', [0, 2]],
    ['multi', [0, 2]],
    ['multi', [0, 2]],
    ['order', undefined],
    ['order', undefined],
    ['order', undefined],
    [undefined, 2],
    [undefined, [0, 2]],
    [undefined, [0, 1]],
    [undefined, [0, 3]],
    [undefined, [0, 2]], // explicit "choice" is kept (and flagged below)
    ['multi', [0, 1]], // explicit "multi" is kept
    [undefined, 1],
  ]);
  assert.deepEqual(qs[3].options, ['Pyramids', 'Colosseum', 'Eiffel Tower']);
  assert.deepEqual(qs[5].options, ['Everest', 'K2', 'Kilimanjaro']);
  assert.deepEqual(summary.suspects, [{ c: 0, i: 10, looks: 'multi', question: 'Which of these are mammals? (but the AI said choice)' }]);
  assert.deepEqual([summary.questions, summary.choice, summary.multi, summary.order, summary.any], [13, 2, 4, 3, 4]);
  // The wording checks on their own.
  assert.ok(looksLikeOrder('Sorter disse fra eldst til nyest.') && looksLikeOrder('Put these in chronological order') && looksLikeOrder('From first to last:') && looksLikeOrder('Sett dem i riktig rekkefølge'));
  assert.ok(!looksLikeOrder('Which river flows from west to east?') && !looksLikeOrder('What is the border of Spain?') && !looksLikeOrder('Hvem var den første på månen?'));
  assert.ok(looksLikeMulti('Hvilke av disse er frukt?') && looksLikeMulti('Which of these are fruits?') && looksLikeMulti('Tick all that apply') && looksLikeMulti('Kryss av alle som er riktige'));
  assert.ok(!looksLikeMulti('Which of these is a fruit?') && !looksLikeMulti('Hvilken av disse er en frukt?') && !looksLikeMulti('What is the capital of Peru?'));
  // A summary of a quiz straight from the editor's own shape.
  assert.deepEqual(summarizeQuick({ sections: [{ name: 'A', questions: [{ question: 'Order these', type: 'order', options: ['a', 'b', 'c'] }, { question: 'Q?', options: ['a', 'b'], correct: [0, 1] }] }] }), { questions: 2, choice: 0, multi: 0, order: 1, any: 1, suspects: [] });
});

test('Quick quiz replies: kind, duplicates, and what is not a Quick quiz', () => {
  const sections = [{ name: 'A', questions: [{ question: 'Q1?', options: ['x', 'Oslo', 'y', 'z'], answer: 'Oslo' }, { question: 'Q2?', options: ['Oslo', 'b', 'c', 'd'], answer: 'Oslo' }, { question: 'Q3?', options: ['True', 'False'], answer: 'True' }, { question: 'Q4?', options: ['True', 'False'], answer: 'True' }] }];
  // A reply with both a board and sections is read as what was asked for.
  const both = JSON.stringify({ title: 'T', categories: quiz({ cats: 3, rows: 3, final: false }).categories, sections });
  assert.equal(parseReply(both).set.kind, undefined);
  const made = parseReply(both, { kind: 'quick' });
  assert.equal(made.set.kind, 'quick');
  assert.deepEqual(made.duplicates, ['Oslo']); // true or false doesn't count
  // No title: the default one. Nothing usable: not a quiz.
  assert.equal(parseReply(JSON.stringify({ sections }), { title: 'AI quiz' }).set.title, 'AI quiz');
  fails('{"title": "x", "sections": []}', 'not-a-quiz');
  // A board reply in the Quick quiz dialog stays a board (the editor shows it as one).
  assert.ok(parseReply(JSON.stringify(quiz()), { kind: 'quick' }).set.categories);
});

// ----- filling the empty spots of a Quick quiz -----

// A Quick quiz someone has started on: a full section, one with holes, and an empty one.
function startedQuick() {
  return {
    v: 1,
    kind: 'quick',
    title: 'Fredagens lynquiz',
    sections: [
      {
        name: 'Dyr',
        seconds: 15,
        questions: [
          { question: 'Hvilket dyr sier mø?', options: ['Hest', 'Ku', 'Sau', 'Gris'], correct: 1 },
          { question: 'Hvor mange bein har en edderkopp?', options: ['Seks', 'Åtte'], correct: 1 }, // 2 options, not true or false
          { question: 'Hvilke av disse er pattedyr?', type: 'multi', options: ['Hval', 'Hai', 'Flaggermus', 'Frosk'] }, // nothing marked
          { question: 'Sant eller usant: Sola er en stjerne.', options: ['Sant', 'Usant'], correct: 0 }, // complete
          { question: '', options: [] },
        ],
      },
      {
        name: '',
        questions: [
          { question: '', options: [], image: 'abc.png' }, // the AI can't see it
          { question: 'Sett disse i rekkefølge, fra eldst til nyest.', type: 'order', options: ['Colosseum', 'Eiffeltårnet'] },
          { question: 'Hva heter Norges hovedstad?', options: ['Bergen', 'Oslo', 'Trondheim', 'Tromsø'], points: 2000 }, // no right answer marked
        ],
      },
      { name: '', questions: [{ question: '', options: [] }] },
    ],
  };
}

test('quick fill: finds every kind of gap, keeps true-or-false questions, and tops sections up to the target', () => {
  const set = startedQuick();
  const gaps = gapsOf(set);
  assert.deepEqual(gaps.questions, [
    { c: 0, i: 1, need: ['options'] },
    { c: 0, i: 2, need: ['correct'] },
    { c: 0, i: 4, need: ['question', 'options', 'correct'] },
    { c: 1, i: 1, need: ['options'] },
    { c: 1, i: 2, need: ['correct'] },
    { c: 2, i: 0, need: ['question', 'options', 'correct'] },
  ]);
  assert.deepEqual(gaps.names, [1, 2]);
  assert.deepEqual(gaps.toAdd, []);
  assert.equal(gaps.skipped, 1);
  assert.equal(gaps.count, 8);
  assert.equal(guessLanguage(set), 'no');
  // The target adds questions at the end of the shorter sections (never past 30).
  assert.equal(suggestedTarget(set), 5);
  assert.equal(suggestedTarget({ kind: 'quick', sections: [{ name: '', questions: Array(12).fill({ question: '', options: [] }) }] }), 12);
  const topped = quickGapsOf(set, { target: 6 });
  assert.deepEqual(topped.toAdd, [{ c: 0, n: 1 }, { c: 1, n: 3 }, { c: 2, n: 5 }]);
  assert.equal(topped.extra, 9);
  assert.equal(topped.count, 17);
  assert.equal(quickGapsOf(set, { target: 99 }).toAdd[2].n, 29);
  // True or false by the words, or by the question; "Seks"/"Åtte" is not.
  assert.equal(isTrueFalse({ question: 'Is it?', options: ['Yes', 'No'] }), true);
  assert.equal(isTrueFalse({ question: 'True or false: cats purr.', options: ['Purr', 'Hiss'] }), true);
  assert.equal(isTrueFalse(set.sections[0].questions[1]), false);
  assert.equal(isTrueFalse({ question: 'x', options: ['True', 'False', 'Maybe'] }), false);
  // A marked option that is empty doesn't count as a right answer.
  assert.deepEqual(quickGapsOf({ kind: 'quick', sections: [{ name: 'A', questions: [{ question: 'Q', options: ['a', 'b', 'c', ''], correct: 3 }] }] }).questions, [{ c: 0, i: 0, need: ['options', 'correct'] }]);
});

test('quick fill: the request shows the quiz so far with "" for the gaps, and says what to fill', () => {
  const set = startedQuick();
  const text = buildFillRequest(set, { target: 5, topics: 'Fotball' });
  assert.match(text, /multiple-choice quiz for ProQuiz/);
  const sketch = JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)[1]);
  // Every question shows its type (a blank one an empty type to fill in, a pick-one with several right options "any").
  assert.deepEqual(sketch.sections[0].questions[0], { question: 'Hvilket dyr sier mø?', type: 'choice', options: ['Hest', 'Ku', 'Sau', 'Gris'], answer: 'Ku' });
  assert.deepEqual(sketch.sections[0].questions[1], { question: 'Hvor mange bein har en edderkopp?', type: 'choice', options: ['Seks', 'Åtte', '', ''], answer: 'Åtte' });
  assert.deepEqual(sketch.sections[0].questions[2], { question: 'Hvilke av disse er pattedyr?', type: 'multi', options: ['Hval', 'Hai', 'Flaggermus', 'Frosk'], answer: '' });
  assert.deepEqual(sketch.sections[0].questions[3].options, ['Sant', 'Usant']); // true or false is complete with 2
  assert.deepEqual(sketch.sections[0].questions[4], { question: '', type: '', options: ['', '', '', ''], answer: '' });
  assert.deepEqual(sketch.sections[1].questions[0], { question: '[picture]', type: 'choice', options: [], answer: '[keep]' });
  const anyQ = { ...set, sections: [{ name: 'A', questions: [{ question: 'Q?', options: ['a', 'b', 'c', 'd'], correct: [0, 2] }] }] };
  assert.deepEqual(JSON.parse(buildFillRequest(anyQ).match(/```json\n([\s\S]*?)\n```/)[1]).sections[0].questions[0], { question: 'Q?', type: 'any', options: ['a', 'b', 'c', 'd'], answer: ['a', 'c'] });
  assert.match(text, /\{ "question": "", "type": "", "options": \["", "", "", ""\], "answer": "" \}/); // still one line each
  assert.deepEqual(sketch.sections[1].questions[1], { question: 'Sett disse i rekkefølge, fra eldst til nyest.', type: 'order', options: ['Colosseum', 'Eiffeltårnet', '', ''] });
  assert.equal(sketch.sections[1].questions.length, 5); // topped up to 5 with empty questions
  assert.equal(sketch.sections[2].questions.length, 5);
  assert.ok(!JSON.stringify(sketch).includes('seconds') && !JSON.stringify(sketch).includes('points')); // times and points are not the AI's business
  assert.match(text, /8 empty questions need a question, its "type", its options and the "answer"/);
  assert.match(text, /6 of them are new questions at the end of their sections/);
  assert.match(text, /2 questions need the missing options/);
  assert.match(text, /"put in order" question with empty places/);
  assert.match(text, /2 questions need their "answer"/);
  assert.match(text, /1 section has questions but no name/);
  assert.match(text, /1 section is completely empty. Use these topics for them, in order: "Fotball"/);
  assert.match(text, /"\[keep\]" is an answer to leave alone/);
  assert.match(text, /Norwegian \(bokmål\), like the rest/);
  assert.match(text, /match the questions that are already there/);
  assert.match(text, /\["Sant", "Usant"\]/);
  assert.match(text, /Never say in the question how many options are right/);
  assert.match(text, /EVERY question has a "type"/);
  assert.doesNotMatch(text, /THE BOARD|final|"value"/);
  // No target: nothing is added, and a chosen level and language win.
  const plain = buildFillRequest(set, { difficulty: 'kids', lang: 'en' });
  assert.doesNotMatch(plain, /new questions at the end/);
  assert.match(plain, /2 empty questions need/);
  assert.match(plain, /children aged 5 to 9[\s\S]*in English[\s\S]*\["True", "False"\]/);
  // Only a top-up, nothing else missing.
  const full = { kind: 'quick', title: 'T', sections: [{ name: 'A', questions: [{ question: 'Q?', options: ['a', 'b', 'c', 'd'], correct: 0 }] }] };
  assert.match(buildFillRequest(full, { target: 3 }), /2 empty questions need[\s\S]*2 of them are new questions at the end of a section/);
  assert.match(buildFillRequest({ ...full, title: '' }), /needs a short, fun "title"/);
});

test('quick fill: only the gaps are filled, new questions are added, and nothing that was there changes', () => {
  const set = startedQuick();
  const q = (question, options, answer, more = {}) => ({ question, options, answer, ...more });
  const reply = {
    title: 'Ny tittel',
    sections: [
      // Moved to the front, and with changes it shouldn't have made: those are ignored.
      {
        name: 'Hovedsteder',
        questions: [
          q('[picture]', [], '[keep]'),
          q('Sett disse i rekkefølge, fra eldst til nyest.', ['Pyramidene i Giza', 'Colosseum', 'Eiffeltårnet', 'Operaen i Oslo'], undefined, { type: 'order' }),
          q('Hva heter Norges hovedstad?', ['Bergen', 'Oslo', 'Trondheim', 'Tromsø'], 'Oslo'),
          q('Hva heter Sveriges hovedstad?', ['Göteborg', 'Malmö', 'Stockholm', 'Uppsala'], 'Stockholm'),
          q('Hvilke av disse er hovedsteder?', ['Helsinki', 'Hamburg', 'Dublin', 'Milano'], ['Helsinki', 'Dublin'], { type: 'multi' }),
        ],
      },
      {
        name: 'Dyr',
        questions: [
          q('Endret spørsmål', ['Hund', 'Ku', 'Sau', 'Gris'], 'Gris'),
          q('Hvor mange bein har en edderkopp?', ['Seks', 'Åtte', 'Ti', 'Tolv'], 'Seks'), // the wrong "answer" is ignored: one was marked
          q('Hvilke av disse er pattedyr?', ['Hval', 'Hai', 'Flaggermus', 'Frosk'], ['Hval', 'Flaggermus'], { type: 'multi' }),
          q('Sant eller usant: Sola er en stjerne.', ['Sant', 'Usant'], 'Usant'),
          q('Hvilket dyr har snabel?', ['Elefant', 'Sjiraff', 'Neshorn', 'Flodhest'], 'Elefant'),
          q('For mange', ['a', 'b', 'c', 'd'], 'a'), // past the target: not added
        ],
      },
      {
        name: 'Fotball',
        questions: [
          q('Hvor mange spillere har et lag på banen?', ['Ni', 'Ti', 'Elleve', 'Tolv'], 'Elleve'),
          q('Sant eller usant: Et VM spilles hvert fjerde år.', ['Sant', 'Usant'], 'Sant'),
          q('Sett disse i rekkefølge, fra færrest til flest VM-titler.', ['England', 'Tyskland', 'Brasil'], undefined, { type: 'order' }),
          q('', ['x', 'y', 'z', 'w'], 'x'), // no question: not added
          q('Etter en tom', ['x', 'y', 'z', 'w'], 'x'), // after a gap: not added either
        ],
      },
    ],
  };
  const made = parseFill('Her er den:\n```json\n' + JSON.stringify(reply) + '\n```', set, { target: 5 });
  const out = made.set;
  assert.equal(out.title, 'Fredagens lynquiz');
  assert.equal(out.sections[0].seconds, 15);
  assert.deepEqual(out.sections[0].questions[0], set.sections[0].questions[0]); // untouched
  assert.deepEqual(out.sections[0].questions[1], { question: 'Hvor mange bein har en edderkopp?', options: ['Seks', 'Åtte', 'Ti', 'Tolv'], correct: 1 }); // options added, the mark kept
  assert.deepEqual(out.sections[0].questions[2].correct, [0, 2]); // the "tick all" marks, as a list
  assert.deepEqual(out.sections[0].questions[3], set.sections[0].questions[3]); // "Usant" ignored: it was marked
  assert.deepEqual(out.sections[0].questions[4], { question: 'Hvilket dyr har snabel?', options: ['Elefant', 'Sjiraff', 'Neshorn', 'Flodhest'], correct: 0 });
  assert.equal(out.sections[0].questions.length, 5); // "For mange" was past the target
  assert.deepEqual(out.sections[1].questions[0], set.sections[1].questions[0]); // the picture question is left alone
  assert.deepEqual(out.sections[1].questions[1], { question: 'Sett disse i rekkefølge, fra eldst til nyest.', type: 'order', options: ['Pyramidene i Giza', 'Colosseum', 'Eiffeltårnet', 'Operaen i Oslo'] }); // the whole order from the reply, no correct
  assert.deepEqual(out.sections[1].questions[2], { ...set.sections[1].questions[2], correct: 1 }); // the mark, points kept
  assert.equal(out.sections[1].questions[3].correct, 2);
  assert.deepEqual(out.sections[1].questions[4], { question: 'Hvilke av disse er hovedsteder?', type: 'multi', options: ['Helsinki', 'Hamburg', 'Dublin', 'Milano'], correct: [0, 2] });
  assert.equal(out.sections[1].name, 'Hovedsteder'); // found by the question they share, though the AI moved it
  assert.equal(out.sections[2].name, 'Fotball');
  assert.deepEqual(out.sections[2].questions[0], { question: 'Hvor mange spillere har et lag på banen?', options: ['Ni', 'Ti', 'Elleve', 'Tolv'], correct: 2 });
  assert.deepEqual(out.sections[2].questions[1], { question: 'Sant eller usant: Et VM spilles hvert fjerde år.', options: ['Sant', 'Usant'], correct: 0 });
  assert.deepEqual(out.sections[2].questions[2], { question: 'Sett disse i rekkefølge, fra færrest til flest VM-titler.', type: 'order', options: ['England', 'Tyskland', 'Brasil'] });
  assert.equal(out.sections[2].questions.length, 3); // the empty one stopped the adding
  assert.deepEqual(made.filled, ['0-1', '0-2', '0-4', '1-1', '1-2', '2-0', '1-3', '1-4', '2-1', '2-2']);
  assert.equal(made.added, 4);
  assert.equal(made.names, 2);
  assert.equal(made.left, 2); // section 3 still wants 2 more
  assert.deepEqual(made.duplicates, []);
  assert.deepEqual(validateSet(out).map((p) => `${p.c}-${p.i}`), ['1-0', '1-0']); // only the picture question is still unfinished
  assert.deepEqual(startedQuick(), set); // the quiz passed in is not changed
});

test('quick fill: added questions without a type get it from their wording, and the summary covers only what was touched', () => {
  const set = { v: 1, kind: 'quick', title: 'T', sections: [{ name: 'A', questions: [{ question: 'Q1?', options: ['a', 'b', 'c', 'd'], correct: 0 }] }] };
  const reply = {
    sections: [
      {
        name: 'A',
        questions: [
          { question: 'Q1?', options: ['a', 'b', 'c', 'd'], answer: 'a' },
          { question: 'Hvilke av disse er pattedyr?', options: ['Hval', 'Hai', 'Flaggermus', 'Frosk'], answer: ['Hval', 'Flaggermus'] },
          { question: 'Sorter disse fra eldst til nyest.', options: ['Pyramidene', 'Colosseum', 'Eiffeltårnet'] },
          { question: 'Hvilke av disse er hovedsteder?', options: ['Oslo', 'Bergen', 'Stockholm', 'Göteborg'], answer: 'Oslo' },
        ],
      },
    ],
  };
  const out = parseFill(JSON.stringify(reply), set, { target: 4 });
  assert.deepEqual(out.set.sections[0].questions.slice(1), [
    { question: 'Hvilke av disse er pattedyr?', type: 'multi', options: ['Hval', 'Hai', 'Flaggermus', 'Frosk'], correct: [0, 2] },
    { question: 'Sorter disse fra eldst til nyest.', type: 'order', options: ['Pyramidene', 'Colosseum', 'Eiffeltårnet'] },
    { question: 'Hvilke av disse er hovedsteder?', options: ['Oslo', 'Bergen', 'Stockholm', 'Göteborg'], correct: 0 },
  ]);
  assert.deepEqual(out.summary, { questions: 3, choice: 1, multi: 1, order: 1, any: 0, suspects: [{ c: 0, i: 3, looks: 'multi', question: 'Hvilke av disse er hovedsteder?' }] });
});

test('quick fill: options go only into the empty places, the kind never changes, and limits hold', () => {
  const set = {
    kind: 'quick',
    title: 'T',
    sections: [
      {
        name: 'A',
        questions: [
          { question: 'Gap in the middle', options: ['Red', '', 'Blue'], correct: 2 },
          { question: 'Everything marked right?', options: ['x', 'y', 'z', 'w'] },
          { question: 'Keep my kind', type: 'multi', options: ['p', 'q', 'r', 's'] },
          { question: 'Order, too few from the AI', type: 'order', options: ['b', 'c'] },
        ],
      },
    ],
  };
  const reply = {
    sections: [
      {
        name: 'A',
        questions: [
          { question: 'Gap in the middle', options: ['Red', 'blue', 'Green', 'Yellow', 'Pink'], answer: 'Red' }, // "blue" is already there: skipped
          { question: 'Everything marked right?', options: ['x', 'y', 'z', 'w'], answer: ['x', 'y', 'z', 'w'] }, // every option right on a pick-one: refused
          { question: 'Keep my kind', type: 'order', options: ['p', 'q', 'r', 's'], answer: 'q' },
          { question: 'Order, too few from the AI', type: 'order', options: ['a', 'b'] },
          ...Array.from({ length: 40 }, (_, k) => ({ question: `Extra ${k}`, options: ['1', '2', '3', '4'], answer: '2' })),
        ],
      },
    ],
  };
  const made = parseFill(JSON.stringify(reply), set, { target: 30 });
  const qs = made.set.sections[0].questions;
  assert.deepEqual(qs[0], { question: 'Gap in the middle', options: ['Red', 'Green', 'Blue', 'Yellow'], correct: 2 });
  assert.deepEqual(qs[1], set.sections[0].questions[1]); // still unmarked
  assert.deepEqual(qs[2], { question: 'Keep my kind', type: 'multi', options: ['p', 'q', 'r', 's'], correct: [1] }); // a list, as "tick all" wants
  assert.deepEqual(qs[3], { question: 'Order, too few from the AI', type: 'order', options: ['b', 'c', 'a'] }); // "a" into the empty place, no correct
  assert.equal(qs.length, 30); // never past the 30 a section may have
  assert.deepEqual(qs[29], { question: 'Extra 25', options: ['1', '2', '3', '4'], correct: 1 });
  assert.deepEqual(made.filled.slice(0, 3), ['0-0', '0-2', '0-3']);
  assert.equal(made.added, 26);
  assert.equal(made.left, 1); // "Everything marked right?" still has no right answer
  assert.ok(made.duplicates.includes('2'));
  assert.deepEqual(validateSet(made.set), [{ code: 'bad-correct', c: 0, i: 1 }]);
});

test('quick fill: a messy reply still works, and one with nothing usable is refused', () => {
  const set = { kind: 'quick', title: 'T', sections: [{ name: '', questions: [{ question: 'Who directed Jaws?', options: ['Lucas', 'Spielberg'], correct: 1 }] }] };
  const messy = 'Sure! Here it is:\n```\n{\n  “title”: “T”,\n  "sections": [ // one\n    { "name": "Films", "questions": [\n      { "question": "Who directed Jaws?", "options": ["Lucas", "Spielberg", "Scorsese", "Coppola",], "answer": "Spielberg", },\n    ], },\n  ],\n}\n```\nEnjoy!';
  const made = parseFill(messy, set);
  assert.deepEqual(made.set.sections[0], { name: 'Films', questions: [{ question: 'Who directed Jaws?', options: ['Lucas', 'Spielberg', 'Scorsese', 'Coppola'], correct: 1 }] });
  assert.equal(made.left, 0);
  // A reply that changes only what was already there, or has no sections, can't be used.
  assert.throws(() => parseFill(JSON.stringify({ sections: [{ name: '', questions: [{ question: 'Changed', options: ['Lucas', 'Spielberg'], answer: 'Lucas' }] }] }), set), { code: 'nothing-filled' });
  assert.throws(() => parseFill(JSON.stringify(quiz()), set), { code: 'not-a-quiz' });
  assert.throws(() => parseFill('', set), { code: 'empty' });
  // A board quiz pasted into a Quick quiz's fill is not a quiz for it; a full Quick quiz has nothing to fill.
  const full = { kind: 'quick', title: 'T', sections: [{ name: 'A', questions: [{ question: 'Q?', options: ['a', 'b', 'c', 'd'], correct: 0 }] }] };
  assert.equal(gapsOf(full).count, 0);
  assert.throws(() => parseFill(JSON.stringify({ sections: [{ name: 'A', questions: [{ question: 'Q?', options: ['a', 'b', 'c', 'd'], answer: 'b' }] }] }), full), { code: 'nothing-filled' });
});

// ----- translating a quiz into one of its extra languages -----

import { buildTranslateRequest, parseTranslation } from '../lib/aiquiz.js';
import { missingTranslations, getTranslation } from '../lib/languages.js';

const forTranslation = () => ({
  v: 1,
  title: 'Friday quiz',
  lang: 'en',
  languages: ['no'],
  translations: { no: { title: 'Fredagsquiz' } },
  categories: [
    {
      name: 'Capitals',
      questions: [
        { value: 100, question: 'Capital of Norway?', answer: 'Oslo', translations: { no: { question: 'Hovedstaden i Norge?' } } },
        { value: 200, question: 'Capital of Italy?', answer: 'Rome' },
      ],
    },
  ],
  final: { category: 'Rivers', question: 'Which river flows through Cairo?', answer: 'The Nile' },
});

test('translate: the request lists only the texts still missing, with their ids, and says how to translate', () => {
  const text = buildTranslateRequest(forTranslation(), 'no');
  assert.match(text, /written in English/);
  assert.match(text, /translated into Norsk/);
  const asked = JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)[1]).translations;
  assert.deepEqual(asked, [
    { id: 'c0', text: 'Capitals' },
    { id: 'a0-0', text: 'Oslo' },
    { id: 'q0-1', text: 'Capital of Italy?' },
    { id: 'a0-1', text: 'Rome' },
    { id: 'f-c', text: 'Rivers' },
    { id: 'f-q', text: 'Which river flows through Cairo?' },
    { id: 'f-a', text: 'The Nile' },
  ]);
  assert.doesNotMatch(text, /Fredagsquiz|Hovedstaden/, 'what is translated already is not sent');
  assert.match(text, /Keep every "id" exactly as it is/);
  assert.match(text, /still have the same answer/);
  assert.match(text, /start with "a" \(and "f-a"\) are answers/);
  assert.doesNotMatch(text, /answer options shown on buttons/, 'no options in a board quiz');
  // A Quick quiz: options are mentioned, the ids are the quick ones.
  const quick = { v: 1, kind: 'quick', title: 'Q', lang: 'no', languages: ['en'], sections: [{ name: 'Dyr', questions: [{ question: 'Hvilket dyr sier mø?', options: ['Hest', 'Ku'], correct: 1 }] }] };
  const qt = buildTranslateRequest(quick, 'en');
  assert.match(qt, /written in Norsk/);
  assert.match(qt, /answer options shown on buttons/);
  assert.deepEqual(JSON.parse(qt.match(/```json\n([\s\S]*?)\n```/)[1]).translations.map((x) => x.id), ['t', 's0', 'sq0-0', 'o0-0-0', 'o0-0-1']);
});

test('translate: the reply fills only the empty slots by id, never overwrites, and ignores unknown ids', () => {
  const set = forTranslation();
  const reply = `Here you go:
\`\`\`json
{ "translations": [
  { "id": "t", "text": "SKAL IKKE BRUKES" },
  { "id": "c0", "text": "Hovedsteder" },
  { "id": "a0-0", "text": "Oslo" },
  { "id": "q0-1", "text": "Hovedstaden i Italia?" },
  { "id": "a0-1", "text": "Roma" },
  { "id": "nope", "text": "x" },
  { "id": "f-q", "text": "" },
  { "id": "f-a", "text": "Nilen" }
] }
\`\`\``;
  const out = parseTranslation(reply, set, 'no');
  assert.equal(out.filled, 5);
  assert.equal(getTranslation(out.set, 't', 'no'), 'Fredagsquiz', 'the title was translated already and stays');
  assert.equal(getTranslation(out.set, 'c0', 'no'), 'Hovedsteder');
  assert.equal(getTranslation(out.set, 'a0-0', 'no'), 'Oslo', 'the same word counts as translated');
  assert.equal(getTranslation(out.set, 'a0-1', 'no'), 'Roma');
  assert.equal(getTranslation(out.set, 'f-a', 'no'), 'Nilen');
  assert.deepEqual(missingTranslations(out.set, 'no').map((x) => x.id), ['f-c', 'f-q']);
  assert.equal(out.left, 2);
  assert.equal(getTranslation(set, 'c0', 'no'), '', 'the quiz given is not changed');
  // Other shapes: a bare list, and an object of id → text; curly quotes and a trailing comma are repaired.
  const bare = parseTranslation('[{"id": "f-c", "text": "Elver"}]', set, 'no');
  assert.equal(getTranslation(bare.set, 'f-c', 'no'), 'Elver');
  const map = parseTranslation('{ “f-q”: “Hvilken elv renner gjennom Kairo?”, }', set, 'no');
  assert.equal(getTranslation(map.set, 'f-q', 'no'), 'Hvilken elv renner gjennom Kairo?');
  // Quick options by id, cut to the option length.
  const quick = { v: 1, kind: 'quick', title: 'Q', lang: 'no', languages: ['en'], sections: [{ name: 'Dyr', questions: [{ question: 'Hvilket dyr sier mø?', options: ['Hest', 'Ku'], correct: 1 }] }] };
  const q = parseTranslation('{"translations":[{"id":"o0-0-1","text":"Cow"},{"id":"sq0-0","text":"Which animal says moo?"}]}', quick, 'en');
  assert.deepEqual(q.set.sections[0].questions[0].translations.en, { question: 'Which animal says moo?', options: ['', 'Cow'] });
  // Nothing usable.
  assert.throws(() => parseTranslation('{"translations":[{"id":"t","text":"X"}]}', set, 'no'), (e) => e instanceof AiQuizError && e.code === 'nothing-filled');
  assert.throws(() => parseTranslation('', set, 'no'), (e) => e.code === 'empty');
  assert.throws(() => parseTranslation('no json here', set, 'no'), (e) => e.code === 'no-json');
  assert.throws(() => parseTranslation('{"translations": [}', set, 'no'), (e) => e.code === 'broken-json');
  assert.throws(() => parseTranslation('[1, 2]', set, 'no'), (e) => e.code === 'nothing-filled');
});
