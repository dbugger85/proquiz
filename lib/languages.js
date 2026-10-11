// Extra languages in a quiz: a fixed list of languages with their own names and a small flag each, and the helpers
// that read and tidy the translations stored on the quiz. Shared by the server, the pages and the tests (no DOM).
//
// Translations live on the thing they translate, as `translations: { "<code>": { … } }`:
//   the quiz          { title, description }
//   a category        { name }                       (a Quick quiz section too)
//   a board question  { question, answer }
//   a Quick question  { question, options: [...] }   (by index: options[2] translates q.options[2]; "" = missing)
//   the final         { category, question, answer }
// `set.lang` is the main language (the one the TV shows and the texts are written in), `set.languages` the codes
// of the added ones. A quiz without any of this is saved exactly as before (see clean() in store.js).
//
// Every translatable text has a stable id, so the editor's table and the AI request can refer to it:
//   t = title, d = description, c0 = category 0's name (2:c0 on round 2), q0-1 / a0-1 = question / answer of tile
//   0-1 (2:q0-1 on round 2), f-c / f-q / f-a = the final's category / question / answer, s0 = section 0's name,
//   sq0-1 = question 1 of section 0, o0-1-2 = its option 2.

// The flags are small SVGs in public/flags/<flag>.svg (not emoji: Windows browsers don't draw flag emoji).
// A language that is spoken in many countries gets one sensible flag: English → Great Britain, Spanish → Spain,
// Portuguese → Portugal, Arabic → the Arab League's green flag, Persian → Iran, Urdu → Pakistan, Tigrinya →
// Eritrea, Chinese → China, Hindi → India, Filipino → the Philippines, Somali → Somalia.
export const LANGUAGES = [
  { code: 'en', name: 'English', flag: 'gb' },
  { code: 'no', name: 'Norsk', flag: 'no' },
  { code: 'sv', name: 'Svenska', flag: 'se' },
  { code: 'da', name: 'Dansk', flag: 'dk' },
  { code: 'fi', name: 'Suomi', flag: 'fi' },
  { code: 'de', name: 'Deutsch', flag: 'de' },
  { code: 'fr', name: 'Français', flag: 'fr' },
  { code: 'es', name: 'Español', flag: 'es' },
  { code: 'it', name: 'Italiano', flag: 'it' },
  { code: 'pt', name: 'Português', flag: 'pt' },
  { code: 'nl', name: 'Nederlands', flag: 'nl' },
  { code: 'pl', name: 'Polski', flag: 'pl' },
  { code: 'lt', name: 'Lietuvių', flag: 'lt' },
  { code: 'ro', name: 'Română', flag: 'ro' },
  { code: 'uk', name: 'Українська', flag: 'ua' },
  { code: 'ru', name: 'Русский', flag: 'ru' },
  { code: 'tr', name: 'Türkçe', flag: 'tr' },
  { code: 'ar', name: 'العربية', flag: 'arab', rtl: true },
  { code: 'fa', name: 'فارسی', flag: 'ir', rtl: true },
  { code: 'ur', name: 'اردو', flag: 'pk', rtl: true },
  { code: 'so', name: 'Soomaali', flag: 'so' },
  { code: 'ti', name: 'ትግርኛ', flag: 'er' },
  { code: 'hi', name: 'हिन्दी', flag: 'in' },
  { code: 'th', name: 'ไทย', flag: 'th' },
  { code: 'vi', name: 'Tiếng Việt', flag: 'vn' },
  { code: 'tl', name: 'Filipino', flag: 'ph' },
  { code: 'zh', name: '中文', flag: 'cn' },
  { code: 'ja', name: '日本語', flag: 'jp' },
  { code: 'ko', name: '한국어', flag: 'kr' },
];

const BY_CODE = Object.fromEntries(LANGUAGES.map((l) => [l.code, l]));
export const languageOf = (code) => BY_CODE[code] ?? null;
export const isLanguage = (code) => typeof code === 'string' && code in BY_CODE;
export const languageName = (code) => BY_CODE[code]?.name ?? String(code ?? '');
export const flagUrl = (code) => (BY_CODE[code] ? `/flags/${BY_CODE[code].flag}.svg` : null);

// The quiz's main language: `set.lang` when it is one of the list, else `fallback` ('en').
export const mainLang = (set, fallback = 'en') => (isLanguage(set?.lang) ? set.lang : fallback);

// The added languages: the known codes in `set.languages`, without the main one and without repeats.
export function languagesOf(set) {
  const main = mainLang(set);
  const out = [];
  for (const code of Array.isArray(set?.languages) ? set.languages : []) if (isLanguage(code) && code !== main && !out.includes(code)) out.push(code);
  return out;
}

// A browser language ("nb-NO", "th", "en-GB") as one of the list's codes, or null.
export function browserLang(tag) {
  const primary = String(tag ?? '').trim().toLowerCase().split(/[-_]/)[0];
  if (primary === 'nb' || primary === 'nn') return 'no';
  if (primary === 'fil') return 'tl';
  return isLanguage(primary) ? primary : null;
}

const has = (x) => typeof x === 'string' && x.trim() !== '';

// One text of an item in a language: the translation when there is one, else the main text ("" when neither).
export function textOf(item, lang, field) {
  const tr = item?.translations?.[lang]?.[field];
  return has(tr) ? tr : has(item?.[field]) ? item[field] : '';
}

// A Quick question's options in a language, each falling back to the written one on its own.
export function optionsOf(q, lang) {
  const tr = q?.translations?.[lang]?.options;
  return (Array.isArray(q?.options) ? q.options : []).map((o, i) => (has(tr?.[i]) ? tr[i] : String(o ?? '')));
}

// ----- the translatable texts, each with a stable id -----

// Every text that can be translated, as { id, kind, text, item, field, index?, c?, i?, k?, r? }. `item` is the object
// the translation lives on (the quiz, a category, a question, the final), `field` its field, `index` the option's
// place. Texts that are empty in the main language are left out (nothing to translate).
export function translationSlots(set) {
  const out = [];
  const add = (id, kind, item, field, where = {}, index) => {
    const text = index === undefined ? item?.[field] : item?.[field]?.[index];
    if (has(text)) out.push({ id, kind, text: text.trim(), item, field, ...(index !== undefined && { index }), ...where });
  };
  if (!set || typeof set !== 'object') return out;
  add('t', 'title', set, 'title');
  add('d', 'description', set, 'description');
  if (set.kind === 'quick') {
    (set.sections ?? []).forEach((sec, c) => {
      add(`s${c}`, 'section', sec, 'name', { c });
      (sec?.questions ?? []).forEach((q, i) => {
        add(`sq${c}-${i}`, 'question', q, 'question', { c, i });
        (q?.options ?? []).forEach((_, k) => add(`o${c}-${i}-${k}`, 'option', q, 'options', { c, i, k }, k));
      });
    });
    return out;
  }
  for (const r of [1, 2]) {
    const cats = r === 2 ? (set.round2?.categories ?? []) : (set.categories ?? []);
    const p = r === 2 ? '2:' : '';
    const where = (x) => (r === 2 ? { ...x, r: 2 } : x);
    cats.forEach((cat, c) => {
      add(`${p}c${c}`, 'category', cat, 'name', where({ c }));
      (cat?.questions ?? []).forEach((q, i) => {
        add(`${p}q${c}-${i}`, 'question', q, 'question', where({ c, i }));
        add(`${p}a${c}-${i}`, 'answer', q, 'answer', where({ c, i }));
      });
    });
  }
  if (set.final) {
    add('f-c', 'category', set.final, 'category', { final: true });
    add('f-q', 'question', set.final, 'question', { final: true });
    add('f-a', 'answer', set.final, 'answer', { final: true });
  }
  return out;
}

// The same, without the object references (for the editor's list and the AI request): [{ id, kind, text, c?, i?, k?, r?, final? }].
export const translationItems = (set) => translationSlots(set).map(({ item, field, index, ...rest }) => rest);

// The translation of one slot in `lang` ("" when missing).
export function slotTranslation(slot, lang) {
  const tr = slot.item?.translations?.[lang];
  const v = slot.index === undefined ? tr?.[slot.field] : tr?.[slot.field]?.[slot.index];
  return has(v) ? v : '';
}

// Writes one translation (by slot) into the quiz. An empty value removes it.
export function setSlotTranslation(slot, lang, value) {
  const item = slot.item;
  const text = String(value ?? '').trim();
  item.translations ??= {};
  item.translations[lang] ??= {};
  const tr = item.translations[lang];
  if (slot.index === undefined) {
    if (text) tr[slot.field] = text;
    else delete tr[slot.field];
  } else {
    tr[slot.field] = Array.isArray(tr[slot.field]) ? tr[slot.field] : [];
    while (tr[slot.field].length <= slot.index) tr[slot.field].push('');
    tr[slot.field][slot.index] = text;
    while (tr[slot.field].length && !has(tr[slot.field].at(-1))) tr[slot.field].pop();
    if (!tr[slot.field].length) delete tr[slot.field];
  }
  if (!Object.keys(tr).length) delete item.translations[lang];
  if (!Object.keys(item.translations).length) delete item.translations;
}

// The translation of the text with this id, or "" (null for an unknown id).
export function getTranslation(set, id, lang) {
  const slot = translationSlots(set).find((s) => s.id === id);
  return slot ? slotTranslation(slot, lang) : null;
}

// Sets the translation of the text with this id. Returns false for an unknown id.
export function setTranslation(set, id, lang, value) {
  const slot = translationSlots(set).find((s) => s.id === id);
  if (!slot) return false;
  setSlotTranslation(slot, lang, value);
  return true;
}

// The texts still untranslated in `lang`: [{ id, kind, text, … }], and how many there are in all.
export function missingTranslations(set, lang) {
  return translationSlots(set)
    .filter((slot) => !slotTranslation(slot, lang))
    .map(({ item, field, index, ...rest }) => rest);
}

// Takes a language out of the quiz: its code and every translation in it.
export function removeLanguage(set, lang) {
  if (Array.isArray(set.languages)) set.languages = set.languages.filter((c) => c !== lang);
  if (!set.languages?.length) delete set.languages;
  for (const item of items(set)) {
    if (item?.translations?.[lang]) delete item.translations[lang];
    if (item?.translations && !Object.keys(item.translations).length) delete item.translations;
  }
  return set;
}

function items(set) {
  const list = [set];
  for (const c of [...(set.categories ?? []), ...(set.round2?.categories ?? []), ...(set.sections ?? [])]) list.push(c, ...(c?.questions ?? []));
  if (set.final) list.push(set.final);
  return list;
}

// ----- tidying -----

// The translations of one item, tidied: only the given languages and fields, trimmed, empties dropped. `fields`
// are the text fields; `options` (a Quick question) is a list by index and `keep` maps the old option indices to the
// kept ones (as cleanQuick() in store.js does when it drops empty options). Null when nothing is left.
export function cleanItemTranslations(translations, langs, fields, { options = false, keep = null } = {}) {
  if (!translations || typeof translations !== 'object' || Array.isArray(translations)) return null;
  const out = {};
  for (const lang of langs) {
    const tr = translations[lang];
    if (!tr || typeof tr !== 'object' || Array.isArray(tr)) continue;
    const one = {};
    for (const f of fields) if (has(tr[f])) one[f] = tr[f].trim();
    if (options && Array.isArray(tr.options)) {
      const raw = tr.options.map((o) => (typeof o === 'string' ? o.trim() : ''));
      const list = keep ? keep.map((n) => raw[n] ?? '') : raw;
      while (list.length && !list.at(-1)) list.pop();
      if (list.length) one.options = list;
    }
    if (Object.keys(one).length) out[lang] = one;
  }
  return Object.keys(out).length ? out : null;
}

const FIELDS = { set: ['title', 'description'], category: ['name'], boardQ: ['question', 'answer'], quickQ: ['question'], final: ['category', 'question', 'answer'] };

// The whole quiz's languages and translations, tidied (a new quiz; the one given is not changed): `lang` only when it
// is in the list, `languages` only known codes other than the main one, translations only in those languages.
export function cleanTranslations(set) {
  const out = structuredClone(set);
  const langs = languagesOf(out);
  if (isLanguage(out.lang)) out.lang = out.lang;
  else delete out.lang;
  if (langs.length) out.languages = langs;
  else delete out.languages;
  const tidy = (item, fields, opts) => {
    if (!item || typeof item !== 'object') return;
    const tr = cleanItemTranslations(item.translations, langs, fields, opts);
    if (tr) item.translations = tr;
    else delete item.translations;
  };
  tidy(out, FIELDS.set);
  const quick = out.kind === 'quick';
  for (const c of [...(out.categories ?? []), ...(out.round2?.categories ?? []), ...(out.sections ?? [])]) {
    tidy(c, FIELDS.category);
    for (const q of c?.questions ?? []) tidy(q, quick ? FIELDS.quickQ : FIELDS.boardQ, quick ? { options: true } : {});
  }
  if (out.final) tidy(out.final, FIELDS.final);
  return out;
}
export const TRANSLATION_FIELDS = FIELDS;
