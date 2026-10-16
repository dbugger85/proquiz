// How the editor (and the host lobby's quiz picker) talks to the quizzes: on the laptop over the server's /api/
// (`httpApi`); on the website (docs/dev/web-plan.md §2) through the browser store in store-browser.js
// (`browserApi`), which keeps everything in this browser's IndexedDB. The same methods either way, so the editor
// doesn't know the difference. Everything that reads or changes a quiz goes through `api`, nothing else touches /api/.

import { fileUrl, HOSTED } from './env.js';
import { createBrowserStore, shrinkPicture } from './store-browser.js';
import { myRoom } from './myroom.js';
import { usedFiles } from '/lib/validate.js';
import { MAX_JSON, storeError, slug } from '/lib/store-core.js';

async function call(method, url, body, raw) {
  const r = await fetch(url, { method, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'failed'), { code: data.error });
  return data;
}

// Starts a download: of a file the server sends with "attachment" (the browser saves it instead of showing it),
// or of a Blob made here (`name` is then the file name).
function downloadFrom(href, name = '') {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
}
function downloadJson(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  downloadFrom(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 60_000); // the browser has long started reading it by then
}

export const httpApi = {
  list: () => call('GET', '/api/sets'),
  get: (id) => call('GET', `/api/sets/${id}`),
  create: (set) => call('POST', '/api/sets', { set }),
  save: (id, set) => call('PUT', `/api/sets/${id}`, { set }),
  remove: (id) => call('DELETE', `/api/sets/${id}`),
  setArchived: (id, archived) => call('PUT', `/api/sets/${id}/archived`, { archived }),
  // A picture or clip from the host's computer → { name, kind }.
  upload: (file) => call('POST', `/api/files?name=${encodeURIComponent(file.name)}`, undefined, file),
  // A .proquiz.json (one quiz or "Export all quizzes") as text → { id, ids, count }.
  importFile: (text) => call('POST', '/api/import', undefined, text),
  // Saves one quiz, or every quiz the host made (`null`), as a .proquiz.json.
  exportDownload: (id = null) => downloadFrom(id ? `/api/export/${id}` : '/api/export'),
  fileUrl,
  lang: () => call('GET', '/api/lang').then((d) => d.lang),
  brand: () => call('GET', '/api/brand'),
  // The free picture search (pictures.js) and the song search (songs.js).
  searchPictures: (params) => call('GET', `/api/pictures/search?${new URLSearchParams(params)}`),
  fetchPicture: (body) => call('POST', '/api/pictures/fetch', body),
  searchSongs: (params) => call('GET', `/api/songs/search?${new URLSearchParams(params)}`),
  fetchSong: (body) => call('POST', '/api/songs/fetch', body),
  // The website only: how big a quiz's pictures and clips are (nothing to measure on the laptop).
  sizeOf: async () => null,
};

// ----- the website: the browser store -----

// The store itself, for the host page (its files for the room, the backup reminder); null on the laptop.
export const store = HOSTED ? createBrowserStore() : null;

const notFound = () => Object.assign(new Error('not-found'), { code: 'not-found' });
const LANG_KEY = 'proquiz.lang'; // the language chosen on the front page or in the host lobby (home.js, host.js)

// The picture and song search run in this browser's room (web/room.js: `/r/<code>/api/pictures/…`, the key in a
// header), so the download of a picture isn't cut short by the Worker's CPU limit. A search answers JSON like the
// laptop; a fetch answers the bytes, with the name to store them under and the credit in headers.
async function roomCall(method, path, params, body) {
  const room = await myRoom();
  const r = await fetch(`/r/${room.code}/api/${path}${params ? `?${new URLSearchParams(params)}` : ''}`, {
    method,
    headers: { 'x-proquiz-key': room.key, ...(body && { 'Content-Type': 'application/json' }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || 'failed'), { code: data.error, retryAfter: data.retryAfter });
  }
  if (method === 'GET') return r.json();
  let credit = null;
  try {
    credit = JSON.parse(decodeURIComponent(r.headers.get('x-proquiz-credit') ?? ''));
  } catch {
    credit = null;
  }
  const name = r.headers.get('x-proquiz-name') ?? '';
  return { file: new File([await r.blob()], name, { type: r.headers.get('Content-Type') ?? '' }), credit };
}
// Stored like an upload (a big picture shrunk first), under its content's name. The store's own "too big" (over
// the website's 8 MB) is told apart from the search's 15 MB cap.
async function keepFound({ file, credit }, shrink) {
  try {
    const small = shrink ? await shrinkPicture(file) : file;
    return { ...(await store.addFile(small.name, small)), credit };
  } catch (err) {
    if (err?.code === 'file-too-big') throw Object.assign(new Error('too-big-for-web'), { code: 'too-big-for-web' });
    throw err;
  }
}

export const browserApi = store && {
  list: async () => {
    const quizzes = await store.list();
    await store.warm(quizzes.map((q) => q.cover).filter(Boolean)); // the list shows the covers
    return quizzes;
  },
  get: async (id) => {
    const found = await store.get(id);
    if (!found) throw notFound();
    await store.warm(usedFiles(found.set)); // previews can then be drawn at once
    return found;
  },
  create: async (set) => ({ id: await store.create(set) }),
  save: async (id, set) => ({ problems: await store.save(id, set) }),
  remove: async (id) => {
    await store.remove(id);
    return { ok: true };
  },
  setArchived: async (id, archived) => ({ archived: await store.setArchived(id, archived) }),
  // A big photo is shrunk first (decision 4), then stored under its content's name.
  upload: async (file) => {
    const small = await shrinkPicture(file);
    return store.addFile(small.name, small);
  },
  importFile: async (text) => {
    if (text.length > MAX_JSON) throw storeError(413, 'file-too-big');
    let pkg;
    try {
      pkg = JSON.parse(text);
    } catch {
      throw storeError(400, 'not-a-quiz');
    }
    const { ids } = await store.importPackage(pkg);
    return { id: ids[0], ids, count: ids.length };
  },
  // The same file names as the laptop's downloads; every export counts as a backup (the reminder, decision 9).
  exportDownload: async (id = null) => {
    if (id) {
      const pkg = await store.exportPackage(id);
      if (!pkg) throw notFound();
      downloadJson(`${slug(pkg.set.title) || 'quiz'}.proquiz.json`, pkg);
    } else {
      const pkg = await store.exportAll();
      downloadJson(`proquiz-all-${pkg.exported.slice(0, 10)}.proquiz.json`, pkg);
    }
    await store.markExported();
  },
  fileUrl: (name) => store.url(name),
  lang: async () => {
    try {
      const saved = localStorage.getItem(LANG_KEY);
      if (saved === 'no' || saved === 'en') return saved;
    } catch {
      // no storage
    }
    return /^n[bno]\b/i.test(navigator.language ?? '') ? 'no' : 'en';
  },
  // The host's branding from this browser (store-browser.js), the logo as an object URL, for the editor's header.
  brand: async () => {
    const b = await store.brand();
    return { ...b, logo: b.logo && (await store.fileBlob(b.logo)) ? store.url(b.logo) : null };
  },
  // The free picture search and the song search, through this browser's room; the found bytes stored here.
  searchPictures: (params) => roomCall('GET', 'pictures/search', params),
  fetchPicture: async (body) => keepFound(await roomCall('POST', 'pictures/fetch', null, { ...body, lang: await browserApi.lang() }), true),
  searchSongs: (params) => roomCall('GET', 'songs/search', params),
  fetchSong: async (body) => keepFound(await roomCall('POST', 'songs/fetch', null, body), false),
  sizeOf: (set) => store.sizeOf(set),
};

export const api = HOSTED ? browserApi : httpApi;
