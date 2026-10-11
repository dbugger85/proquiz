// Extra languages in a quiz (lib/languages.js): the list and its flags, reading texts with fallback, the stable ids,
// what is missing, and tidying.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {
  LANGUAGES, isLanguage, languageName, flagUrl, browserLang, mainLang, languagesOf, textOf, optionsOf, translationItems, translationSlots,
  getTranslation, setTranslation, missingTranslations, removeLanguage, cleanTranslations, cleanItemTranslations,
} from '../lib/languages.js';
import { clean } from '../store.js';

const load = (name) => JSON.parse(readFileSync(new URL(`../sets/${name}.json`, import.meta.url)));

const board = () => ({
  v: 1,
  title: 'T',
  description: 'D',
  lang: 'en',
  languages: ['no', 'th'],
  translations: { no: { title: 'Tittel' } },
  categories: [
    {
      name: 'Capitals',
      translations: { no: { name: 'Hovedsteder' } },
      questions: [
        { value: 100, question: 'Capital of Norway?', answer: 'Oslo', translations: { no: { question: 'Hovedstaden i Norge?', answer: 'Oslo' }, th: { question: 'เมืองหลวงของนอร์เวย์' } } },
        { value: 200, question: 'Capital of Italy?', answer: 'Rome', translations: { no: { question: 'Hovedstaden i Italia?' } } },
      ],
    },
  ],
  round2: { categories: [{ name: 'R2', questions: [{ value: 200, question: 'r', answer: 'ra' }] }] },
  final: { category: 'F', question: 'fq', answer: 'fa', translations: { no: { answer: 'fa-no' } } },
});
const quick = () => ({
  v: 1,
  kind: 'quick',
  title: 'Q',
  lang: 'en',
  languages: ['no'],
  sections: [
    {
      name: 'Warm-up',
      translations: { no: { name: 'Oppvarming' } },
      questions: [
        { question: 'Closest planet?', options: ['Mercury', 'Venus', 'Earth'], correct: 0, translations: { no: { question: 'Nærmest sola?', options: ['Merkur', '', 'Jorda'] } } },
        { question: 'Pick', options: ['a', 'b'], correct: 1 },
      ],
    },
  ],
});

test('the list has about 25 languages with their own names, Thai among them, and a flag file for each', () => {
  assert.ok(LANGUAGES.length >= 25);
  const codes = LANGUAGES.map((l) => l.code);
  assert.equal(new Set(codes).size, codes.length, 'no code twice');
  for (const code of ['en', 'no', 'sv', 'da', 'fi', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'pl', 'uk', 'ru', 'ar', 'tr', 'so', 'ti', 'fa', 'ur', 'zh', 'th']) assert.ok(codes.includes(code), code);
  assert.equal(languageName('th'), 'ไทย');
  assert.equal(languageName('no'), 'Norsk');
  for (const l of LANGUAGES) {
    assert.match(l.code, /^[a-z]{2}$/);
    assert.ok(l.name.trim(), `${l.code} has a name`);
    assert.ok(existsSync(new URL(`../public/flags/${l.flag}.svg`, import.meta.url)), `flag for ${l.code}`);
    assert.equal(flagUrl(l.code), `/flags/${l.flag}.svg`);
    const svg = readFileSync(new URL(`../public/flags/${l.flag}.svg`, import.meta.url), 'utf8');
    assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 60 40">/);
    assert.ok(svg.length < 2000, `${l.flag}.svg is small`);
    assert.doesNotMatch(svg, /<script|onload/i);
  }
  assert.equal(languageName('ar'), 'العربية');
  assert.equal(LANGUAGES.find((l) => l.code === 'ar').rtl, true);
  assert.equal(isLanguage('xx'), false);
  assert.equal(flagUrl('xx'), null);
  assert.equal(languageName('xx'), 'xx');
});

test('browserLang turns a browser language into one of the list', () => {
  assert.equal(browserLang('nb-NO'), 'no');
  assert.equal(browserLang('nn'), 'no');
  assert.equal(browserLang('en-GB'), 'en');
  assert.equal(browserLang('th'), 'th');
  assert.equal(browserLang('fil-PH'), 'tl');
  assert.equal(browserLang('xx-YY'), null);
  assert.equal(browserLang(undefined), null);
});

test('mainLang and languagesOf: the main language, and the added ones without the main or unknown codes', () => {
  assert.equal(mainLang({}), 'en');
  assert.equal(mainLang({ lang: 'no' }), 'no');
  assert.equal(mainLang({ lang: 'xx' }, 'no'), 'no');
  assert.deepEqual(languagesOf({ lang: 'en', languages: ['no', 'en', 'th', 'xx', 'no'] }), ['no', 'th']);
  assert.deepEqual(languagesOf({ languages: 'no' }), []);
  assert.deepEqual(languagesOf(null), []);
});

test('textOf and optionsOf fall back to the main text, field by field and option by option', () => {
  const q = board().categories[0].questions[1];
  assert.equal(textOf(q, 'no', 'question'), 'Hovedstaden i Italia?');
  assert.equal(textOf(q, 'no', 'answer'), 'Rome'); // no Norwegian answer yet
  assert.equal(textOf(q, 'th', 'question'), 'Capital of Italy?');
  assert.equal(textOf({ question: 'x', translations: { no: { question: '  ' } } }, 'no', 'question'), 'x'); // blank = missing
  assert.equal(textOf(null, 'no', 'question'), '');
  const qq = quick().sections[0].questions[0];
  assert.deepEqual(optionsOf(qq, 'no'), ['Merkur', 'Venus', 'Jorda']);
  assert.deepEqual(optionsOf(qq, 'th'), ['Mercury', 'Venus', 'Earth']);
  assert.deepEqual(optionsOf({ options: ['a'], translations: { no: { options: ['x', 'y', 'z'] } } }, 'no'), ['x']); // never more than the options
});

test('translationItems gives every text a stable id (board, round 2, final; quick sections and options)', () => {
  const ids = translationItems(board()).map((x) => x.id);
  assert.deepEqual(ids, ['t', 'd', 'c0', 'q0-0', 'a0-0', 'q0-1', 'a0-1', '2:c0', '2:q0-0', '2:a0-0', 'f-c', 'f-q', 'f-a']);
  const items = translationItems(board());
  assert.deepEqual(items[3], { id: 'q0-0', kind: 'question', text: 'Capital of Norway?', c: 0, i: 0 });
  assert.deepEqual(items[8], { id: '2:q0-0', kind: 'question', text: 'r', c: 0, i: 0, r: 2 });
  assert.deepEqual(items[10], { id: 'f-c', kind: 'category', text: 'F', final: true });
  const qids = translationItems(quick()).map((x) => x.id);
  assert.deepEqual(qids, ['t', 's0', 'sq0-0', 'o0-0-0', 'o0-0-1', 'o0-0-2', 'sq0-1', 'o0-1-0', 'o0-1-1']);
  assert.deepEqual(translationItems(quick())[4], { id: 'o0-0-1', kind: 'option', text: 'Venus', c: 0, i: 0, k: 1 });
  // Empty main texts have nothing to translate, so they aren't listed.
  const empty = board();
  empty.categories[0].questions[1].answer = '';
  empty.description = '';
  assert.ok(!translationItems(empty).some((x) => x.id === 'a0-1' || x.id === 'd'));
});

test('getTranslation, setTranslation and missingTranslations work by id, options by index', () => {
  const set = board();
  assert.equal(getTranslation(set, 'q0-0', 'no'), 'Hovedstaden i Norge?');
  assert.equal(getTranslation(set, 'a0-1', 'no'), '');
  assert.equal(getTranslation(set, 'nope', 'no'), null);
  assert.deepEqual(missingTranslations(set, 'no').map((x) => x.id), ['d', 'a0-1', '2:c0', '2:q0-0', '2:a0-0', 'f-c', 'f-q']);
  assert.equal(missingTranslations(set, 'th').length, 12);
  assert.equal(setTranslation(set, 'a0-1', 'no', ' Roma '), true);
  assert.equal(set.categories[0].questions[1].translations.no.answer, 'Roma');
  assert.equal(setTranslation(set, 'nope', 'no', 'x'), false);
  // Writing "" removes the translation (and empty objects go with it).
  setTranslation(set, 'f-a', 'no', '');
  assert.equal(set.final.translations, undefined);
  const q = quick();
  setTranslation(q, 'o0-1-1', 'no', 'bé');
  assert.deepEqual(q.sections[0].questions[1].translations.no.options, ['', 'bé']);
  setTranslation(q, 'o0-1-1', 'no', '');
  assert.equal(q.sections[0].questions[1].translations, undefined);
  assert.deepEqual(missingTranslations(q, 'no').map((x) => x.id), ['t', 'o0-0-1', 'sq0-1', 'o0-1-0', 'o0-1-1']);
  // Slots carry the object the translation lives on.
  assert.equal(translationSlots(set).find((s) => s.id === 'c0').item, set.categories[0]);
});

test('removeLanguage takes the code and every translation in it out', () => {
  const set = removeLanguage(board(), 'no');
  assert.deepEqual(set.languages, ['th']);
  assert.equal(set.translations, undefined);
  assert.equal(set.categories[0].translations, undefined);
  assert.deepEqual(set.categories[0].questions[0].translations, { th: { question: 'เมืองหลวงของนอร์เวย์' } });
  assert.equal(set.final.translations, undefined);
  removeLanguage(set, 'th');
  assert.equal(set.languages, undefined);
  assert.equal(set.categories[0].questions[0].translations, undefined);
});

test('cleanTranslations keeps only known languages and fields, trimmed, and drops empties', () => {
  const set = board();
  set.languages = ['no', 'xx', 'en', 'th'];
  set.categories[0].questions[0].translations.de = { question: 'Hauptstadt?' }; // not an added language
  set.categories[0].questions[0].translations.no.special = 'triple'; // not a text field
  set.categories[0].questions[1].translations.no.question = '  Hovedstaden i Italia?  ';
  set.categories[0].questions[1].translations.no.answer = '   ';
  set.final.translations.no.answer = '';
  const out = cleanTranslations(set);
  assert.deepEqual(out.languages, ['no', 'th']);
  assert.deepEqual(out.categories[0].questions[0].translations, { no: { question: 'Hovedstaden i Norge?', answer: 'Oslo' }, th: { question: 'เมืองหลวงของนอร์เวย์' } });
  assert.deepEqual(out.categories[0].questions[1].translations, { no: { question: 'Hovedstaden i Italia?' } });
  assert.equal(out.final.translations, undefined);
  assert.equal(set.categories[0].questions[0].translations.de.question, 'Hauptstadt?', 'the quiz given is not changed');
  // A bad main language goes; a quiz without languages comes out without any of the fields.
  assert.equal(cleanTranslations({ ...board(), lang: 'xx' }).lang, undefined);
  const plain = cleanTranslations({ v: 1, title: 'x', categories: [{ name: 'A', questions: [{ value: 100, question: 'q', answer: 'a', translations: { no: { question: 'x' } } }] }] });
  assert.equal(plain.languages, undefined);
  assert.equal(plain.categories[0].questions[0].translations, undefined);
  // Quick options: by index, trailing empties dropped, and remapped when options are dropped (keep).
  assert.deepEqual(cleanItemTranslations({ no: { question: 'x', options: ['A', ' ', 'C', ''] } }, ['no'], ['question'], { options: true }), { no: { question: 'x', options: ['A', '', 'C'] } });
  assert.deepEqual(cleanItemTranslations({ no: { options: ['A', 'B', 'C', 'D'] } }, ['no'], ['question'], { options: true, keep: [0, 2, 3] }), { no: { options: ['A', 'C', 'D'] } });
  assert.equal(cleanItemTranslations({ no: { options: ['', ''] } }, ['no'], ['question'], { options: true }), null);
  assert.equal(cleanItemTranslations(null, ['no'], ['question']), null);
});

test("store's clean() keeps the languages and translations, and a quiz without them comes out exactly as before", () => {
  const out = clean(board());
  assert.deepEqual(Object.keys(out), ['v', 'title', 'description', 'lang', 'languages', 'translations', 'categories', 'round2', 'final']);
  assert.deepEqual(out.translations, { no: { title: 'Tittel' } });
  assert.deepEqual(out.categories[0].translations, { no: { name: 'Hovedsteder' } });
  assert.deepEqual(out.final.translations, { no: { answer: 'fa-no' } });
  // A Quick quiz: an empty option is dropped, and its translation moves with the options around it.
  const q = quick();
  q.sections[0].questions[0].options = ['Mercury', '', 'Earth'];
  q.sections[0].questions[0].translations.no.options = ['Merkur', 'Venus', 'Jorda'];
  const qo = clean(q);
  assert.deepEqual(qo.sections[0].questions[0].options, ['Mercury', 'Earth']);
  assert.deepEqual(qo.sections[0].questions[0].translations.no.options, ['Merkur', 'Jorda']);
  assert.deepEqual(qo.sections[0].translations, { no: { name: 'Oppvarming' } });
  assert.deepEqual(Object.keys(qo.sections[0]), ['name', 'translations', 'questions']);
  // Without languages: no lang, languages or translations anywhere, and the same bytes as the same quiz saved before.
  const plain = { v: 1, title: 'Plain', categories: [{ name: 'A', questions: [{ value: 100, question: 'q', answer: 'a' }] }], final: { category: 'F', question: 'fq', answer: 'fa' } };
  const before = JSON.stringify(clean(plain), null, 2);
  const withStray = structuredClone(plain);
  withStray.categories[0].questions[0].translations = { no: { question: 'x' } }; // a translation without any added language
  withStray.languages = [];
  assert.equal(JSON.stringify(clean(withStray), null, 2), before);
  assert.doesNotMatch(before, /lang|translations/);
  // The samples: each has one extra language, nothing missing, and the file is what clean() would write.
  for (const [name, main, extra] of [['sample', 'en', 'no'], ['eksempel', 'no', 'en'], ['quick-sample', 'en', 'no'], ['lynquiz', 'no', 'en']]) {
    const set = load(name);
    assert.equal(mainLang(set), main, name);
    assert.deepEqual(languagesOf(set), [extra], name);
    assert.deepEqual(missingTranslations(set, extra), [], `${name} is fully translated`);
    assert.deepEqual(clean(set), set, `${name} is already tidy`);
  }
});
