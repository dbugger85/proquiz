// Question sets and their files (pictures, sound clips) on disk, plus the editor's HTTP API.
//
//   <data dir>/sets/<id>.json   the user's quizzes
//   <data dir>/files/<name>     pictures and clips, named after their content ("3fa9c0d1e2b4a6f8.jpg")
//   sets/*.json                 the built-in quizzes (read-only, id = file name: "sample", "eksempel", "quick-sample", "lynquiz"), files in sets/files/

import { readFile, writeFile, readdir, mkdir, rename, unlink, stat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateSet, modeOf, FILE_NAME, IMAGE_NAME, AUDIO_NAME, MAX_OPTION, rightSet } from './lib/validate.js';
import { KINDS } from './lib/crazy.js';
import { MAX_LOGO } from './brand.js';

const ROOT = new URL('./', import.meta.url);
export const SAMPLE_ID = 'sample';
export const BUILT_IN = ['sample', 'eksempel', 'quick-sample', 'lynquiz']; // English and Norwegian samples, board then Quick quiz
const ID = /^[a-z0-9-]{1,60}$/;
const MAX_FILE = 25 * 1024 * 1024; // one picture or clip
const MAX_JSON = 80 * 1024 * 1024; // an imported quiz with its files

export function createStore(dataDir) {
  const setsDir = path.join(dataDir, 'sets');
  const filesDir = path.join(dataDir, 'files');
  const setFile = (id) => path.join(setsDir, `${id}.json`);

  async function writeAtomic(file, data) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file + '.tmp', data);
    await rename(file + '.tmp', file);
  }

  const readBuiltIn = async (id) => JSON.parse(await readFile(new URL(`sets/${id}.json`, ROOT), 'utf8'));

  async function get(id) {
    if (BUILT_IN.includes(id)) return { set: await readBuiltIn(id), builtIn: true };
    if (!ID.test(id)) return null;
    try {
      return { set: JSON.parse(await readFile(setFile(id), 'utf8')), builtIn: false };
    } catch {
      return null;
    }
  }

  async function list() {
    const out = [];
    for (const id of BUILT_IN) out.push(summary(id, await readBuiltIn(id), true, 0));
    let names = [];
    try {
      names = await readdir(setsDir);
    } catch {}
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const id = n.slice(0, -5);
      if (!ID.test(id) || BUILT_IN.includes(id)) continue;
      try {
        const file = setFile(id);
        const [set, info] = await Promise.all([readFile(file, 'utf8').then(JSON.parse), stat(file)]);
        out.push(summary(id, set, false, info.mtimeMs));
      } catch {}
    }
    const own = out.filter((q) => !q.builtIn).sort((a, b) => b.updated - a.updated);
    return [...out.filter((q) => q.builtIn), ...own];

  }

  async function save(id, set) {
    if (BUILT_IN.includes(id) || !ID.test(id)) throw httpError(400, 'read-only');
    await writeAtomic(setFile(id), JSON.stringify(clean(set), null, 2));
    return validateSet(set);
  }

  async function create(set) {
    const id = `${slug(set?.title) || 'quiz'}-${randomBytes(3).toString('hex')}`;
    await save(id, set);
    return id;
  }

  async function remove(id) {
    if (BUILT_IN.includes(id) || !ID.test(id)) throw httpError(400, 'read-only');
    await unlink(setFile(id)).catch(() => {});
  }

  // A picture or clip, stored under a name made from its content (the same file twice is stored once).
  async function addFile(originalName, bytes) {
    const ext = path.extname(String(originalName || '')).toLowerCase();
    const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}${ext === '.jpeg' ? '.jpg' : ext}`;
    if (!FILE_NAME.test(name)) throw httpError(400, 'bad-file-type');
    if (bytes.length > MAX_FILE) throw httpError(413, 'file-too-big');
    await mkdir(filesDir, { recursive: true });
    await writeFile(path.join(filesDir, name), bytes);
    return { name, kind: IMAGE_NAME.test(name) ? 'image' : 'audio' };
  }

  async function readUserFile(name) {
    if (!FILE_NAME.test(name)) return null;
    for (const dir of [pathToFileURL(filesDir + path.sep), new URL('sets/files/', ROOT)]) {
      try {
        return await readFile(new URL(name, dir));
      } catch {}
    }
    return null;
  }

  // A quiz with all its pictures and clips inside one file, for sharing.
  async function exportPackage(id) {
    const found = await get(id);
    if (!found) return null;
    const files = {};
    for (const name of filesOf(found.set)) {
      const bytes = await readUserFile(name);
      if (bytes) files[name] = bytes.toString('base64');
    }
    return { proquiz: 1, set: found.set, files };
  }

  async function importPackage(pkg) {
    // A plain set (without files) can be imported too.
    const set = pkg?.proquiz === 1 ? pkg.set : pkg;
    if (!set || typeof set !== 'object' || !(Array.isArray(set.categories) || Array.isArray(set.sections))) throw httpError(400, 'not-a-quiz');
    for (const [name, b64] of Object.entries(pkg?.files ?? {})) {
      if (!FILE_NAME.test(name) || typeof b64 !== 'string') continue;
      const bytes = Buffer.from(b64, 'base64');
      if (bytes.length > MAX_FILE) continue;
      await mkdir(filesDir, { recursive: true });
      await writeFile(path.join(filesDir, name), bytes);
    }
    return create(set);
  }

  return { get, list, save, create, remove, addFile, readUserFile, exportPackage, importPackage, filesDir };
}

// ----- the editor's HTTP API (only for the laptop itself) -----

export function apiHandler(store, { onSetSaved = () => {}, getLang = () => 'en', brand = null, onBrand = () => {} } = {}) {
  return async function api(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', 'sets', id]
    const [, what, id] = parts;
    try {
      if (what === 'lang' && req.method === 'GET') return json(res, 200, { lang: getLang() });
      // Branding (brand.js): the logo, the event name and the accent colour.
      if (what === 'brand' && brand) {
        if (!id && req.method === 'GET') return json(res, 200, brand.view());
        if (!id && req.method === 'PUT') {
          await brand.update(await readJson(req));
          onBrand();
          return json(res, 200, brand.view());
        }
        if (id === 'logo' && req.method === 'POST') {
          await brand.setLogo(await readAll(req, MAX_LOGO, 'logo-too-big'));
          onBrand();
          return json(res, 201, brand.view());
        }
        if (id === 'logo' && req.method === 'DELETE') {
          await brand.removeLogo();
          onBrand();
          return json(res, 200, brand.view());
        }
      }
      if (what === 'sets' && !id && req.method === 'GET') return json(res, 200, await store.list());
      if (what === 'sets' && !id && req.method === 'POST') {
        const body = await readJson(req);
        const newId = await store.create(body.set);
        return json(res, 201, { id: newId });
      }
      if (what === 'sets' && id && req.method === 'GET') {
        const found = await store.get(id);
        return found ? json(res, 200, found) : json(res, 404, { error: 'not-found' });
      }
      if (what === 'sets' && id && req.method === 'PUT') {
        const body = await readJson(req);
        const problems = await store.save(id, body.set);
        onSetSaved(id, body.set, problems);
        return json(res, 200, { problems });
      }
      if (what === 'sets' && id && req.method === 'DELETE') {
        await store.remove(id);
        return json(res, 200, { ok: true });
      }
      if (what === 'files' && req.method === 'POST') {
        const bytes = await readBody(req, MAX_FILE);
        return json(res, 201, await store.addFile(url.searchParams.get('name'), bytes));
      }
      if (what === 'export' && id && req.method === 'GET') {
        const pkg = await store.exportPackage(id);
        if (!pkg) return json(res, 404, { error: 'not-found' });
        const filename = `${slug(pkg.set.title) || 'quiz'}.proquiz.json`;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` });
        return res.end(JSON.stringify(pkg));
      }
      if (what === 'import' && req.method === 'POST') {
        const pkg = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8'));
        return json(res, 201, { id: await store.importPackage(pkg) });
      }
      json(res, 404, { error: 'not-found' });
    } catch (err) {
      if (err.status) return json(res, err.status, { error: err.code });
      if (err instanceof SyntaxError) return json(res, 400, { error: 'not-a-quiz' });
      console.error(err);
      json(res, 500, { error: 'server' });
    }
  };
}

// ----- helpers -----

function summary(id, set, builtIn, updated) {
  const count = (cats) => (cats ?? []).reduce((n, c) => n + (c.questions?.length ?? 0), 0);
  const questions = count(set.categories) + count(set.round2?.categories) + count(set.sections);
  return { id, title: set.title || '', kind: modeOf(set), builtIn, updated, questions, problems: validateSet(set).length };
}

// Every picture and clip a set uses.
export function filesOf(set) {
  const names = new Set();
  const add = (q) => {
    for (const k of ['image', 'answerImage', 'audio']) if (q?.[k]) names.add(q[k]);
  };
  for (const c of [...(set.categories ?? []), ...(set.round2?.categories ?? []), ...(set.sections ?? [])]) for (const q of c.questions ?? []) add(q);
  add(set.final);
  return [...names];
}

// Only the fields ProQuiz knows, so a saved file stays tidy.
function clean(set) {
  if (modeOf(set) === 'quick') return cleanQuick(set);
  const q = (x = {}) => {
    const out = { value: Number(x.value) || 0, question: String(x.question ?? ''), answer: String(x.answer ?? '') };
    if (x.image) out.image = x.image;
    if (x.answerImage) out.answerImage = x.answerImage;
    if (x.audio) out.audio = x.audio;
    if (x.audio && Number(x.audioStart) > 0) out.audioStart = Number(x.audioStart);
    if (x.image && Number(x.unveil) > 0) out.unveil = Number(x.unveil);
    if (KINDS.includes(x.special)) out.special = x.special;
    return out;
  };
  const board = (cats) => (Array.isArray(cats) ? cats : []).map((c) => ({ name: String(c?.name ?? ''), questions: (c?.questions ?? []).map(q) }));
  const out = { v: 1, title: String(set?.title ?? ''), categories: board(set?.categories) };
  if (set?.round2) out.round2 = { categories: board(set.round2.categories) };
  if (set?.final) {
    const f = set.final;
    out.final = { category: String(f.category ?? ''), ...q(f) };
    delete out.final.value;
    delete out.final.special;
  }
  return out;
}

// A Quick quiz. Empty answer options are dropped (except ones marked right, so the editor still shows
// the problem), and `correct` follows its option(s): a number for one right answer, a list for several,
// left out when no option is marked right.
function cleanQuick(set) {
  const media = (x, out) => {
    if (x.image) out.image = x.image;
    if (x.audio) out.audio = x.audio;
    if (x.audio && Number(x.audioStart) > 0) out.audioStart = Number(x.audioStart);
    return out;
  };
  const seconds = (x) => (Number.isInteger(Number(x)) && Number(x) > 0 ? { seconds: Number(x) } : {});
  const q = (x = {}) => {
    const raw = (Array.isArray(x.options) ? x.options : []).map((o) => String(o ?? '').slice(0, MAX_OPTION));
    const marked = rightSet(x).filter((n) => n < raw.length); // none marked yet stays unmarked (the editor asks for it)
    const keep = raw.map((o, n) => n).filter((n) => raw[n].trim() !== '' || marked.includes(n));
    const out = { question: String(x.question ?? ''), options: keep.map((n) => raw[n]) };
    // One right answer is saved as a number (as before), several as a list.
    const right = marked.map((n) => keep.indexOf(n));
    if (right.length === 1) out.correct = right[0];
    else if (right.length > 1) out.correct = right;
    Object.assign(out, seconds(x.seconds));
    if ([0, 2000].includes(Number(x.points)) && x.points !== null && x.points !== '') out.points = Number(x.points);
    return media(x, out);
  };
  const sections = (Array.isArray(set?.sections) ? set.sections : []).map((sec) => ({
    name: String(sec?.name ?? ''),
    ...seconds(sec?.seconds),
    questions: (Array.isArray(sec?.questions) ? sec.questions : []).map(q),
  }));
  return { v: 1, kind: 'quick', title: String(set?.title ?? ''), sections };
}

function slug(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function httpError(status, code) {
  return Object.assign(new Error(code), { status, code });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(httpError(413, 'file-too-big'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Like readBody, but a body that is too big is read to the end (and thrown away) before the error, so the browser
// gets the answer instead of a broken connection.
function readAll(req, max, code) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= max) chunks.push(c);
    });
    req.on('end', () => (size > max ? reject(httpError(413, code)) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

async function readJson(req) {
  return JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}');
}
