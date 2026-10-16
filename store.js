// Question sets and their files (pictures, sound clips) on disk, plus the editor's HTTP API.
//
//   <data dir>/sets/<id>.json   the user's quizzes
//   <data dir>/files/<name>     pictures and clips, named after their content ("3fa9c0d1e2b4a6f8.jpg")
//   <data dir>/archived.json    the ids of the quizzes put away on this computer ({ v: 1, ids: [...] }); not part of any quiz
//   sets/*.json                 the built-in quizzes (read-only, id = file name: "sample", "eksempel", "quick-sample", "lynquiz"), files in sets/files/
//
// Export and import use the .proquiz.json format described in lib/fileformat.js and docs/file-format.md.

import { readFile, writeFile, readdir, mkdir, rename, unlink, stat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateSet, FILE_NAME, IMAGE_NAME } from './lib/validate.js';
import { MAX_LOGO } from './brand.js';
import { SAMPLE_ID, BUILT_IN, ID, MAX_FILE, MAX_JSON, storeError as httpError, filesOf, summary, clean, slug, header as exportHeader, packageSets } from './lib/store-core.js';

// The parts that don't touch the disk (ids, caps, `clean`, the list summary, slugs, the export shaping) are in
// lib/store-core.js, shared with the website version; they are re-exported here for the tests and the editor.
export { SAMPLE_ID, BUILT_IN, filesOf, clean };

const ROOT = new URL('./', import.meta.url);

// `version` is the running ProQuiz version (written into exports as `app`); `format` ({ upgrades, target }, for
// upgradeExport) is only given by tests.
export function createStore(dataDir, { version = null, format = {} } = {}) {
  const setsDir = path.join(dataDir, 'sets');
  const filesDir = path.join(dataDir, 'files');
  const archivedFile = path.join(dataDir, 'archived.json');
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

  // ----- archived quizzes (put away on this computer; built-in samples can be put away too) -----

  async function archivedIds() {
    try {
      const data = JSON.parse(await readFile(archivedFile, 'utf8'));
      return Array.isArray(data?.ids) ? data.ids.filter((id) => typeof id === 'string' && ID.test(id)) : [];
    } catch {
      return [];
    }
  }

  async function setArchived(id, on) {
    if (!(await get(id))) throw httpError(404, 'not-found');
    const ids = (await archivedIds()).filter((x) => x !== id);
    if (on) ids.push(id);
    await writeAtomic(archivedFile, JSON.stringify({ v: 1, ids }, null, 2));
    return Boolean(on);
  }

  async function list() {
    const archived = new Set(await archivedIds());
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
    return [...out.filter((q) => q.builtIn), ...own].map((q) => ({ ...q, archived: archived.has(q.id) }));
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
    const ids = await archivedIds();
    if (ids.includes(id)) await writeAtomic(archivedFile, JSON.stringify({ v: 1, ids: ids.filter((x) => x !== id) }, null, 2));
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

  // ----- export and import (lib/fileformat.js, docs/file-format.md) -----

  // The pictures and clips of some quizzes, as base64 by file name (a file shared by several quizzes is stored once).
  async function packFiles(sets) {
    const files = {};
    for (const set of sets) {
      for (const name of filesOf(set)) {
        if (files[name]) continue;
        const bytes = await readUserFile(name);
        if (bytes) files[name] = bytes.toString('base64');
      }
    }
    return files;
  }
  const header = () => exportHeader(version);

  // A quiz with all its pictures and clips inside one file, for sharing.
  async function exportPackage(id) {
    const found = await get(id);
    if (!found) return null;
    return { ...header(), set: found.set, files: await packFiles([found.set]) };
  }

  // Every quiz the host made (the built-in samples are left out), archived ones too, in one file.
  async function exportAll() {
    const archived = new Set(await archivedIds());
    const sets = [];
    for (const q of await list()) {
      if (q.builtIn) continue;
      const found = await get(q.id);
      if (found) sets.push({ set: found.set, ...(archived.has(q.id) && { archived: true }) });
    }
    return { ...header(), sets, files: await packFiles(sets.map((s) => s.set)) };
  }

  // Reads a .proquiz.json (one quiz, or every quiz from "Export all quizzes"), or a plain quiz without files.
  // A file from a newer ProQuiz is refused ('quiz-too-new'); an older one is brought up to date first (`packageSets`
  // in lib/store-core.js). Returns { ids } of the new quizzes (archived ones from an export-all are archived here too).
  async function importPackage(pkg) {
    const { sets, files } = packageSets(pkg, format);
    for (const [name, b64] of Object.entries(files)) {
      if (!FILE_NAME.test(name) || typeof b64 !== 'string') continue;
      const bytes = Buffer.from(b64, 'base64');
      if (bytes.length > MAX_FILE) continue;
      await mkdir(filesDir, { recursive: true });
      await writeFile(path.join(filesDir, name), bytes);
    }
    const ids = [];
    for (const { set, archived } of sets) {
      const id = await create(set);
      if (archived === true) await setArchived(id, true);
      ids.push(id);
    }
    return { ids };
  }

  return { get, list, save, create, remove, addFile, readUserFile, exportPackage, exportAll, importPackage, archivedIds, setArchived, filesDir };
}

// ----- the editor's HTTP API (only for the laptop itself) -----

export function apiHandler(store, { onSetSaved = () => {}, getLang = () => 'en', brand = null, onBrand = () => {}, pictures = null, songs = null } = {}) {
  return async function api(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', 'sets', id, sub?]
    const [, what, id, sub] = parts;
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
      // Finding free pictures on the internet (pictures.js). Only from the editor itself: a search costs the
      // laptop's share of Openverse's and Wikimedia's limits, so another website may not start one either.
      if (what === 'pictures' && pictures) {
        if (!['same-origin', 'none', undefined].includes(req.headers['sec-fetch-site'])) return json(res, 403, { error: 'forbidden' });
        if (id === 'search' && req.method === 'GET') {
          const p = url.searchParams;
          return json(res, 200, await pictures.search({ q: p.get('q'), source: p.get('source'), page: p.get('page'), license: p.get('license'), lang: p.get('lang') }));
        }
        if (id === 'fetch' && req.method === 'POST') return json(res, 201, await pictures.fetch(await readJson(req)));
      }
      // Finding song clips on Deezer (songs.js): the same rule, only from the editor itself.
      if (what === 'songs' && songs) {
        if (!['same-origin', 'none', undefined].includes(req.headers['sec-fetch-site'])) return json(res, 403, { error: 'forbidden' });
        if (id === 'search' && req.method === 'GET') {
          const p = url.searchParams;
          return json(res, 200, await songs.search({ q: p.get('q'), page: p.get('page') }));
        }
        if (id === 'fetch' && req.method === 'POST') return json(res, 201, await songs.fetch(await readJson(req)));
      }
      if (what === 'sets' && !id && req.method === 'GET') return json(res, 200, await store.list());
      if (what === 'sets' && !id && req.method === 'POST') {
        const body = await readJson(req);
        const newId = await store.create(body.set);
        return json(res, 201, { id: newId });
      }
      if (what === 'sets' && id && !sub && req.method === 'GET') {
        const found = await store.get(id);
        return found ? json(res, 200, found) : json(res, 404, { error: 'not-found' });
      }
      if (what === 'sets' && id && !sub && req.method === 'PUT') {
        const body = await readJson(req);
        const problems = await store.save(id, body.set);
        onSetSaved(id, body.set, problems);
        return json(res, 200, { problems });
      }
      if (what === 'sets' && id && !sub && req.method === 'DELETE') {
        await store.remove(id);
        return json(res, 200, { ok: true });
      }
      // Put a quiz away (or take it back): personal to this computer, so built-in samples can be put away too.
      if (what === 'sets' && id && sub === 'archived' && req.method === 'PUT') {
        const body = await readJson(req);
        return json(res, 200, { archived: await store.setArchived(id, Boolean(body.archived)) });
      }
      if (what === 'files' && req.method === 'POST') {
        const bytes = await readBody(req, MAX_FILE);
        return json(res, 201, await store.addFile(url.searchParams.get('name'), bytes));
      }
      if (what === 'export' && id && req.method === 'GET') {
        const pkg = await store.exportPackage(id);
        if (!pkg) return json(res, 404, { error: 'not-found' });
        return download(res, `${slug(pkg.set.title) || 'quiz'}.proquiz.json`, pkg);
      }
      // Every quiz the host made in one file ("Export all quizzes" in the editor).
      if (what === 'export' && !id && req.method === 'GET') {
        const pkg = await store.exportAll();
        return download(res, `proquiz-all-${pkg.exported.slice(0, 10)}.proquiz.json`, pkg);
      }
      if (what === 'import' && req.method === 'POST') {
        const pkg = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8'));
        const { ids } = await store.importPackage(pkg);
        return json(res, 201, { id: ids[0], ids, count: ids.length });
      }
      json(res, 404, { error: 'not-found' });
    } catch (err) {
      if (err.status) return json(res, err.status, { error: err.code, ...(err.retryAfter && { retryAfter: err.retryAfter }) });
      if (err instanceof SyntaxError) return json(res, 400, { error: 'not-a-quiz' });
      console.error(err);
      json(res, 500, { error: 'server' });
    }
  };
}

// ----- helpers -----

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

// A JSON file the browser saves instead of showing.
function download(res, filename, data) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` });
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
