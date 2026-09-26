// Question sets and their files (pictures, sound clips) on disk, plus the editor's HTTP API.
//
//   <data dir>/sets/<id>.json   the user's quizzes
//   <data dir>/files/<name>     pictures and clips, named after their content ("3fa9c0d1e2b4a6f8.jpg")
//   sets/sample.json            the built-in sample (read-only, id "sample"), with its files in sets/files/

import { readFile, writeFile, readdir, mkdir, rename, unlink, stat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateSet, FILE_NAME, IMAGE_NAME, AUDIO_NAME } from './lib/validate.js';

const ROOT = new URL('./', import.meta.url);
export const SAMPLE_ID = 'sample';
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

  async function readSample() {
    return JSON.parse(await readFile(new URL('sets/sample.json', ROOT), 'utf8'));
  }

  async function get(id) {
    if (id === SAMPLE_ID) return { set: await readSample(), builtIn: true };
    if (!ID.test(id)) return null;
    try {
      return { set: JSON.parse(await readFile(setFile(id), 'utf8')), builtIn: false };
    } catch {
      return null;
    }
  }

  async function list() {
    const out = [];
    const sample = await readSample();
    out.push(summary(SAMPLE_ID, sample, true, 0));
    let names = [];
    try {
      names = await readdir(setsDir);
    } catch {}
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const id = n.slice(0, -5);
      if (!ID.test(id)) continue;
      try {
        const file = setFile(id);
        const [set, info] = await Promise.all([readFile(file, 'utf8').then(JSON.parse), stat(file)]);
        out.push(summary(id, set, false, info.mtimeMs));
      } catch {}
    }
    return out.sort((a, b) => (a.builtIn ? -1 : b.builtIn ? 1 : b.updated - a.updated));
  }

  async function save(id, set) {
    if (id === SAMPLE_ID || !ID.test(id)) throw httpError(400, 'read-only');
    await writeAtomic(setFile(id), JSON.stringify(clean(set), null, 2));
    return validateSet(set);
  }

  async function create(set) {
    const id = `${slug(set?.title) || 'quiz'}-${randomBytes(3).toString('hex')}`;
    await save(id, set);
    return id;
  }

  async function remove(id) {
    if (id === SAMPLE_ID || !ID.test(id)) throw httpError(400, 'read-only');
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
    if (!set || typeof set !== 'object' || !Array.isArray(set.categories)) throw httpError(400, 'not-a-quiz');
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

export function apiHandler(store, { onSetSaved = () => {}, getLang = () => 'en' } = {}) {
  return async function api(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', 'sets', id]
    const [, what, id] = parts;
    try {
      if (what === 'lang' && req.method === 'GET') return json(res, 200, { lang: getLang() });
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
  const questions = (set.categories ?? []).reduce((n, c) => n + (c.questions?.length ?? 0), 0);
  return { id, title: set.title || '', builtIn, updated, questions, problems: validateSet(set).length };
}

// Every picture and clip a set uses.
export function filesOf(set) {
  const names = new Set();
  const add = (q) => {
    for (const k of ['image', 'answerImage', 'audio']) if (q?.[k]) names.add(q[k]);
  };
  for (const c of set.categories ?? []) for (const q of c.questions ?? []) add(q);
  add(set.final);
  return [...names];
}

// Only the fields ProQuiz knows, so a saved file stays tidy.
function clean(set) {
  const q = (x = {}) => {
    const out = { value: Number(x.value) || 0, question: String(x.question ?? ''), answer: String(x.answer ?? '') };
    if (x.image) out.image = x.image;
    if (x.answerImage) out.answerImage = x.answerImage;
    if (x.audio) out.audio = x.audio;
    if (x.audio && Number(x.audioStart) > 0) out.audioStart = Number(x.audioStart);
    return out;
  };
  const out = {
    v: 1,
    title: String(set?.title ?? ''),
    categories: (set?.categories ?? []).map((c) => ({ name: String(c?.name ?? ''), questions: (c?.questions ?? []).map(q) })),
  };
  if (set?.final) {
    const f = set.final;
    out.final = { category: String(f.category ?? ''), ...q(f) };
    delete out.final.value;
  }
  return out;
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

async function readJson(req) {
  return JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}');
}
