// The .proquiz.json file format (what Export writes and Import reads), and how older files are brought up to date.
// docs/file-format.md describes the fields. store.js does the reading and writing.
//
//   { proquiz: 1,                 the file-format version (this number, FORMAT_VERSION)
//     app: '2.3.0',               the ProQuiz version that wrote the file (null when unknown)
//     exported: '2026-10-11T…Z',  when, as an ISO date
//     set: {…}, files: {…} }      one quiz and its pictures and clips (base64 by file name), or
//     sets: [{ set, archived? }], files: {…} }   every quiz at once ("Export all quizzes")
//
// Rules for the version number: adding an optional field keeps `proquiz` as it is (older ProQuiz versions just
// ignore it). Only a change that older versions could misread (a renamed or reshaped field) bumps FORMAT_VERSION,
// and then an upgrade step is added to UPGRADES so the files written before still open.

export const FORMAT_VERSION = 1;

// Upgrade steps, by the version they read: UPGRADES[n] takes a file in format n and returns it in format n + 1.
// upgradeExport() runs them one after the other until the file is at FORMAT_VERSION. None are needed yet.
//
// How to add one when FORMAT_VERSION goes from 1 to 2:
//   UPGRADES[1] = (data) => ({ ...data, proquiz: 2, set: data.set && fixSet(data.set), sets: data.sets?.map((s) => ({ ...s, set: fixSet(s.set) })) });
// (every step must handle both a single `set` and the `sets` list, and must return the next version number).
export const UPGRADES = {};

// Thrown by upgradeExport() for a file from a newer ProQuiz (code 'quiz-too-new') or one no step can read.
export class FormatError extends Error {
  constructor(code, version) {
    super(code);
    this.code = code;
    this.version = version;
  }
}

// The file-format version of an export, or null when the data isn't a ProQuiz export at all (a plain quiz, say).
export function formatVersionOf(data) {
  const v = data?.proquiz;
  return Number.isInteger(v) && v >= 1 ? v : null;
}

// Brings an export up to FORMAT_VERSION, step by step. A file that is already current comes back as it is.
// `upgrades` and `target` are only given by tests (a pretend step towards a pretend version); everyone else
// uses UPGRADES and FORMAT_VERSION.
export function upgradeExport(data, { upgrades = UPGRADES, target = FORMAT_VERSION } = {}) {
  let version = formatVersionOf(data);
  if (version === null) throw new FormatError('not-a-quiz', version);
  if (version > target) throw new FormatError('quiz-too-new', version);
  let out = data;
  while (version < target) {
    const step = upgrades[version];
    if (typeof step !== 'function') throw new FormatError('not-a-quiz', version);
    out = step(out);
    const next = formatVersionOf(out);
    if (next !== version + 1) throw new Error(`the upgrade from format ${version} must return format ${version + 1}`);
    version = next;
  }
  return out;
}
