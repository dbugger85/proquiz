// The website version's quiz store (docs/dev/web-plan.md §2): the host's own quizzes, pictures and clips live in
// this browser's IndexedDB, nothing on the server. The same methods as store.js's createStore(), so the editor and
// the host lobby work unchanged on top of it (through `browserApi` in quizapi.js):
//
//   IndexedDB "proquiz" v1: sets  { id, set, updated }           the host's own quizzes (cleaned, like the files on disk)
//                           files { name, blob, type, size }     pictures and clips, named after their content
//                           meta  { key, value }                 archived { ids }, lastExport (ms), autosave (the game, web-plan.md §5), brand (Phase 6)
//
// The built-in quizzes come from /sets/<id>.json (static assets) and their files from /sets/files/. Export and
// import use the .proquiz.json format (lib/fileformat.js, docs/file-format.md) with the files as base64, so a file
// moves freely between the laptop and the website. Every change is announced on BroadcastChannel('proquiz-store'),
// so the host lobby (another tab) reloads its list, and the quiz on show there when it is saved in the editor.
//
// Web-only rules (the owner's decisions 4 and 5): a picture or clip is at most MAX_ROOM_FILE (8 MB) when added here,
// and a quiz's files together must fit MAX_ROOM_MEDIA (48 MB) to be played; big pictures are shrunk first
// (shrinkPicture, below). An import keeps bigger files (up to the laptop's MAX_FILE), so a file round-trips.

import { validateSet, FILE_NAME, IMAGE_NAME, usedFiles } from '/lib/validate.js';
import { BUILT_IN, ID, MAX_FILE, storeError, summary, clean, slug, header as exportHeader, packageSets } from '/lib/store-core.js';
import { MAX_ROOM_FILE, MAX_ROOM_MEDIA } from '/lib/room.js';
import { typeFor, logoKind } from '/lib/mime.js';
import { MAX_LOGO, NO_BRAND, cleanBrand, cleanLogo } from '/lib/brand-core.js';

export const DB_NAME = 'proquiz';
export const CHANNEL = 'proquiz-store';
export const BACKUP_DAYS = 30; // the backup reminder (decision 9): nothing exported for this long

const MB = 1024 * 1024;

// ----- a small promise wrapper around IndexedDB -----

const done = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

function openDb() {
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains('sets')) db.createObjectStore('sets', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'name' });
    if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
  };
  return done(req);
}

// Bytes as base64 (for exports) and back (imports), without building huge strings byte by byte.
function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
function fromBase64(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const isSafari = () => /safari/i.test(navigator.userAgent) && !/chrome|chromium|crios|android|edg/i.test(navigator.userAgent);

// `version` is the running ProQuiz version (written into exports as `app`; the website doesn't know it, so null);
// `format` ({ upgrades, target }, for upgradeExport) is only given by tests.
export function createBrowserStore({ version = null, format = {} } = {}) {
  let dbPromise = null;
  const db = () => (dbPromise ??= openDb());
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
  const announce = (msg) => channel?.postMessage(msg);

  async function run(store, mode, fn) {
    const tx = (await db()).transaction(store, mode);
    const out = await fn(tx.objectStore(store));
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return out;
  }
  const getRec = (store, key) => run(store, 'readonly', (s) => done(s.get(key)));
  const allRecs = (store) => run(store, 'readonly', (s) => done(s.getAll()));
  const putRec = (store, rec) => run(store, 'readwrite', (s) => done(s.put(rec)));
  const delRec = (store, key) => run(store, 'readwrite', (s) => done(s.delete(key)));
  const meta = async (key) => (await getRec('meta', key))?.value;
  const setMeta = (key, value) => putRec('meta', { key, value });

  // ----- the built-in quizzes (static assets) -----
  const builtIn = new Map();
  async function readBuiltIn(id) {
    if (builtIn.has(id)) return builtIn.get(id);
    const res = await fetch(`/sets/${encodeURIComponent(id)}.json`);
    if (!res.ok) throw storeError(404, 'not-found');
    const set = await res.json();
    builtIn.set(id, set);
    return set;
  }

  async function get(id) {
    if (BUILT_IN.includes(id)) return { set: await readBuiltIn(id), builtIn: true };
    if (!ID.test(id)) return null;
    const rec = await getRec('sets', id);
    return rec ? { set: rec.set, builtIn: false } : null;
  }

  // ----- archived quizzes (put away in this browser; built-in samples can be put away too) -----

  async function archivedIds() {
    const ids = (await meta('archived'))?.ids;
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && ID.test(id)) : [];
  }

  async function setArchived(id, on) {
    if (!(await get(id))) throw storeError(404, 'not-found');
    const ids = (await archivedIds()).filter((x) => x !== id);
    if (on) ids.push(id);
    await setMeta('archived', { ids });
    announce({ type: 'changed', id });
    return Boolean(on);
  }

  // The size of every file in the store, by name (a Blob from IndexedDB is a handle, its bytes aren't read here).
  async function fileSizes() {
    return new Map((await allRecs('files')).map((f) => [f.name, f.size ?? f.blob?.size ?? 0]));
  }

  // How much a quiz's pictures and clips add up to, and the biggest one (files not in this browser count as 0:
  // the built-in quizzes' files are tiny and stay on the server). `ok` says whether the quiz fits a room (§3).
  function measure(set, sizes) {
    let bytes = 0;
    let biggest = 0;
    for (const name of usedFiles(set)) {
      const size = sizes.get(name) ?? 0;
      bytes += size;
      biggest = Math.max(biggest, size);
    }
    return { bytes, biggest, ok: bytes <= MAX_ROOM_MEDIA && biggest <= MAX_ROOM_FILE, maxBytes: MAX_ROOM_MEDIA, maxFile: MAX_ROOM_FILE };
  }
  const sizeOf = async (set) => measure(set, await fileSizes());

  // The editor's list: the built-in quizzes first, then the host's own, newest first. Each entry also says how big
  // its files are (`bytes`) and whether it fits a room (`ok`), for the host's picker.
  async function list() {
    const [ids, own, sizes] = await Promise.all([archivedIds(), allRecs('sets'), fileSizes()]);
    const archived = new Set(ids);
    const out = [];
    for (const id of BUILT_IN) {
      try {
        out.push({ ...summary(id, await readBuiltIn(id), true, 0), bytes: 0, ok: true });
      } catch {
        // a built-in quiz that failed to load is left out, the list still works
      }
    }
    for (const rec of own.sort((a, b) => b.updated - a.updated)) {
      const size = measure(rec.set, sizes);
      out.push({ ...summary(rec.id, rec.set, false, rec.updated), bytes: size.bytes, ok: size.ok });
    }
    return out.map((q) => ({ ...q, archived: archived.has(q.id) }));
  }

  async function save(id, set) {
    if (BUILT_IN.includes(id) || !ID.test(id)) throw storeError(400, 'read-only');
    await putRec('sets', { id, set: clean(set), updated: Date.now() });
    announce({ type: 'saved', id });
    return validateSet(set);
  }

  async function create(set) {
    let id;
    do id = `${slug(set?.title) || 'quiz'}-${randomHex(3)}`;
    while (await getRec('sets', id));
    await save(id, set);
    return id;
  }

  // Deleting a quiz also drops the files no other quiz uses (storage in a browser is small).
  async function remove(id) {
    if (BUILT_IN.includes(id) || !ID.test(id)) throw storeError(400, 'read-only');
    const gone = await getRec('sets', id);
    await delRec('sets', id);
    const ids = await archivedIds();
    if (ids.includes(id)) await setMeta('archived', { ids: ids.filter((x) => x !== id) });
    if (gone) {
      const used = new Set((await allRecs('sets')).flatMap((rec) => usedFiles(rec.set)));
      for (const name of usedFiles(gone.set)) if (!used.has(name)) await delRec('files', name).catch(() => {});
    }
    announce({ type: 'changed', id });
  }

  // ----- files: pictures and clips, named after their content (sha256, 16 hex characters) -----

  const urls = new Map(); // name → object URL (for the editor's previews; made once per page)
  function urlFor(name, blob) {
    if (!urls.has(name)) urls.set(name, URL.createObjectURL(blob));
    return urls.get(name);
  }

  // A picture or clip (bytes, or a Blob), stored under a name made from its content (the same file twice is stored
  // once). Web rule: at most MAX_ROOM_FILE, so the quiz can be played in a room.
  async function addFile(originalName, data) {
    const blob = data instanceof Blob ? data : new Blob([data]);
    const dot = String(originalName || '').lastIndexOf('.');
    const ext = dot >= 0 ? String(originalName).slice(dot).toLowerCase() : '';
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    const name = `${hex(digest).slice(0, 16)}${ext === '.jpeg' ? '.jpg' : ext}`;
    if (!FILE_NAME.test(name)) throw storeError(400, 'bad-file-type');
    if (blob.size > MAX_ROOM_FILE) throw storeError(413, 'file-too-big');
    await keepFile(name, blob);
    return { name, kind: IMAGE_NAME.test(name) ? 'image' : 'audio' };
  }

  async function keepFile(name, blob) {
    const type = typeFor(name);
    const typed = blob.type === type ? blob : new Blob([blob], { type });
    if (!(await getRec('files', name))) await putRec('files', { name, blob: typed, type, size: typed.size });
    urlFor(name, typed);
  }

  // The file's bytes as a Blob, or null when this browser doesn't have it (the built-in files are on the server).
  async function fileBlob(name) {
    if (!FILE_NAME.test(name)) return null;
    const rec = await getRec('files', name);
    if (!rec?.blob) return null;
    urlFor(name, rec.blob);
    return rec.blob;
  }

  // Loads these files' previews, so url() can answer at once (the editor draws pictures synchronously).
  async function warm(names) {
    await Promise.all(names.filter((n) => !urls.has(n)).map((n) => fileBlob(n).catch(() => null)));
  }

  // Where a page can show this file: an object URL for a file in this browser (after warm(), get() or addFile()),
  // else the built-in quizzes' files on the server.
  const url = (name) => urls.get(name) ?? `/sets/files/${encodeURIComponent(name)}`;

  // ----- export and import (lib/fileformat.js, docs/file-format.md) -----

  async function packFiles(sets) {
    const files = {};
    for (const set of sets) {
      for (const name of usedFiles(set)) {
        if (files[name]) continue;
        const blob = (await fileBlob(name)) ?? (await builtInFile(name));
        if (blob) files[name] = await toBase64(blob);
      }
    }
    return files;
  }
  async function builtInFile(name) {
    try {
      const res = await fetch(`/sets/files/${encodeURIComponent(name)}`);
      return res.ok ? await res.blob() : null;
    } catch {
      return null;
    }
  }
  const header = () => exportHeader(version);

  // A quiz with all its pictures and clips inside one file, for sharing (or for moving to the laptop version).
  async function exportPackage(id) {
    const found = await get(id);
    if (!found) return null;
    return { ...header(), set: found.set, files: await packFiles([found.set]) };
  }

  // Every quiz the host made (the built-in samples are left out), archived ones too, in one file.
  async function exportAll() {
    const archived = new Set(await archivedIds());
    const sets = (await allRecs('sets')).sort((a, b) => b.updated - a.updated).map((rec) => ({ set: rec.set, ...(archived.has(rec.id) && { archived: true }) }));
    return { ...header(), sets, files: await packFiles(sets.map((s) => s.set)) };
  }

  // Reads a .proquiz.json (one quiz, or every quiz from "Export all quizzes"), or a plain quiz without files; an
  // older file is brought up to date first, a newer one refused ('quiz-too-new'). Returns { ids } of the new quizzes.
  async function importPackage(pkg) {
    const { sets, files } = packageSets(pkg, format);
    for (const [name, b64] of Object.entries(files)) {
      if (!FILE_NAME.test(name) || typeof b64 !== 'string') continue;
      let bytes;
      try {
        bytes = fromBase64(b64);
      } catch {
        continue;
      }
      if (bytes.length > MAX_FILE) continue;
      await keepFile(name, new Blob([bytes], { type: typeFor(name) }));
    }
    const ids = [];
    for (const { set, archived } of sets) {
      const id = await create(set);
      if (archived === true) await setArchived(id, true);
      ids.push(id);
    }
    return { ids };
  }

  // ----- keeping the storage, and the backup reminder (decision 9) -----

  let persisted = null;
  // Asks the browser to keep this site's storage (not clear it when space runs low). Safari mostly says no.
  async function persist() {
    if (persisted !== null) return persisted;
    try {
      persisted = Boolean((await navigator.storage?.persisted?.()) || (await navigator.storage?.persist?.()));
    } catch {
      persisted = false;
    }
    return persisted;
  }
  const estimate = async () => {
    try {
      return (await navigator.storage?.estimate?.()) ?? null;
    } catch {
      return null;
    }
  };
  const lastExport = async () => Number(await meta('lastExport')) || null;
  async function markExported() {
    await setMeta('lastExport', Date.now());
    announce({ type: 'exported' });
  }
  // Whether the host should be reminded to save a backup: at least one own quiz, and nothing exported for
  // BACKUP_DAYS (or ever), or the browser won't promise to keep the storage.
  async function backupStatus() {
    const [own, last, kept] = await Promise.all([allRecs('sets'), lastExport(), persist()]);
    const days = last ? Math.floor((Date.now() - last) / 86_400_000) : null;
    const due = !last || days >= BACKUP_DAYS;
    return { own: own.length, lastExport: last, days, due, persisted: kept, safari: isSafari(), remind: own.length > 0 && (due || !kept) };
  }

  // ----- the autosave (web-plan.md §5) -----
  // The room sends the game as a `save` message after every change; the host page keeps the latest one here and
  // hands it back (`restore`) when its room comes up fresh. The same shape as the laptop's autosave.json.
  const autosave = async () => (await meta('autosave')) ?? null;
  const setAutosave = (saved) => setMeta('autosave', saved);
  const clearAutosave = () => delRec('meta', 'autosave');

  // ----- the branding (web-plan.md Phase 6): this host's logo, event name and accent colour -----
  // `meta.brand` = {name, accent, plate, logo}, the logo as the name of a file in `files` (`logo-<hash>.<ext>`, named
  // and checked as brand.js does on the laptop; at most one is kept). The host page sends it to its room, the editor
  // shows it from here. Never part of an export: packFiles() only takes a quiz's own files.
  const brand = async () => {
    const saved = await meta('brand');
    return { ...cleanBrand(saved ?? {}, NO_BRAND), logo: cleanLogo(saved?.logo) };
  };
  async function setBrand(patch) {
    const next = cleanBrand(patch, await brand());
    await setMeta('brand', next);
    return next;
  }
  // The logo from its bytes (or a Blob): a real PNG, JPG, WebP or SVG at most MAX_LOGO, named after its content.
  // Returns the brand and the old logo's name (dropped here; the host page drops it from its room).
  async function setLogo(data) {
    const blob = data instanceof Blob ? data : new Blob([data]);
    if (blob.size > MAX_LOGO) throw storeError(413, 'logo-too-big');
    const buf = await blob.arrayBuffer();
    const kind = logoKind(new Uint8Array(buf));
    if (!kind) throw storeError(400, 'logo-bad-type');
    const name = `logo-${hex(await crypto.subtle.digest('SHA-256', buf)).slice(0, 16)}.${kind}`;
    const was = await brand();
    await keepFile(name, new Blob([buf]));
    const next = { ...was, logo: name };
    await setMeta('brand', next);
    const old = was.logo && was.logo !== name ? was.logo : null;
    if (old) await delRec('files', old).catch(() => {});
    return { brand: next, old };
  }
  async function removeLogo() {
    const was = await brand();
    const next = { ...was, logo: null };
    await setMeta('brand', next);
    if (was.logo) await delRec('files', was.logo).catch(() => {});
    return { brand: next, old: was.logo };
  }

  return { get, list, save, create, remove, addFile, fileBlob, warm, url, exportPackage, exportAll, importPackage, archivedIds, setArchived, persist, estimate, sizeOf, lastExport, markExported, backupStatus, autosave, setAutosave, clearAutosave, brand, setBrand, setLogo, removeLogo, MB };
}

// ----- shrinking big pictures (decision 4, website only) -----

// A JPG or PNG photo bigger than `maxSide` pixels on its longest side is drawn smaller and saved as a JPEG
// (quality 0.85), before it is hashed and stored. A PNG with see-through parts stays a PNG, so it still looks right
// on the TV. GIFs, WebP and SVGs, and pictures that are small enough already, come back untouched (so a file added
// on the laptop and on the website gets the same name). Returns a File.
export async function shrinkPicture(file, { maxSide = 1920, quality = 0.85 } = {}) {
  const isPng = file.type === 'image/png' || /\.png$/i.test(file.name);
  const isJpg = file.type === 'image/jpeg' || /\.jpe?g$/i.test(file.name);
  if (!isPng && !isJpg) return file;
  let bmp;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return file; // not a picture the browser can read: the store will say so
  }
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  if (scale === 1) {
    bmp.close();
    return file;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const keepPng = isPng && hasTransparency(ctx, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, keepPng ? 'image/png' : 'image/jpeg', quality));
  if (!blob) return file;
  const base = file.name.replace(/\.[^.]*$/, '') || 'picture';
  return new File([blob], `${base}${keepPng ? '.png' : '.jpg'}`, { type: blob.type });
}

function hasTransparency(ctx, width, height) {
  const data = ctx.getImageData(0, 0, width, height).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
}
