// The parts of store.js that don't touch the disk: the built-in ids, the size caps, the tidying of a quiz before it
// is saved (`clean`), the list summary, slugs, and the shaping of a .proquiz.json export (lib/fileformat.js) on the
// way in and out. No Node modules, so the browser store of the website version can share it.

import { validateSet, modeOf, IMAGE_NAME, MAX_OPTION, MAX_DESCRIPTION, rightSet, typeOf, usedFiles, cleanCredits, UNVEIL_STYLES } from './validate.js';
import { KINDS } from './crazy.js';
import { FORMAT_VERSION, formatVersionOf, upgradeExport, FormatError } from './fileformat.js';
import { isLanguage, languagesOf, cleanItemTranslations, TRANSLATION_FIELDS } from './languages.js';

export const SAMPLE_ID = 'sample';
export const BUILT_IN = ['sample', 'eksempel', 'quick-sample', 'lynquiz']; // English and Norwegian samples, board then Quick quiz
export const ID = /^[a-z0-9-]{1,60}$/;
export const MAX_FILE = 25 * 1024 * 1024; // one picture or clip
export const MAX_JSON = 80 * 1024 * 1024; // an imported quiz with its files

// An error the editor's API answers with its status and code ({ error: code }).
export function storeError(status, code) {
  return Object.assign(new Error(code), { status, code });
}

// Every picture and clip a set uses (shared with the editor, which prunes picture credits with it).
export const filesOf = usedFiles;

// What the editor's list shows for a quiz.
export function summary(id, set, builtIn, updated) {
  const count = (cats) => (cats ?? []).reduce((n, c) => n + (c.questions?.length ?? 0), 0);
  const questions = count(set.categories) + count(set.round2?.categories) + count(set.sections);
  const firstLine = typeof set.description === 'string' ? set.description.split('\n').map((l) => l.trim()).find(Boolean) ?? '' : '';
  return {
    id,
    title: set.title || '',
    kind: modeOf(set),
    builtIn,
    updated,
    questions,
    problems: validateSet(set).length,
    description: firstLine, // the first line only, for the editor's list
    cover: typeof set.cover === 'string' && IMAGE_NAME.test(set.cover) ? set.cover : null,
  };
}

// Only the fields ProQuiz knows, so a saved file stays tidy. Picture and song credits are kept only for files still in use.
// The description and cover picture (both kinds of quiz) come right after the title, then the languages (lib/languages.js:
// `lang`, `languages` and the quiz's own `translations`, each only when there is something to save, so a quiz without
// extra languages comes out exactly as before).
export function clean(set) {
  const langs = languagesOf(set);
  const { v, kind, title, ...rest } = modeOf(set) === 'quick' ? cleanQuick(set, langs) : cleanBoard(set, langs);
  const out = { v, ...(kind && { kind }), title };
  const description = typeof set?.description === 'string' ? set.description.replace(/\r\n?/g, '\n').trim().slice(0, MAX_DESCRIPTION) : '';
  if (description) out.description = description;
  if (typeof set?.cover === 'string' && IMAGE_NAME.test(set.cover)) out.cover = set.cover;
  if (isLanguage(set?.lang)) out.lang = set.lang;
  if (langs.length) out.languages = langs;
  translationsOf(set, langs, TRANSLATION_FIELDS.set, out);
  Object.assign(out, rest);
  const credits = cleanCredits(set?.credits, filesOf(out));
  if (Object.keys(credits).length) out.credits = credits;
  return out;
}

// An item's translations into `out`, tidied (only the quiz's languages and the item's fields; nothing when empty).
function translationsOf(x, langs, fields, out, opts) {
  const tr = langs.length ? cleanItemTranslations(x?.translations, langs, fields, opts) : null;
  if (tr) out.translations = tr;
  return out;
}

// A slowly appearing picture: `unveil` (seconds) only with a picture, and `unveilStyle` only with `unveil` and only
// when it isn't the default 'pixels' (so older files come out unchanged).
function unveilOf(x, out) {
  if (x.image && Number(x.unveil) > 0) out.unveil = Number(x.unveil);
  if (out.unveil && UNVEIL_STYLES.includes(x.unveilStyle) && x.unveilStyle !== 'pixels') out.unveilStyle = x.unveilStyle;
  return out;
}

function cleanBoard(set, langs = []) {
  const q = (x = {}, final = false) => {
    const out = { value: Number(x.value) || 0, question: String(x.question ?? ''), answer: String(x.answer ?? '') };
    if (x.image) out.image = x.image;
    if (x.answerImage) out.answerImage = x.answerImage;
    if (x.audio) out.audio = x.audio;
    if (x.audio && Number(x.audioStart) > 0) out.audioStart = Number(x.audioStart);
    if (x.audio && Number(x.audioLength) > 0) out.audioLength = Number(x.audioLength);
    unveilOf(x, out);
    if (KINDS.includes(x.special)) out.special = x.special;
    return translationsOf(x, langs, final ? TRANSLATION_FIELDS.final : TRANSLATION_FIELDS.boardQ, out);
  };
  const board = (cats) =>
    (Array.isArray(cats) ? cats : []).map((c) => translationsOf(c, langs, TRANSLATION_FIELDS.category, { name: String(c?.name ?? ''), questions: (c?.questions ?? []).map((x) => q(x)) }));
  const out = { v: 1, title: String(set?.title ?? ''), categories: board(set?.categories) };
  if (set?.round2) out.round2 = { categories: board(set.round2.categories) };
  if (set?.final) {
    const f = set.final;
    out.final = { category: String(f.category ?? ''), ...q(f, true) };
    delete out.final.value;
    delete out.final.special;
  }
  return out;
}

// A Quick quiz. Empty answer options are dropped (except ones marked right, so the editor still shows
// the problem), and `correct` follows its option(s): a number for one right answer, a list for several,
// left out when no option is marked right. `type` is kept only for the new kinds ('multi', whose `correct` is
// always a list, and 'order', which has none), so older files come out exactly as they went in.
function cleanQuick(set, langs = []) {
  const media = (x, out) => {
    if (x.image) out.image = x.image;
    if (x.audio) out.audio = x.audio;
    if (x.audio && Number(x.audioStart) > 0) out.audioStart = Number(x.audioStart);
    if (x.audio && Number(x.audioLength) > 0) out.audioLength = Number(x.audioLength);
    unveilOf(x, out);
    return out;
  };
  const seconds = (x) => (Number.isInteger(Number(x)) && Number(x) > 0 ? { seconds: Number(x) } : {});
  const q = (x = {}) => {
    const type = typeOf(x);
    const raw = (Array.isArray(x.options) ? x.options : []).map((o) => String(o ?? '').slice(0, MAX_OPTION));
    const marked = type === 'order' ? [] : rightSet(x).filter((n) => n < raw.length); // none marked yet stays unmarked (the editor asks for it)
    const keep = raw.map((o, n) => n).filter((n) => raw[n].trim() !== '' || marked.includes(n));
    const out = { question: String(x.question ?? ''), ...(type !== 'choice' && { type }), options: keep.map((n) => raw[n]) };
    // One right answer is saved as a number (as before), several as a list; "tick all" always a list.
    const right = marked.map((n) => keep.indexOf(n));
    if (right.length === 1 && type !== 'multi') out.correct = right[0];
    else if (right.length > 0) out.correct = right;
    Object.assign(out, seconds(x.seconds));
    if ([0, 2000].includes(Number(x.points)) && x.points !== null && x.points !== '') out.points = Number(x.points);
    media(x, out);
    // The translated options are by index, so they follow the same `keep` as the options themselves.
    return translationsOf(x, langs, TRANSLATION_FIELDS.quickQ, out, { options: true, keep });
  };
  const sections = (Array.isArray(set?.sections) ? set.sections : []).map((sec) => ({
    ...translationsOf(sec, langs, TRANSLATION_FIELDS.category, { name: String(sec?.name ?? ''), ...seconds(sec?.seconds) }),
    questions: (Array.isArray(sec?.questions) ? sec.questions : []).map(q),
  }));
  return { v: 1, kind: 'quick', title: String(set?.title ?? ''), sections };
}

// A file name from a title ("Friday quiz!" → "friday-quiz"), for ids and export file names.
export function slug(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export const looksLikeSet = (set) => Boolean(set && typeof set === 'object' && (Array.isArray(set.categories) || Array.isArray(set.sections)));

// ----- the .proquiz.json export format (lib/fileformat.js, docs/file-format.md) -----

// The start of every export: the format version, which ProQuiz wrote it, and when.
export const header = (version) => ({ proquiz: FORMAT_VERSION, app: version, exported: new Date().toISOString() });

// The quizzes in a .proquiz.json (one quiz, or every quiz from "Export all quizzes"), or in a plain quiz without
// files: [{ set, archived? }], with the package brought up to date first. A file from a newer ProQuiz is refused
// ('quiz-too-new'), anything that isn't a quiz with 'not-a-quiz'. `format` ({ upgrades, target }) is only given by
// tests. Returns { sets, files } (`files` is the package's base64 files by name, or {}).
export function packageSets(pkg, format = {}) {
  const files = (p) => (p?.files && typeof p.files === 'object' ? p.files : {});
  if (formatVersionOf(pkg) === null) {
    if (!looksLikeSet(pkg)) throw storeError(400, 'not-a-quiz');
    return { sets: [{ set: pkg }], files: files(pkg) };
  }
  try {
    pkg = upgradeExport(pkg, format);
  } catch (err) {
    if (err instanceof FormatError) throw storeError(400, err.code);
    throw err;
  }
  const sets = Array.isArray(pkg.sets) ? pkg.sets : [{ set: pkg.set }];
  if (!sets.length || !sets.every((s) => looksLikeSet(s?.set))) throw storeError(400, 'not-a-quiz');
  return { sets, files: files(pkg) };
}
